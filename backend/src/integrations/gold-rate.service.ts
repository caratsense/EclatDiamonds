import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetalKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_TZ, businessDate, dateOnly } from '../common/tz.util';
import { fetchJson } from './integrations.util';
import { IBJA_URL, parseIbja } from './ibja-rates';

const TROY_OUNCE_GRAMS = 31.1035;

/**
 * The scheduled refresh's name in the run ledger.
 *
 * Named here rather than typed as a literal in both places: the scheduler writes
 * the row and this service reads it back to report whether the automatic pull is
 * alive. A typo in either string would make the screen say "never run" about a
 * job that runs hourly.
 */
export const GOLD_RATE_JOB = 'pricing.gold-rate-refresh';

/**
 * Whether a run's stored detail says it wrote new prices.
 *
 * `ScheduledJobRun.detail` is a string holding JSON. Null on anything we cannot
 * read — an older row, a different shape, a truncated write. "We do not know"
 * and "it found nothing newer" are different statements and the screen says
 * different things about them.
 */
function readUpdatedFlag(detail: string | null): boolean | null {
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const updated = (parsed as Record<string, unknown>).updated;
    return typeof updated === 'boolean' ? updated : null;
  } catch {
    return null;
  }
}

/** Sent on every feed request — providers (and good manners) reject a UA-less call. */
const FEED_USER_AGENT = 'Eclat-CaratSense/1.0 (+gold-rate)';

/** Purity multipliers vs fine (24k) gold — used to derive each stored rate. */
const GOLD_PURITY: Array<[MetalKind, number]> = [
  ['gold_24k', 1],
  ['gold_22k', 22 / 24],
  ['gold_18k', 18 / 24],
  ['rose_gold_18k', 18 / 24],
];

/**
 * Gold / metal rate feed (Module 2 pricing). By default it reads IBJA — the
 * India Bullion and Jewellers Association benchmark on ibjarates.com, the rate
 * Indian jewellers quote from: per gram, ex-GST, 999/916/750/585 gold and
 * silver, with its publication date. No premium is added (it is already the
 * local rate). Point GOLD_RATE_API_URL (+ optional GOLD_RATE_API_KEY) at a spot
 * provider to use that instead, lifted by GOLD_RATE_PREMIUM_PCT. Either way
 * quotes fall back to the last stored MetalRate if a pull fails, so pricing
 * never hard-stops — and a page that cannot be read stores nothing.
 */
