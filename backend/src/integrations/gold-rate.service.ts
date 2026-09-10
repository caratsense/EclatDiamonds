import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetalKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fetchJson } from './integrations.util';

const TROY_OUNCE_GRAMS = 31.1035;

/**
 * Built-in keyless source, used when GOLD_RATE_API_URL is not set: CoinGecko's
 * PAX Gold price in INR. PAXG is a token redeemable 1:1 for one fine troy ounce
 * of London Good Delivery gold, so it tracks spot closely; CoinGecko serves it
 * with no API key and returns INR directly, so gold auto-updates out of the box
 * with zero configuration. `{ "pax-gold": { "inr": <per fine troy ounce> } }`.
 */
const DEFAULT_FEED_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=inr';

/** Sent on every feed request — CoinGecko (and good manners) reject a UA-less call. */
const FEED_USER_AGENT = 'Eclat-CaratSense/1.0 (+gold-rate)';

/** Purity multipliers vs fine (24k) gold — used to derive each stored rate. */
const GOLD_PURITY: Array<[MetalKind, number]> = [
  ['gold_24k', 1],
  ['gold_22k', 22 / 24],
  ['gold_18k', 18 / 24],
  ['rose_gold_18k', 18 / 24],
];

/**
 * Gold / metal rate feed (Module 2 pricing). Pulls the fine-gold spot price and
 * upserts a MetalRate row per derived purity, lifted to the local retail rate by
 * GOLD_RATE_PREMIUM_PCT. It runs against a built-in keyless source by default
 * (CoinGecko PAX Gold, INR) so the rate auto-updates with no setup; point
 * GOLD_RATE_API_URL (+ optional GOLD_RATE_API_KEY) at a dedicated provider to
 * override it. Either way quotes fall back to the last stored MetalRate if a pull
 * fails, so pricing never hard-stops.
 */
