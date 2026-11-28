import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MetaGraphClient } from '../integrations/meta-graph.client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdSpend, AdSpendSnapshot } from './ad-cost-per-enquiry';
import {
  assertCurrency,
  assertTimezone,
  normaliseAdAccountId,
  parseDateWindow,
  zonedDateBounds,
  MAX_META_REPORT_DAYS,
} from './meta-ads-insights.util';

/**
 * Meta spend per ADVERT over one window, for the cost-per-enquiry screen.
 *
 * ## Why this is not `MetaAdsInsightsService`
 *
 * That service ingests spend per CAMPAIGN per DAY into `AdSpendDaily`, with
 * `AdSpendCoverage` recording which days were actually fetched, so ROAS can
 * refuse to publish a number over a window that was never pulled. It is the
 * right machinery for money that has to reconcile with revenue.
 *
 * This screen needs something that service deliberately does not hold: the
 * breakdown per advert, because a Click-to-WhatsApp referral carries only the
 * AD id and the client ranks creatives, not campaigns. So this reads the same
 * edge through the same `MetaGraphClient`, with the same tenant-and-provider
 * integration lookup and the same redacted error handling — one request, no new
 * table, no second way to reach Meta and no second integration.
 *
 * The consequence is that nothing here is persisted, so there is no coverage
 * record and no claim that a window was completely fetched. That is why a
 * failed call reports `available: false` rather than an empty account: the
 * honesty that `AdSpendCoverage` buys for ROAS is bought here by refusing to
 * imply zero.
 *
 * ## One request, not one per advert
 *
 * The insights edge accepts `level=ad` at the ACCOUNT level, which returns one
 * row per delivering advert for the whole window in a single call. Asking per
 * advert would be one call each and would meet Meta's rate limit on an account
 * with a season's worth of creatives, for data the account call already has.
 */
const MAX_PAGES = 50;
/** Cap on remembered windows, so a long-running process cannot grow unbounded. */
const MAX_ENTRIES = 500;

/**
 * How long a successful window is trusted.
 *
 * Shorter than `MetaAdMetadataService`'s six hours, because an ad set's name
 * does not change and today's spend does — a window ending today is still being
 * added to. Fifteen minutes keeps the figure current enough to be read as
 * "today so far" while a manager refreshing a dashboard, or eleven of them
 * opening it at once, costs one Graph call rather than one each.
 */
const SUCCESS_TTL_MS = 15 * 60 * 1000;

/**
 * How long a FAILED window is remembered. Deliberately short, and deliberately
 * not zero: without it an expired token puts a ten-second Graph timeout in
 * front of every load of this screen, turning a broken Meta connection into a
 * reporting outage. Two minutes absorbs a burst and still lets a fixed token
 * restore the figures without a redeploy.
 */
const FAILURE_TTL_MS = 2 * 60 * 1000;

const MONEY_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const COUNT_RE = /^(?:0|[1-9]\d*)$/;

@Injectable()
export class MetaAdSpendService {
  private readonly logger = new Logger(MetaAdSpendService.name);

  /**
   * Process-local cache, keyed by tenant, account and window.
   *
   * Same shape and the same reasoning as `MetaAdMetadataService.cache`: a Map
   * rather than a table, because a restart costs one Graph call per window
   * still being looked at and persisting it would buy that back at the price of
   * a schema, a migration and a staleness policy the TTL handles for free.
   * Keyed by tenant as well as window so one organisation can never read spend
   * fetched with another's token.
   */
  private readonly cache = new Map<string, { value: AdSpendSnapshot; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
  ) {}

  async spendForWindow(
    organisationId: string,
    request: { integrationId: string; adAccountAssetId: string; dateFrom: string; dateTo: string },
  ): Promise<AdSpendSnapshot> {
    const window = parseDateWindow(request.dateFrom, request.dateTo, MAX_META_REPORT_DAYS);
    const target = await this.accountTarget(
      organisationId,
      request.integrationId,
      request.adAccountAssetId,
    );
    const key = [
      organisationId,
      target.integrationId,
      target.adAccountAssetId,
      window.dateFrom,
      window.dateTo,
    ].join(':');
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const bounds = zonedDateBounds(window, target.timezone);
    const base: Omit<AdSpendSnapshot, 'available' | 'unavailableReason' | 'adverts'> = {
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
      timezone: target.timezone,
      // The instants the account's local days actually span, so the enquiry
      // side can be counted over exactly these and the join can tell whether it
      // was. Derived here rather than by the caller: two hand-rolled windows
      // that differ by an hour divide cleanly and mean nothing.
      from: bounds.gte.toISOString(),
      to: bounds.lt.toISOString(),
      currency: target.currency,
    };

    let snapshot: AdSpendSnapshot;
    try {
      const adverts = await this.fetch(organisationId, target, window);
      snapshot = { ...base, available: true, unavailableReason: null, adverts };
    } catch (error) {
      const message = safeProviderError(error);
      // Logged once per window per TTL, not once per advert, and the ad account
      // asset id is safe to log — a token never is.
      this.logger.warn(
        `Could not read Meta ad spend for ${target.adAccountAssetId} ${window.dateFrom}..${window.dateTo}: ${message}`,
      );
      snapshot = { ...base, available: false, unavailableReason: message, adverts: [] };
    }
    this.remember(key, snapshot);
    return snapshot;
  }

