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
   * Latest stored rate (INR/g) for a metal. A store-specific override wins over a
   * global (storeId null) rate; returns null if nothing is on record yet.
   */
  async getLatestRate(metal: MetalKind, storeId?: string): Promise<number | null> {
    const scoped = storeId && storeId !== 'all' ? storeId : undefined;
    const row = await this.prisma.metalRate.findFirst({
      where: { metal, ...(scoped ? { OR: [{ storeId: scoped }, { storeId: null }] } : {}) },
      // store-specific first (nulls last), then most recent.
      orderBy: [{ storeId: 'desc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return row ? Number(row.ratePerGram) : null;
  }

  /** Current rate for every metal that has one on record (latest per metal). */
  async currentRates(storeId?: string): Promise<Array<{ metal: MetalKind; ratePerGram: number }>> {
    const metals = Object.values(MetalKind);
    const rates = await Promise.all(
      metals.map(async (metal) => ({
        metal,
        ratePerGram: await this.getLatestRate(metal, storeId),
      })),
    );
    return rates.filter(
      (r): r is { metal: MetalKind; ratePerGram: number } => r.ratePerGram != null,
    );
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
