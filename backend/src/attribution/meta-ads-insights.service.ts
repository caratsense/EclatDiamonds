import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { MetaGraphClient } from '../integrations/meta-graph.client';
import { JobContext, JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCurrency,
  assertTimezone,
  decimalOrZero,
  insightFingerprint,
  insightRowKey,
  MAX_META_REPORT_DAYS,
  normaliseAdAccountId,
  normaliseInsightRow,
  parseDateWindow,
  zonedDateBounds,
} from './meta-ads-insights.util';
import type {
  MetaAdsAccountTarget,
  MetaAdsSyncPayload,
  MetaInsightRecord,
  MetaInsightsApiPage,
} from './meta-ads-insights.types';

export const META_ADS_INSIGHTS_JOB = 'meta_ads.insights.pull';
const MAX_PAGES = 100;
const MAX_ROWS = 20_000;

export interface MetaAdsSyncRequest {
  integrationId: string;
  adAccountAssetId: string;
  dateFrom: string;
  dateTo: string;
}

export interface MetaAdsPerformanceQuery extends MetaAdsSyncRequest {
  model?: 'first_touch' | 'last_touch';
}

/**
 * Meta campaign spend ingestion and honest ROAS reporting.
 *
 * Provider spend lands in AdSpendDaily, one typed row per account/campaign/
 * account-local day, with a Decimal amount, an explicit ISO currency and a
 * unique key that makes a replay an update instead of a second charge. It used
 * to land as JSON in LegacyRow, the untyped import staging table, where none of
 * those three things were possible.
 *
 * AdSpendCoverage records which days were actually fetched, because 'no rows
 * for Tuesday' and 'Tuesday was never fetched' are different facts and only the
 * first may be read as zero.
 *
 * MarketingCampaign.spend remains a separately declared number; provider data
 * never overwrites it, so the distinction between measured and declared stays
 * recoverable.
 */
@Injectable()
export class MetaAdsInsightsService implements OnModuleInit {
  private readonly logger = new Logger(MetaAdsInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(META_ADS_INSIGHTS_JOB, async (payload, context) =>
      this.runJob(payload, context),
    );
  }

  /** Queue one bounded account-local date window. Duplicate clicks collapse hourly. */
  async schedule(user: AuthUser, request: MetaAdsSyncRequest) {
    const window = parseDateWindow(request.dateFrom, request.dateTo);
    const target = await this.accountTarget(
      user.organisationId,
      request.integrationId,
      request.adAccountAssetId,
    );
    const payload: MetaAdsSyncPayload = {
      integrationId: target.integrationId,
      adAccountAssetId: target.adAccountAssetId,
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
      requestedById: user.id,
    };
    const hour = new Date().toISOString().slice(0, 13);
    const queued = await this.jobs.enqueue({
      kind: META_ADS_INSIGHTS_JOB,
      organisationId: user.organisationId,
      payload: payload as unknown as Prisma.InputJsonValue,
      idempotencyKey: [
        META_ADS_INSIGHTS_JOB,
        user.organisationId,
        target.integrationId,
        target.adAccountAssetId,
        window.dateFrom,
        window.dateTo,
        hour,
      ].join(':'),
      maxAttempts: 5,
      createdById: user.id,
    });
    await this.audit.record(user, {
      action: 'meta_ads.insights_sync_queued',
      entityType: 'Integration',
      entityId: target.integrationId,
      summary: `Queued measured ad spend for ${window.dateFrom} to ${window.dateTo}.`,
      metadata: {
        jobId: queued.id,
        deduplicated: queued.deduplicated,
        adAccountAssetId: target.adAccountAssetId,
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
        // External account id, tokens and provider URLs do not belong in audit.
        currency: target.currency,
        timezone: target.timezone,
      },
    });
    return {
      queued: true,
      jobId: queued.id,
      deduplicated: queued.deduplicated,
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
      currency: target.currency,
      timezone: target.timezone,
    };
  }