  /** Drop everything. For tests, and for a figure that must be re-read now. */
  clearCache() {
    this.cache.clear();
  }

  private async fetch(
    organisationId: string,
    target: AdAccountTarget,
    window: { dateFrom: string; dateTo: string },
  ): Promise<AdSpend[]> {
    const rows = new Map<string, AdSpend>();
    let after: string | undefined;
    const seenCursors = new Set<string>();
    let pages = 0;

    while (true) {
      pages += 1;
      if (pages > MAX_PAGES) throw new Error(`Meta Insights exceeded ${MAX_PAGES} pages.`);
      const page = await this.graph.getForIntegration<MetaAdInsightsPage>(
        organisationId,
        target.integrationId,
        `act_${target.adAccountId}/insights`,
        {
          fields:
            'account_currency,ad_id,ad_name,campaign_id,campaign_name,spend,impressions,actions',
          level: 'ad',
          time_range: JSON.stringify({ since: window.dateFrom, until: window.dateTo }),
          limit: '200',
          ...(after ? { after } : {}),
        },
      );
      if (!page || !Array.isArray(page.data)) {
        throw new Error('Meta Insights returned a response without a data array.');
      }
      for (const raw of page.data) {
        const row = this.normalise(raw, target.currency);
        const prior = rows.get(row.adId);
        // One row per advert is what `level=ad` with no `time_increment`
        // returns. Should Meta ever split one, the spend is added rather than
        // overwritten — losing half an advert's cost silently is the one
        // outcome worth code to prevent.
        rows.set(row.adId, prior ? mergeRows(prior, row) : row);
      }

      const next = page.paging?.next;
      const nextCursor = next ? page.paging?.cursors?.after : undefined;
      if (!next) break;
      if (!nextCursor || nextCursor.length > 2048 || seenCursors.has(nextCursor)) {
        throw new Error('Meta Insights returned an invalid or repeated pagination cursor.');
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
    }
    return [...rows.values()];
  }

  /**
   * Validate one provider row. Malformed numbers are REJECTED, which fails the
   * whole window to `available: false`, rather than coerced to zero — the same
   * choice `normaliseInsightRow` makes for ingested spend, and for the same
   * reason: a zero is indistinguishable from a real nil once it is on a screen.
   */
  private normalise(row: MetaAdInsightsRow, currency: string): AdSpend {
    const accountCurrency = assertCurrency(row.account_currency);
    if (accountCurrency !== currency) {
      throw new Error(
        `Meta returned ${accountCurrency}, but this ad account is configured as ${currency}.`,
      );
    }
    const adId = (row.ad_id ?? '').trim();
    if (!/^[1-9]\d{4,63}$/.test(adId)) throw new Error('Meta returned an invalid ad id.');
    const campaignId = (row.campaign_id ?? '').trim();
    return {
      adId,
      adName: cleanLabel(row.ad_name),
      campaignId: /^[1-9]\d{4,63}$/.test(campaignId) ? campaignId : null,
      campaignName: cleanLabel(row.campaign_name),
      spend: decimalString(row.spend, 'spend'),
      impressions: countString(row.impressions, 'impressions'),
      /*
       * Meta's OWN lead count, and nothing more is made of it. It counts
       * lead-FORM submissions; our enquiry count is people who wrote on
       * WhatsApp. On Nibhana's live account that is 3 against 167 for the same
       * campaign, so these are carried through under `meta` and never blended
       * with ours — see the header of `ad-cost-per-enquiry.ts`.
       */
      leads: actionValue(row.actions, 'onsite_conversion.lead'),
      linkClicks: actionValue(row.actions, 'link_click'),
    };
  }

  /**
   * The tenant's own ad account connection, resolved exactly as
   * `MetaAdsInsightsService.accountTarget` resolves it: the asset must belong to
   * this organisation AND to a `meta_ads` integration of the same organisation,
   * and both the currency and the timezone must be explicitly configured.
   *
   * Duplicated rather than shared because that method is private to a file this
   * change may not edit. Lifting it into `meta-ads-insights.util.ts` and having
   * both call it is the obvious follow-up — see AD-COST-WIRING.md.
   */
  private async accountTarget(
    organisationId: string,
    integrationId: string,
    adAccountAssetId: string,
  ): Promise<AdAccountTarget> {
    const asset = await this.prisma.integrationAsset.findFirst({
      where: {
        id: adAccountAssetId,
        organisationId,
        integrationId,
        kind: 'ad_account',
        isActive: true,
        integration: { organisationId, providerCode: 'meta_ads' },
      },
      select: {
        id: true,
        externalId: true,
        metadata: true,
        integration: { select: { id: true, config: true } },
      },
    });
    if (!asset) throw new NotFoundException('Meta ad account connection not found.');
    const assetConfig = jsonObject(asset.metadata);
    const integrationConfig = jsonObject(asset.integration.config);
    const nestedAsset = jsonObject(assetConfig.metaAds);
    const nestedIntegration = jsonObject(integrationConfig.metaAds);
    return {
      integrationId: asset.integration.id,
      adAccountAssetId: asset.id,
      adAccountId: normaliseAdAccountId(asset.externalId),
      // The ad account's own currency, read from the connection and checked
      // again against every row Meta returns. Never assumed to be rupees.
      currency: assertCurrency(
        assetConfig.accountCurrency ??
          assetConfig.currency ??
          nestedAsset.currency ??
          integrationConfig.accountCurrency ??
          integrationConfig.currency ??
          nestedIntegration.currency,
      ),
      timezone: assertTimezone(
        assetConfig.accountTimezone ??
          assetConfig.timezone ??
          nestedAsset.timezone ??
          integrationConfig.accountTimezone ??
          integrationConfig.timezone ??
          nestedIntegration.timezone,
      ),
    };
  }

  private remember(key: string, value: AdSpendSnapshot) {
    if (this.cache.size >= MAX_ENTRIES) {
      // Oldest insertion first — Map preserves insertion order. Crude next to a
      // true LRU and adequate: the working set is "windows somebody is looking
      // at", which turns over on its own.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (value.available ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
    });
  }
}