@Injectable()
export class GoldRateService {
  private readonly logger = new Logger(GoldRateService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** A configured spot provider; empty means the IBJA default. */
  private get spotFeedUrl(): string {
    return this.config.get<string>('GOLD_RATE_API_URL')?.trim() ?? '';
  }
  /** Where rates come from, as shown to staff. */
  private get feedUrl(): string {
    return this.spotFeedUrl || IBJA_URL;
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
   * the IBJA default). Kept as a flag so callers/tests can
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
   * Is the AUTOMATIC refresh actually running?
   *
   * The rates screen could say how old a price was and nothing about why. Those
   * are different failures with the same appearance: a feed that returned
   * nothing this morning looks exactly like a scheduler that has not run since
   * the last deploy, and only one of them is fixed by pressing "Pull from feed".
   *
   * A stale rate with a healthy refresh means the market has not moved or the
   * source is quiet. A stale rate with no run in days means nothing is pulling
   * at all — an environment problem no amount of pressing buttons will fix, and
   * one that is otherwise invisible until somebody quotes off a week-old price.
   *
   * Read from the run ledger the scheduler already writes, so this reports what
   * happened rather than asking the feed again.
   */
  async refreshHealth(organisationId: string) {
    const last = await this.prisma.scheduledJobRun.findFirst({
      where: { organisationId, job: GOLD_RATE_JOB },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, status: true, detail: true },
    });

    const expectedEveryHours = this.staleAfterHours;
    const ageHours = last ? (Date.now() - last.startedAt.getTime()) / 3_600_000 : null;

    return {
      /** Null when the job has never run for this tenant — a real answer, not zero. */
      lastRunAt: last?.startedAt?.toISOString() ?? null,
      lastRunStatus: last?.status ?? null,
      /**
       * Did the most recent run actually write new prices, or find nothing to do?
       *
       * `detail` is a STRING column holding the run's JSON, so it is parsed
       * rather than read as an object. Null when it cannot be read: an
       * unparseable detail means we do not know, and guessing `false` would
       * report "the source had nothing newer" about a run we cannot see.
       */
      lastRunUpdated: readUpdatedFlag(last?.detail ?? null),
      ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
      /**
       * The automatic pull is not keeping up. True when it has never run, or has
       * not run within the window a rate is allowed to age — the same threshold
       * that marks a rate stale, so the two readings cannot disagree.
       */
      overdue: ageHours == null || ageHours > expectedEveryHours,
      /** Where prices come from, for the screen to name. Never the API key. */
      source: this.spotFeedUrl ? 'custom' : 'ibja',
    };
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
      /** ibja | manual | feed (a spot provider, or a row older than sources). */
      source: 'ibja' | 'manual' | 'feed';
      /** The IBJA publication day this rate is from, when source is ibja. */
      publishedOn: string | null;
      /** Not published by the source; derived from the 999 rate by fineness. */
      derived: boolean;
    }>
  > {
    const metals = Object.values(MetalKind);
    const now = Date.now();
    // IBJA publishes on weekdays only; Friday's rate re-read on Saturday is
    // still Friday's, so an IBJA rate is stale whenever it is not today's.
    const today = dateOnly(businessDate(new Date(now), DEFAULT_TZ));
    const rows = await Promise.all(
      metals.map(async (metal) => ({ metal, row: await this.latestRow(metal, organisationId, storeId) })),
    );
    return rows
      .filter((r) => r.row != null)
      .map(({ metal, row }) => {
        const effectiveFrom = row!.effectiveFrom ?? row!.createdAt;
        const ageHours = Math.max(0, (now - effectiveFrom.getTime()) / 3_600_000);
        const tag = row!.legacyId?.split(':')[0];
        const publishedOn = tag === 'ibja' && row!.legacyUpdatedAt ? dateOnly(row!.legacyUpdatedAt) : null;
        return {
          metal,
          ratePerGram: Number(row!.ratePerGram),
          effectiveFrom: effectiveFrom.toISOString(),
          ageHours: Math.round(ageHours * 10) / 10,
          stale: publishedOn ? publishedOn !== today : ageHours > this.staleAfterHours,
          source: tag === 'ibja' || tag === 'manual' ? tag : ('feed' as const),
          publishedOn,
          derived: row!.legacyId?.endsWith(':derived') ?? false,
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
    if (!this.spotFeedUrl) return this.refreshFromIbja(organisationId);

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

  /**
   * Read IBJA and store its latest publication. One row per (publication,
   * metal, rate) — a re-read of the same publication only renews its
   * effectiveFrom, so it stays current over a weekend without piling up rows,
   * and a manual rate typed since is superseded only by a newer read.
   */
  private async refreshFromIbja(
    organisationId: string,
  ): Promise<{ updated: boolean; dryRun: boolean; rates?: Record<string, number> }> {
    let html: string;
    try {
      const res = await fetch(IBJA_URL, {
        headers: { 'User-Agent': FEED_USER_AGENT, Accept: 'text/html' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      this.logger.warn(`IBJA rate fetch failed: ${(err as Error)?.message ?? err}`);
      return { updated: false, dryRun: false };
    }
    const ibja = parseIbja(html);
    if (!ibja) {
      this.logger.warn('IBJA page did not carry a readable 999 rate — keeping the last stored rates.');
      return { updated: false, dryRun: false };
    }
    const now = new Date();
    // Noon IST is the same calendar day in IST and UTC; midnight IST is the day before in UTC.
    const published = new Date(`${ibja.publishedOn}T12:00:00+05:30`);
    const rates: Record<string, number> = {};
    for (const [metal, ratePerGram] of Object.entries(ibja.perGram) as [MetalKind, number][]) {
      const derived = ibja.derived.includes(metal);
      const legacyId = `ibja:${ibja.publishedOn}:${metal}:${ratePerGram}${derived ? ':derived' : ''}`;
      await this.prisma.metalRate.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { organisationId, metal, ratePerGram, effectiveFrom: now, legacyId, legacyUpdatedAt: published },
        update: { effectiveFrom: now },
      });
      rates[metal] = ratePerGram;
    }
    this.logger.log(`IBJA rates of ${ibja.publishedOn} stored: 24k ₹${rates.gold_24k}/g, 22k ₹${rates.gold_22k}/g`);
    return { updated: true, dryRun: false, rates };
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
    const rates = await this.writePurities(fine, new Date(), organisationId, 'manual');
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
    source?: 'manual',
  ): Promise<Record<string, number>> {
    const written: Record<string, number> = {};
    for (const [metal, mult] of GOLD_PURITY) {
      const ratePerGram = round2(fineInrPerGram * mult);
      await this.prisma.metalRate.create({
        data: {
          metal,
          ratePerGram,
          effectiveFrom,
          organisationId,
          ...(source ? { legacyId: `${source}:${effectiveFrom.getTime()}:${metal}` } : {}),
        },
      });
      written[metal] = ratePerGram;
    }
    return written;
  }

  /**
   * Normalise a feed response to INR per gram of fine gold. Handles the common
   * shapes so swapping providers is a config change, not a code change:
   *   A) CoinGecko  → { "pax-gold": { inr } }       (per troy ounce)
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