  /**
   * Pull every page. Completed-day markers are removed before the first request
   * and restored only after every page validates and stale rows are reconciled.
   * Therefore a partial provider failure can leave useful idempotent rows for a
   * retry, but it can never yield a publishable ROAS number.
   */
  async ingestWindow(
    organisationId: string,
    request: Omit<MetaAdsSyncPayload, 'requestedById'>,
    jobId: string,
  ) {
    const window = parseDateWindow(request.dateFrom, request.dateTo);
    const target = await this.accountTarget(
      organisationId,
      request.integrationId,
      request.adAccountAssetId,
    );

    // Mark the requested days incomplete before transport begins. Existing
    // spend remains readable for diagnosis, but ROAS stays null until completion.
    await this.prisma.adSpendCoverage.deleteMany({
      where: {
        organisationId,
        adAccountAssetId: target.adAccountAssetId,
        date: { in: window.dates.map(calendarDay) },
      },
    });

    const fetchedAt = new Date().toISOString();
    const fingerprints = new Map<string, string>();
    let after: string | undefined;
    const seenCursors = new Set<string>();
    let pages = 0;
    let rows = 0;

    try {
      while (true) {
        pages += 1;
        if (pages > MAX_PAGES) throw new Error(`Meta Insights exceeded ${MAX_PAGES} pages.`);
        const page = await this.graph.getForIntegration<MetaInsightsApiPage>(
          organisationId,
          target.integrationId,
          `act_${target.adAccountId}/insights`,
          {
            fields:
              'account_id,account_currency,campaign_id,campaign_name,date_start,date_stop,spend,impressions,clicks',
            level: 'campaign',
            time_increment: '1',
            time_range: JSON.stringify({ since: window.dateFrom, until: window.dateTo }),
            limit: '100',
            ...(after ? { after } : {}),
          },
        );
        if (!page || !Array.isArray(page.data)) {
          throw new Error('Meta Insights returned a response without a data array.');
        }
        rows += page.data.length;
        if (rows > MAX_ROWS) throw new Error(`Meta Insights exceeded ${MAX_ROWS} rows.`);

        const unique = new Map<string, MetaInsightRecord>();
        for (const raw of page.data) {
          const record = normaliseInsightRow(raw, {
            integrationId: target.integrationId,
            adAccountAssetId: target.adAccountAssetId,
            adAccountId: target.adAccountId,
            currency: target.currency,
            timezone: target.timezone,
            window,
            fetchedAt,
            jobId,
          });
          const key = insightRowKey(record);
          const fingerprint = insightFingerprint(record);
          const prior = fingerprints.get(key);
          if (prior && prior !== fingerprint) {
            throw new Error(`Meta returned conflicting duplicates for ${key}.`);
          }
          fingerprints.set(key, fingerprint);
          unique.set(key, record);
        }

        if (unique.size) {
          await this.prisma.$transaction(
            [...unique.values()].map((record) =>
              this.prisma.adSpendDaily.upsert({
                // The unique key is the replay guard: re-running a window
                // updates the day in place rather than adding spend to it.
                where: {
                  organisationId_adAccountAssetId_date_externalCampaignId: {
                    organisationId,
                    adAccountAssetId: record.adAccountAssetId,
                    date: calendarDay(record.date),
                    externalCampaignId: record.externalCampaignId,
                  },
                },
                create: {
                  organisationId,
                  integrationId: record.integrationId,
                  adAccountAssetId: record.adAccountAssetId,
                  externalAccountId: record.adAccountId,
                  externalCampaignId: record.externalCampaignId,
                  campaignName: record.campaignName,
                  date: calendarDay(record.date),
                  timezone: record.timezone,
                  currency: record.currency,
                  spend: record.spend,
                  impressions: record.impressions === null ? null : BigInt(record.impressions),
                  clicks: record.clicks === null ? null : BigInt(record.clicks),
                  fetchedAt: new Date(fetchedAt),
                  jobId: record.jobId,
                },
                update: {
                  campaignName: record.campaignName,
                  timezone: record.timezone,
                  currency: record.currency,
                  spend: record.spend,
                  impressions: record.impressions === null ? null : BigInt(record.impressions),
                  clicks: record.clicks === null ? null : BigInt(record.clicks),
                  fetchedAt: new Date(fetchedAt),
                  jobId: record.jobId,
                },
              }),
            ),
          );
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

      // A campaign that stopped spending mid-window still has a row from the
      // previous run. Anything in the window the provider did not return this
      // time is gone, not zero, so it is removed rather than left to inflate a
      // later denominator.
      const existing = await this.prisma.adSpendDaily.findMany({
        where: {
          organisationId,
          adAccountAssetId: target.adAccountAssetId,
          date: { in: window.dates.map(calendarDay) },
        },
        select: { id: true, date: true, externalCampaignId: true },
      });
      const staleIds = existing
        .filter((r) => !fingerprints.has(`${dayString(r.date)}:${r.externalCampaignId}`))
        .map((r) => r.id);
      const completedAt = new Date();
      await this.prisma.$transaction([
        ...(staleIds.length
          ? [this.prisma.adSpendDaily.deleteMany({ where: { organisationId, id: { in: staleIds } } })]
          : []),
        ...window.dates.map((date) =>
          this.prisma.adSpendCoverage.upsert({
            where: {
              organisationId_adAccountAssetId_date: {
                organisationId,
                adAccountAssetId: target.adAccountAssetId,
                date: calendarDay(date),
              },
            },
            create: {
              organisationId,
              integrationId: target.integrationId,
              adAccountAssetId: target.adAccountAssetId,
              externalAccountId: target.adAccountId,
              date: calendarDay(date),
              timezone: target.timezone,
              // The currency in force when the day was ingested. Reporting a
              // day covered in one currency under another is a mismatch to
              // surface, not a conversion to perform.
              currency: target.currency,
              completedAt,
              jobId,
            },
            update: {
              timezone: target.timezone,
              currency: target.currency,
              completedAt,
              jobId,
            },
          }),
        ),
      ]);
      await this.prisma.integration.updateMany({
        where: { id: target.integrationId, organisationId, providerCode: 'meta_ads' },
        data: { status: 'connected', lastSyncAt: completedAt, lastError: null },
      });
      return {
        integrationId: target.integrationId,
        adAccountAssetId: target.adAccountAssetId,
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
        currency: target.currency,
        timezone: target.timezone,
        pages,
        providerRows: rows,
        uniqueRows: fingerprints.size,
        staleRowsRemoved: staleIds.length,
        coverageComplete: true,
      };
    } catch (error) {
      const message = safeProviderError(error);
      await this.prisma.integration
        .updateMany({
          where: { id: target.integrationId, organisationId, providerCode: 'meta_ads' },
          data: { lastError: message },
        })
        .catch(() => undefined);
      this.logger.warn(`Meta spend sync ${jobId} failed: ${message}`);
      throw error;
    }
  }

  /** Date-windowed first/last-touch report for one tenant-owned ad account. */
  async performance(user: AuthUser, query: MetaAdsPerformanceQuery) {
    const window = parseDateWindow(query.dateFrom, query.dateTo, MAX_META_REPORT_DAYS);
    const target = await this.accountTarget(
      user.organisationId,
      query.integrationId,
      query.adAccountAssetId,
    );
    const model = query.model ?? 'last_touch';
    const days = window.dates.map(calendarDay);
    const [spendRows, coverageRows, organisation, campaigns] = await Promise.all([
      this.prisma.adSpendDaily.findMany({
        where: {
          organisationId: user.organisationId,
          adAccountAssetId: target.adAccountAssetId,
          date: { in: days },
        },
      }),
      this.prisma.adSpendCoverage.findMany({
        where: {
          organisationId: user.organisationId,
          adAccountAssetId: target.adAccountAssetId,
          date: { in: days },
        },
      }),
      // Revenue is denominated in the tenant's currency; spend in the ad
      // account's. Dividing one by the other when they differ produces a number
      // with no unit, so the two are read together and compared.
      this.prisma.organisation.findUniqueOrThrow({
        where: { id: user.organisationId },
        select: { currency: true },
      }),
      this.prisma.marketingCampaign.findMany({
        where: { organisationId: user.organisationId, provider: 'meta_ads' },
        select: {
          id: true,
          name: true,
          externalCampaignId: true,
          spend: true,
          startDate: true,
          endDate: true,
        },
      }),
    ]);
    /*
     * INT-06. Three currencies can disagree here, and none of them may be
     * converted into another without a rate nobody has supplied:
     *
     *   - the ad account's configured currency (the denominator's unit);
     *   - the currency each stored day was actually ingested under, which
     *     changes if the account is reconfigured mid-history;
     *   - the tenant's own currency, which is what revenue is denominated in.
     *
     * Rows in a foreign currency used to be dropped with a `continue`, while
     * coverage was not currency-checked at all — so the report could declare a
     * window fully covered and publish a ROAS whose denominator had silently
     * lost days. Nothing is dropped now: every currency present is reported,
     * and any disagreement makes ROAS null rather than plausible.
     */
    const revenueCurrency = organisation.currency.trim().toUpperCase();
    const spendCurrencies = [
      ...new Set([
        ...spendRows.map((r) => r.currency),
        ...coverageRows.map((r) => r.currency),
      ]),
    ].sort();
    const foreignSpend = spendCurrencies.filter((c) => c !== target.currency);
    const currencyMismatch = foreignSpend.length > 0 || revenueCurrency !== target.currency;

    // Only days covered in the account's own currency count as covered. A day
    // ingested under a different currency is data about a different unit.
    const completeDates = new Set(
      coverageRows.filter((r) => r.currency === target.currency).map((r) => dayString(r.date)),
    );
    const missingDates = window.dates.filter((date) => !completeDates.has(date));
    const coverageComplete = missingDates.length === 0;
    const bounds = zonedDateBounds(window, target.timezone);
    const touches = await this.prisma.attributionTouch.findMany({
      where: {
        organisationId: user.organisationId,
        saleId: { not: null },
        creditModel: { in: [model, 'both'] },
        sale: {
          organisationId: user.organisationId,
          isCancelled: false,
          docDate: bounds,
          ...(!user.allStores ? { storeId: { in: user.storeIds } } : {}),
        },
      },
      select: {
        campaignId: true,
        externalCampaignId: true,
        evidence: true,
        sale: { select: { id: true, totalAmount: true } },
      },
    });

    const campaignByExternal = new Map<string, (typeof campaigns)[number]>();
    const ambiguousExternalIds = new Set<string>();
    for (const campaign of campaigns) {
      if (!campaign.externalCampaignId) continue;
      if (campaignByExternal.has(campaign.externalCampaignId)) {
        campaignByExternal.delete(campaign.externalCampaignId);
        ambiguousExternalIds.add(campaign.externalCampaignId);
      } else if (!ambiguousExternalIds.has(campaign.externalCampaignId)) {
        campaignByExternal.set(campaign.externalCampaignId, campaign);
      }
    }
    const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
    const buckets = new Map<string, PerformanceBucket>();
    // Spend that is not in the account's currency, kept per currency instead of
    // being silently discarded. It is never added to the account-currency total.
    const spendByCurrency = new Map<string, Prisma.Decimal>();
    for (const stored of spendRows) {
      spendByCurrency.set(
        stored.currency,
        (spendByCurrency.get(stored.currency) ?? new Prisma.Decimal(0)).plus(stored.spend),
      );
      if (stored.currency !== target.currency) continue;
      const campaign = campaignByExternal.get(stored.externalCampaignId) ?? null;
      const bucket = getBucket(
        buckets,
        stored.externalCampaignId,
        stored.campaignName ?? campaign?.name ?? stored.externalCampaignId,
        campaign,
      );
      bucket.observedInAccount = true;
      bucket.measuredSpend = bucket.measuredSpend.plus(stored.spend);
      bucket.impressions += stored.impressions ?? 0n;
      bucket.clicks += stored.clicks ?? 0n;
    }
    for (const touch of touches) {
      if (!touch.sale) continue;
      const internal = touch.campaignId ? campaignById.get(touch.campaignId) : undefined;
      const externalId = touch.externalCampaignId ?? internal?.externalCampaignId;
      // Revenue with no Meta campaign identity remains attributable in the CRM
      // report, but cannot honestly be joined to this ad account's spend.
      if (!externalId) continue;
      const mapped = ambiguousExternalIds.has(externalId)
        ? null
        : (campaignByExternal.get(externalId) ?? internal ?? null);
      const bucket = getBucket(buckets, externalId, mapped?.name ?? externalId, mapped);
      if (touch.evidence === 'measured') {
        if (!bucket.measuredSaleIds.has(touch.sale.id)) {
          bucket.measuredRevenue = bucket.measuredRevenue.plus(touch.sale.totalAmount);
          bucket.measuredSaleIds.add(touch.sale.id);
        }
      } else if (!bucket.declaredSaleIds.has(touch.sale.id)) {
        bucket.declaredRevenue = bucket.declaredRevenue.plus(touch.sale.totalAmount);
        bucket.declaredSaleIds.add(touch.sale.id);
      }
    }

    const rows = [...buckets.values()]
      .map((bucket) => {
        const roas = roasResult(bucket.measuredRevenue, bucket.measuredSpend, coverageComplete, currencyMismatch);
        return {
          externalCampaignId: bucket.externalCampaignId,
          campaignId: bucket.campaign?.id ?? null,
          label: bucket.label,
          currency: target.currency,
          measuredSpend: bucket.measuredSpend.toFixed(2),
          declaredCampaignSpend: bucket.campaign?.spend?.toFixed(2) ?? null,
          declaredSpendScope: bucket.campaign?.spend ? 'campaign_lifetime_not_windowed' : null,
          impressions: bucket.impressions.toString(),
          clicks: bucket.clicks.toString(),
          measuredRevenue: bucket.measuredRevenue.toFixed(2),
          declaredRevenue: bucket.declaredRevenue.toFixed(2),
          measuredSales: bucket.measuredSaleIds.size,
          declaredSales: bucket.declaredSaleIds.size,
          measuredRoas: roas.value,
          measuredRoasStatus: roas.status,
          spendAssociation: bucket.observedInAccount ? 'observed_in_account' : 'not_observed_in_account',
          mappingStatus: ambiguousExternalIds.has(bucket.externalCampaignId)
            ? 'ambiguous'
            : bucket.campaign
              ? 'mapped'
              : 'unmapped',
        };
      })
      .sort((a, b) => Number(b.measuredSpend) - Number(a.measuredSpend));

    const totals = rows.reduce(
      (sum, row) => ({
        measuredSpend: sum.measuredSpend.plus(row.measuredSpend),
        measuredRevenue: sum.measuredRevenue.plus(
          row.spendAssociation === 'observed_in_account' ? row.measuredRevenue : '0',
        ),
        unjoinedMeasuredRevenue: sum.unjoinedMeasuredRevenue.plus(
          row.spendAssociation === 'observed_in_account' ? '0' : row.measuredRevenue,
        ),
        declaredRevenue: sum.declaredRevenue.plus(row.declaredRevenue),
      }),
      {
        measuredSpend: decimalOrZero('0'),
        measuredRevenue: decimalOrZero('0'),
        unjoinedMeasuredRevenue: decimalOrZero('0'),
        declaredRevenue: decimalOrZero('0'),
      },
    );
    const totalRoas = roasResult(totals.measuredRevenue, totals.measuredSpend, coverageComplete, currencyMismatch);
    return {
      model,
      integrationId: target.integrationId,
      adAccountAssetId: target.adAccountAssetId,
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
      timezone: target.timezone,
      currency: target.currency,
      /**
       * Every currency in play, labelled. Nothing here is converted; the report
       * says what unit each number is in and refuses to divide across units.
       */
      currencies: {
        spend: target.currency,
        revenue: revenueCurrency,
        mismatch: currencyMismatch,
        // Spend found under a currency the account is not configured with —
        // typically an account reconfigured partway through the window. Shown
        // rather than dropped, and never added to the account-currency total.
        foreignSpend: foreignSpend.map((currency) => ({
          currency,
          measuredSpend: (spendByCurrency.get(currency) ?? new Prisma.Decimal(0)).toFixed(2),
        })),
      },
      coverage: {
        complete: coverageComplete,
        completedDays: window.dates.length - missingDates.length,
        expectedDays: window.dates.length,
        missingDates,
      },
      totals: {
        measuredSpend: totals.measuredSpend.toFixed(2),
        measuredSpendCurrency: target.currency,
        measuredRevenue: totals.measuredRevenue.toFixed(2),
        measuredRevenueCurrency: revenueCurrency,
        unjoinedMeasuredRevenue: totals.unjoinedMeasuredRevenue.toFixed(2),
        declaredRevenue: totals.declaredRevenue.toFixed(2),
        measuredRoas: totalRoas.value,
        measuredRoasStatus: totalRoas.status,
        currencyMismatch,
      },
      rows,
      note:
        'Provider-measured spend and click-backed revenue are kept separate from manually declared campaign spend and lead-source revenue. ROAS is null until every requested account-local day is covered in the account currency, the measured-spend denominator is positive, and spend and revenue share one currency. No currency conversion is performed anywhere in this report.',
    };
  }

  private async runJob(payload: unknown, context: JobContext) {
    const p = payload as Partial<MetaAdsSyncPayload> | null;
    if (
      !context.organisationId ||
      !p?.integrationId ||
      !p.adAccountAssetId ||
      !p.dateFrom ||
      !p.dateTo
    ) {
      throw new Error('Invalid Meta Insights job payload.');
    }
    return this.ingestWindow(
      context.organisationId,
      {
        integrationId: p.integrationId,
        adAccountAssetId: p.adAccountAssetId,
        dateFrom: p.dateFrom,
        dateTo: p.dateTo,
      },
      context.jobId,
    );
  }

  private async accountTarget(
    organisationId: string,
    integrationId: string,
    adAccountAssetId: string,
  ): Promise<MetaAdsAccountTarget> {
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
        integration: { select: { id: true, name: true, config: true } },
      },
    });
    if (!asset) throw new NotFoundException('Meta ad account connection not found.');
    const assetConfig = jsonObject(asset.metadata);
    const integrationConfig = jsonObject(asset.integration.config);
    const nestedAsset = jsonObject(assetConfig.metaAds);
    const nestedIntegration = jsonObject(integrationConfig.metaAds);
    const currency = assertCurrency(
      assetConfig.accountCurrency ??
        assetConfig.currency ??
        nestedAsset.currency ??
        integrationConfig.accountCurrency ??
        integrationConfig.currency ??
        nestedIntegration.currency,
    );
    const timezone = assertTimezone(
      assetConfig.accountTimezone ??
        assetConfig.timezone ??
        nestedAsset.timezone ??
        integrationConfig.accountTimezone ??
        integrationConfig.timezone ??
        nestedIntegration.timezone,
    );
    return {
      integrationId: asset.integration.id,
      integrationName: asset.integration.name,
      adAccountAssetId: asset.id,
      adAccountId: normaliseAdAccountId(asset.externalId),
      currency,
      timezone,
    };
  }
}