interface AdAccountTarget {
  integrationId: string;
  adAccountAssetId: string;
  adAccountId: string;
  currency: string;
  timezone: string;
}

/** The slice of the ad-level insights response this screen consumes. */
interface MetaAdInsightsRow {
  account_currency?: string;
  ad_id?: string;
  ad_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  actions?: { action_type?: string; value?: string }[];
}

interface MetaAdInsightsPage {
  data?: MetaAdInsightsRow[];
  paging?: { cursors?: { after?: string }; next?: string };
}

function mergeRows(prior: AdSpend, next: AdSpend): AdSpend {
  return {
    ...prior,
    adName: prior.adName ?? next.adName,
    campaignId: prior.campaignId ?? next.campaignId,
    campaignName: prior.campaignName ?? next.campaignName,
    spend: new Prisma.Decimal(prior.spend).plus(next.spend).toFixed(),
    impressions: addCount(prior.impressions, next.impressions),
    leads: addNumber(prior.leads, next.leads),
    linkClicks: addNumber(prior.linkClicks, next.linkClicks),
  };
}

function addCount(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return (BigInt(a) + BigInt(b)).toString();
}

function addNumber(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/**
 * One action type's value, or null when Meta did not report that action.
 *
 * Null rather than 0, because "this advert produced no lead-form submissions"
 * and "Meta did not report on lead-form submissions" are different facts and
 * only the first may be read as none.
 */
function actionValue(
  actions: MetaAdInsightsRow['actions'],
  type: string,
): number | null {
  if (!Array.isArray(actions)) return null;
  const found = actions.find((a) => a?.action_type === type);
  if (!found) return null;
  const raw = typeof found.value === 'string' ? found.value.trim() : '';
  if (!COUNT_RE.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function decimalString(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!MONEY_RE.test(raw)) throw new Error(`Meta returned invalid ${field}.`);
  return new Prisma.Decimal(raw).toFixed();
}

function countString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!COUNT_RE.test(raw)) throw new Error(`Meta returned invalid ${field}.`);
  return BigInt(raw).toString();
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label ? label.slice(0, 500) : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A provider message safe to store and show: no token, no Graph URL. */
function safeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(access_token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
