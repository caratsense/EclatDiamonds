import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetalKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fetchJson } from './integrations.util';

const TROY_OUNCE_GRAMS = 31.1035;

/** Purity multipliers vs fine (24k) gold — used to derive each stored rate. */
const GOLD_PURITY: Array<[MetalKind, number]> = [
  ['gold_24k', 1],
  ['gold_22k', 22 / 24],
  ['gold_18k', 18 / 24],
  ['rose_gold_18k', 18 / 24],
];

/**
 * Gold / metal rate feed (Module 2 pricing). Pulls the fine-gold spot price from
 * GOLD_RATE_API_URL and upserts a MetalRate row per derived purity. When no feed
 * is configured it's a no-op and pricing falls back to the last stored MetalRate
 * (which is also what the legacy backfill/sync populates) — so quotes keep
 * working with or without a live feed (OP-2 source-of-truth still open).
 */
@Injectable()
export class GoldRateService {
  private readonly logger = new Logger(GoldRateService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get feedUrl(): string {
    return this.config.get<string>('GOLD_RATE_API_URL') ?? '';
  }
  private get apiKey(): string {
    return this.config.get<string>('GOLD_RATE_API_KEY') ?? '';
  }

  /** True when a rate feed URL is configured (otherwise refresh is a no-op). */
  get enabled(): boolean {
    return Boolean(this.feedUrl);
  }

  /**
   * A rate older than this is reported as stale. Gold moves daily; quoting off a
   * price from last week is how a jeweller sells below cost without noticing.
   */
  private get staleAfterHours(): number {
    const raw = Number(this.config.get<string>('GOLD_RATE_STALE_HOURS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 24;
  }

  /** Latest stored row for a metal — store-specific override wins over global. */
  private async latestRow(metal: MetalKind, storeId?: string) {
    const scoped = storeId && storeId !== 'all' ? storeId : undefined;
    return this.prisma.metalRate.findFirst({
      where: { metal, ...(scoped ? { OR: [{ storeId: scoped }, { storeId: null }] } : {}) },
      // store-specific first (nulls last), then most recent.
      orderBy: [{ storeId: 'desc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /**
   * Latest stored rate (INR/g) for a metal. A store-specific override wins over a
   * global (storeId null) rate; returns null if nothing is on record yet.
   */
  async getLatestRate(metal: MetalKind, storeId?: string): Promise<number | null> {
    const row = await this.latestRow(metal, storeId);
    return row ? Number(row.ratePerGram) : null;
  }

  /**
   * Current rate for every metal that has one on record, WITH its age.
   *
   * The age is not decoration. With no feed configured the service silently falls
   * back to the last stored rate, so a quote built here can be priced off a
   * week-old number and look exactly like a fresh one. `stale` gives the UI
   * something to warn on instead of the staff having to remember to check.
   */
  async currentRates(storeId?: string): Promise<
    Array<{
      metal: MetalKind;
      ratePerGram: number;
      effectiveFrom: string;
      ageHours: number;
      stale: boolean;
    }>
  > {
    const metals = Object.values(MetalKind);
    const now = Date.now();
    const rows = await Promise.all(
      metals.map(async (metal) => ({ metal, row: await this.latestRow(metal, storeId) })),
    );
    return rows
      .filter((r) => r.row != null)
      .map(({ metal, row }) => {
        const effectiveFrom = row!.effectiveFrom ?? row!.createdAt;
        const ageHours = Math.max(0, (now - effectiveFrom.getTime()) / 3_600_000);
        return {
          metal,
          ratePerGram: Number(row!.ratePerGram),
          effectiveFrom: effectiveFrom.toISOString(),
          ageHours: Math.round(ageHours * 10) / 10,
          stale: ageHours > this.staleAfterHours,
        };
      });
  }

  /**
   * Pull the fine-gold (24k) price from the configured feed and write a fresh
   * MetalRate row for each gold purity. No-op when no feed is set.
   */
  async refresh(): Promise<{ updated: boolean; dryRun: boolean; rates?: Record<string, number> }> {
    if (!this.enabled) {
      this.logger.log('[dry-run] gold-rate feed not configured — keeping last stored rates.');
      return { updated: false, dryRun: true };
    }

    const fineInrPerGram = await this.fetchFineGoldInrPerGram();
    if (fineInrPerGram == null || fineInrPerGram <= 0) {
      this.logger.warn('Gold-rate feed returned no usable price.');
      return { updated: false, dryRun: false };
    }

    const effectiveFrom = new Date();
    const written: Record<string, number> = {};
    for (const [metal, mult] of GOLD_PURITY) {
      const ratePerGram = round2(fineInrPerGram * mult);
      await this.prisma.metalRate.create({ data: { metal, ratePerGram, effectiveFrom } });
      written[metal] = ratePerGram;
    }
    this.logger.log(`Gold rates refreshed: 24k = ₹${written.gold_24k}/g`);
    return { updated: true, dryRun: false, rates: written };
  }

  /**
   * Normalise a feed response to INR per gram of fine gold. Handles the common
   * shapes so swapping providers is a config change, not a code change:
   *   A) generic    → { inr_per_gram }
   *   B) goldapi.io → { price_gram_24k }  (per-gram, in requested currency)
   *   C) metals.dev → { metals: { gold } } / { price }  (per troy ounce)
   */
  private async fetchFineGoldInrPerGram(): Promise<number | null> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['x-access-token'] = this.apiKey; // goldapi.io style auth
    const data = await fetchJson(this.feedUrl, { headers });

    if (typeof data?.inr_per_gram === 'number') return round2(data.inr_per_gram);
    if (typeof data?.price_gram_24k === 'number') return round2(data.price_gram_24k);

    const perOunce = data?.metals?.gold ?? data?.price ?? data?.gold;
    if (typeof perOunce === 'number' && perOunce > 0) return round2(perOunce / TROY_OUNCE_GRAMS);

    this.logger.warn(
      `Unrecognised gold-rate feed shape: ${JSON.stringify(data).slice(0, 200)}`,
    );
    return null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