@Injectable()
export class GoldRateService {
  private readonly logger = new Logger(GoldRateService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Configured provider, or the built-in keyless CoinGecko source by default. */
  private get feedUrl(): string {
    return this.config.get<string>('GOLD_RATE_API_URL')?.trim() || DEFAULT_FEED_URL;
  }
  private get apiKey(): string {
    return this.config.get<string>('GOLD_RATE_API_KEY') ?? '';
  }

  /**
   * Retailer premium over international spot, as a percent. The feed returns the
   * INR spot price, but Indian physical gold trades higher once import duty (~6%)
   * + GST (3%) + the local sarafa premium are on it — so quoting raw spot
   * underprices by ~10-14%. Defaults to 12 so the out-of-the-box auto rate lands
   * near the real quote; the shop should compare it to today's actual 22K rate
   * once and set GOLD_RATE_PREMIUM_PCT to fine-tune. (A manual override on the
   * Rates screen always wins until the next pull.)
   */
  private get premiumPct(): number {
    const raw = Number(this.config.get<string>('GOLD_RATE_PREMIUM_PCT'));
    return Number.isFinite(raw) && raw >= 0 ? raw : 12;
  }

  /**
   * Always true now — a feed URL is always resolvable (a configured provider, or
   * the built-in keyless CoinGecko default). Kept as a flag so callers/tests can
   * still gate on it and a future "disable entirely" switch has a home.
   */
  get enabled(): boolean {
    return Boolean(this.feedUrl);
  }

  /**
   * A rate older than this is reported as stale. Gold moves daily; quoting off a
   * price from last week is how a jeweller sells below cost without noticing.
   */
  private get staleAfterHours(): number {
    const raw = Number(this.config.get<string>('GOLD_RATE_STALE_HOURS'));
    if (Number.isFinite(raw) && raw > 0) return raw;
    // Default: tie staleness to the refresh cadence, so a MISSED refresh (a feed
    // outage that outlasts a full cycle) surfaces as stale instead of quoting off
    // an aging rate. Flags at 1.5× the refresh interval (18h for the 12h default);
    // set GOLD_RATE_STALE_HOURS to override.
    const refresh = Number(this.config.get<string>('GOLD_RATE_REFRESH_HOURS'));
    const refreshHours = Number.isFinite(refresh) && refresh > 0 ? refresh : 12;
    return refreshHours * 1.5;
  }

  /**
   * Latest stored row for a metal — store-specific override wins over global.
   * Always organisation-scoped: rates are per-tenant config, so one org can never
   * read another's stored rate. `organisationId` comes from the authenticated user.
   */
  private async latestRow(metal: MetalKind, organisationId: string, storeId?: string) {
    const scoped = storeId && storeId !== 'all' ? storeId : undefined;
    return this.prisma.metalRate.findFirst({
      where: { metal, organisationId, ...(scoped ? { OR: [{ storeId: scoped }, { storeId: null }] } : {}) },
      // store-specific first (nulls last), then most recent.
      orderBy: [{ storeId: 'desc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /**
   * Latest stored rate (INR/g) for a metal. A store-specific override wins over a
   * global (storeId null) rate; returns null if nothing is on record yet.
   */
  async getLatestRate(
    metal: MetalKind,
    organisationId: string,
    storeId?: string,
  ): Promise<number | null> {
    const row = await this.latestRow(metal, organisationId, storeId);
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
  async currentRates(organisationId: string, storeId?: string): Promise<
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
      metals.map(async (metal) => ({ metal, row: await this.latestRow(metal, organisationId, storeId) })),
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
  async refresh(
    organisationId: string,
  ): Promise<{ updated: boolean; dryRun: boolean; rates?: Record<string, number> }> {
    if (!this.enabled) {
      this.logger.log('[dry-run] gold-rate feed not configured — keeping last stored rates.');
      return { updated: false, dryRun: true };
    }

    const spotInrPerGram = await this.fetchFineGoldInrPerGram();
    if (spotInrPerGram == null || spotInrPerGram <= 0) {
      this.logger.warn('Gold-rate feed returned no usable price.');
      return { updated: false, dryRun: false };
    }

    // Lift raw spot to the local retail rate (import duty + GST + premium).
    const fineInrPerGram = round2(spotInrPerGram * (1 + this.premiumPct / 100));
    const written = await this.writePurities(fineInrPerGram, new Date(), organisationId);
    this.logger.log(
      `Gold rates refreshed: 24k = ₹${written.gold_24k}/g (spot ₹${spotInrPerGram} +${this.premiumPct}%)`,
    );
    return { updated: true, dryRun: false, rates: written };
  }

  /** Age in hours of the freshest gold (24k) rate on record; Infinity if none. */
  private async goldRateAgeHours(organisationId: string): Promise<number> {
    const row = await this.latestRow(MetalKind.gold_24k, organisationId);
    if (!row) return Infinity;
    const eff = row.effectiveFrom ?? row.createdAt;
    return (Date.now() - eff.getTime()) / 3_600_000;
  }

  /**
   * Refresh only when the stored gold rate is older than `maxAgeHours` (or absent).
   * The scheduler calls this hourly: a fresh rate is left untouched (no feed hit),
   * a stale/missing one is re-pulled. So a failed pull (feed timeout / 429) is
   * retried the very next hour instead of leaving the price stale for the whole
   * refresh window — refresh() returns { updated:false } on failure without
   * throwing, so the stored rate simply stays old and the next tick tries again.
   */
  async refreshIfStale(
    maxAgeHours: number,
    organisationId: string,
  ): Promise<{ updated: boolean; dryRun: boolean; skipped?: boolean; rates?: Record<string, number> }> {
    if (!this.enabled) return { updated: false, dryRun: true };
    const age = await this.goldRateAgeHours(organisationId);
    if (age < maxAgeHours) return { updated: false, dryRun: false, skipped: true };
    return this.refresh(organisationId);
  }

  /**
   * Manually set today's gold rate (POST /integrations/gold-rate, managers+).
   *
   * The reliable path for an Indian retailer: an international-spot feed does NOT
   * match the local IBJA / sarafa-association rate a jeweller actually quotes
   * (import duty, GST and local premium sit on top), so the morning rate is
   * entered by hand. The manager enters one karat's rate and the other purities
   * are derived from it, so 24k / 22k / 18k always stay consistent — and every
   * quote built today prefills off this number.
   */
  async setManual(
    input: {
      ratePerGram: number;
      karat: 22 | 24;
    },
    organisationId: string,
  ): Promise<{ rates: Record<string, number> }> {
    const mult = input.karat === 24 ? 1 : 22 / 24;
    const fine = round2(input.ratePerGram / mult);
    if (!Number.isFinite(fine) || fine <= 0) {
      throw new BadRequestException('Enter a valid gold rate');
    }
    const rates = await this.writePurities(fine, new Date(), organisationId);
    this.logger.log(
      `Gold rate set manually: ${input.karat}k = ₹${input.ratePerGram}/g (24k ₹${rates.gold_24k})`,
    );
    return { rates };
  }

  /** Write one MetalRate row per gold purity, derived from the fine-gold price. */
  private async writePurities(
    fineInrPerGram: number,
    effectiveFrom: Date,
    organisationId: string,
  ): Promise<Record<string, number>> {
    const written: Record<string, number> = {};
    for (const [metal, mult] of GOLD_PURITY) {
      const ratePerGram = round2(fineInrPerGram * mult);
      await this.prisma.metalRate.create({
        data: { metal, ratePerGram, effectiveFrom, organisationId },
      });
      written[metal] = ratePerGram;
    }
    return written;
  }

  /**
   * Normalise a feed response to INR per gram of fine gold. Handles the common
   * shapes so swapping providers is a config change, not a code change:
   *   A) CoinGecko  → { "pax-gold": { inr } }       (built-in default; per troy ounce)
   *   B) generic    → { inr_per_gram }
   *   C) goldapi.io → { price_gram_24k }            (per-gram, in requested currency)
   *   D) metals.dev → { metals: { gold } } / { price } (per troy ounce)
   *
   * A network/HTTP failure returns null (logged) rather than throwing, so a
   * transient outage just skips this refresh and pricing keeps the last rate.
   */
  private async fetchFineGoldInrPerGram(): Promise<number | null> {
    const headers: Record<string, string> = { 'User-Agent': FEED_USER_AGENT };
    if (this.apiKey) headers['x-access-token'] = this.apiKey; // goldapi.io style auth

    let data: any;
    try {
      data = await fetchJson(this.feedUrl, { headers });
    } catch (err) {
      this.logger.warn(`Gold-rate fetch failed: ${(err as Error)?.message ?? err}`);
      return null;
    }

    const fine = fineGoldInrPerGramFromFeed(data);
    if (fine == null) {
      this.logger.warn(
        `Unrecognised gold-rate feed shape: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return fine;
  }
}

/**
 * Pure feed-shape → INR per gram of fine (24k) gold. Split out from the network
 * call so the money-sensitive branch/conversion logic is unit-testable. Returns
 * null for an unrecognised shape (the caller logs it). Handles, in order:
 *   CoinGecko `{ "pax-gold": { inr } }` (per troy ounce) · generic `{ inr_per_gram }`
 *   · goldapi.io `{ price_gram_24k }` · metals.dev `{ metals: { gold } }` / `{ price }`.
 */
export function fineGoldInrPerGramFromFeed(data: any): number | null {
  const paxg = data?.['pax-gold']?.inr;
  if (typeof paxg === 'number' && paxg > 0) return round2(paxg / TROY_OUNCE_GRAMS);

  if (typeof data?.inr_per_gram === 'number') return round2(data.inr_per_gram);
  if (typeof data?.price_gram_24k === 'number') return round2(data.price_gram_24k);

  const perOunce = data?.metals?.gold ?? data?.price ?? data?.gold;
  if (typeof perOunce === 'number' && perOunce > 0) return round2(perOunce / TROY_OUNCE_GRAMS);

  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