interface PerformanceBucket {
  externalCampaignId: string;
  label: string;
  campaign: {
    id: string;
    name: string;
    spend: Prisma.Decimal | null;
    startDate: Date | null;
    endDate: Date | null;
  } | null;
  measuredSpend: Prisma.Decimal;
  measuredRevenue: Prisma.Decimal;
  declaredRevenue: Prisma.Decimal;
  impressions: bigint;
  clicks: bigint;
  measuredSaleIds: Set<string>;
  declaredSaleIds: Set<string>;
  observedInAccount: boolean;
}

function getBucket(
  buckets: Map<string, PerformanceBucket>,
  externalCampaignId: string,
  label: string,
  campaign: PerformanceBucket['campaign'],
): PerformanceBucket {
  const existing = buckets.get(externalCampaignId);
  if (existing) {
    if (!existing.campaign && campaign) existing.campaign = campaign;
    return existing;
  }
  const created: PerformanceBucket = {
    externalCampaignId,
    label,
    campaign,
    measuredSpend: new Prisma.Decimal(0),
    measuredRevenue: new Prisma.Decimal(0),
    declaredRevenue: new Prisma.Decimal(0),
    impressions: 0n,
    clicks: 0n,
    measuredSaleIds: new Set(),
    declaredSaleIds: new Set(),
    observedInAccount: false,
  };
  buckets.set(externalCampaignId, created);
  return created;
}

/**
 * A ratio, or an honest reason there is not one.
 *
 * The currency check comes first because it is the only failure that would
 * otherwise produce a *plausible* number: an incomplete window is at least
 * suspicious, but revenue in one currency over spend in another looks exactly
 * like a real ROAS and is a quantity with no unit.
 */
function roasResult(
  revenue: Prisma.Decimal,
  spend: Prisma.Decimal,
  coverageComplete: boolean,
  currencyMismatch: boolean,
): {
  value: string | null;
  status: 'measured' | 'currency_mismatch' | 'incomplete_spend_window' | 'zero_denominator';
} {
  if (currencyMismatch) return { value: null, status: 'currency_mismatch' };
  if (!coverageComplete) return { value: null, status: 'incomplete_spend_window' };
  if (spend.isZero()) return { value: null, status: 'zero_denominator' };
  return { value: revenue.div(spend).toFixed(2), status: 'measured' };
}

/** A YYYY-MM-DD calendar day as the DATE column stores it. */
function calendarDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The inverse: a DATE column back to the YYYY-MM-DD the provider used. */
function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(access_token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
