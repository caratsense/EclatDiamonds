import { BadRequestException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/auth-user';
import {
  META_ADS_INSIGHTS_JOB,
  MetaAdsInsightsService,
} from '../src/attribution/meta-ads-insights.service';
import {
  parseDateWindow,
  zonedDateBounds,
} from '../src/attribution/meta-ads-insights.util';
import { MetaGraphClient } from '../src/integrations/meta-graph.client';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * INT-05 and INT-06 - measured advertising spend, and a ROAS that refuses to be
 * a number when it cannot be one.
 *
 * These tests run against a real database, which is the point of the change
 * they cover: spend used to be JSON in LegacyRow, so replay safety, the Decimal
 * type and the currency were application conventions with nothing underneath
 * them. Now they are a unique index, a DECIMAL column and a CHECK, and only a
 * real database can prove that.
 */

const A = {
  org: 'org_ad_spend_a',
  slug: 'ad-spend-a',
  store: 'store_ad_spend_a',
  integ: 'int_ad_spend_a',
  asset: 'asset_ad_spend_a',
  account: '1234567890',
};
const B = {
  org: 'org_ad_spend_b',
  slug: 'ad-spend-b',
  store: 'store_ad_spend_b',
  integ: 'int_ad_spend_b',
  asset: 'asset_ad_spend_b',
  account: '2234567890',
};

/** A tenant whose own currency differs from its ad account's. */
const C = {
  org: 'org_ad_spend_c',
  slug: 'ad-spend-c',
  store: 'store_ad_spend_c',
  integ: 'int_ad_spend_c',
  asset: 'asset_ad_spend_c',
  account: '3234567890',
};

class FakeGraph {
  calls: Array<{ path: string; query: Record<string, string> }> = [];
  responses: Array<unknown> = [];

  async getForIntegration(
    _organisationId: string,
    _integrationId: string,
    path: string,
    query: Record<string, string>,
  ) {
    this.calls.push({ path, query });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return (next ?? { data: [] }) as never;
  }
}

/** Real User rows, so the audit trail's actor foreign key resolves. */
const userIds: Record<string, string> = {};

function principal(org: string, over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: userIds[org],
    name: 'Head Office',
    email: `ho@${org}.local`,
    role: Role.head_office,
    organisationId: org,
    storeIds: [A.store],
    allStores: true,
    ...over,
  };
}

function insight(campaignId: string, date: string, spend: string, name: string, over = {}) {
  return {
    account_id: A.account,
    account_currency: 'INR',
    campaign_id: campaignId,
    campaign_name: name,
    date_start: date,
    date_stop: date,
    spend,
    impressions: '1000',
    clicks: '10',
    ...over,
  };
}

describe('INT-05/06 measured ad spend and currency-safe ROAS (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: MetaAdsInsightsService;
  const graph = new FakeGraph();

  const ingest = (org: string, integ: string, asset: string, from: string, to: string, jobId: string) =>
    service.ingestWindow(org, { integrationId: integ, adAccountAssetId: asset, dateFrom: from, dateTo: to }, jobId);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MetaGraphClient)
      .useValue(graph)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    service = app.get(MetaAdsInsightsService);

    await teardown(prisma);
    const tenant = async (t: typeof A, currency: string, accountCurrency: string) => {
      await prisma.organisation.create({
        data: { id: t.org, name: t.slug, slug: t.slug, industryPackCode: 'retail', currency },
      });
      await prisma.store.create({
        data: { id: t.store, name: 'Main', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: t.org },
      });
      await prisma.integration.create({
        data: { id: t.integ, organisationId: t.org, providerCode: 'meta_ads', name: 'Meta', status: 'connected' },
      });
      userIds[t.org] = (
        await prisma.user.create({
          data: {
            email: `ho@${t.slug}.local`, name: 'Head Office', role: 'head_office',
            passwordHash: 'x', isActive: true, approvalStatus: 'approved', organisationId: t.org,
            userStores: { create: { storeId: t.store, isPrimary: true } },
          },
        })
      ).id;
      await prisma.integrationAsset.create({
        data: {
          id: t.asset, organisationId: t.org, integrationId: t.integ, kind: 'ad_account',
          externalId: t.account, isActive: true,
          metadata: { accountCurrency, accountTimezone: 'Asia/Kolkata' },
        },
      });
    };
    await tenant(A, 'INR', 'INR');
    await tenant(B, 'INR', 'INR');
    // Tenant C bills in INR but runs a USD ad account. That is the currency
    // mismatch INT-06 exists for, and it is a normal thing for a business to do.
    await tenant(C, 'INR', 'USD');
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  beforeEach(async () => {
    graph.calls = [];
    graph.responses = [];
    for (const t of [A, B, C]) {
      await prisma.adSpendDaily.deleteMany({ where: { organisationId: t.org } });
      await prisma.adSpendCoverage.deleteMany({ where: { organisationId: t.org } });
    }
  });

  // -------------------------------------------------------------------
  // Window arithmetic (pure)
  // -------------------------------------------------------------------

  it('bounds and validates account-local calendar windows', () => {
    expect(parseDateWindow('2026-02-27', '2026-03-01').dates).toEqual([
      '2026-02-27', '2026-02-28', '2026-03-01',
    ]);
    expect(() => parseDateWindow('2026-02-30', '2026-03-01')).toThrow(BadRequestException);
    expect(() => parseDateWindow('2026-04-01', '2026-03-01')).toThrow(/on or before/);
    expect(() => parseDateWindow('2026-01-01', '2026-02-01')).toThrow(/at most 31/);

    const bounds = zonedDateBounds(parseDateWindow('2026-09-01', '2026-09-01'), 'Asia/Kolkata');
    expect(bounds.gte.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(bounds.lt.toISOString()).toBe('2026-09-01T18:30:00.000Z');
  });

  // -------------------------------------------------------------------
  // Scheduling and tenancy
  // -------------------------------------------------------------------

  it('queues a tenant-scoped retryable job and audits only non-secret setup facts', async () => {
    const result = await service.schedule(principal(A.org), {
      integrationId: A.integ, adAccountAssetId: A.asset, dateFrom: '2026-09-01', dateTo: '2026-09-02',
    });

    expect(result).toMatchObject({ queued: true, currency: 'INR', timezone: 'Asia/Kolkata' });
    const job = await prisma.jobTask.findFirst({
      where: { organisationId: A.org, kind: META_ADS_INSIGHTS_JOB },
      orderBy: { createdAt: 'desc' },
    });
    expect(job).not.toBeNull();
    expect(job!.maxAttempts).toBe(5);
    expect(job!.idempotencyKey).toContain(`${A.org}:${A.integ}:${A.asset}`);

    const audits = await prisma.auditLog.findMany({
      where: { organisationId: A.org, action: 'meta_ads.insights_sync_queued' },
    });
    expect(audits.length).toBeGreaterThan(0);
    // The external account id and anything token-shaped stay out of the trail.
    expect(JSON.stringify(audits)).not.toContain(A.account);
    expect(JSON.stringify(audits)).not.toMatch(/access[_-]?token/i);
  });

  it('refuses an integration or ad-account asset owned by another tenant', async () => {
    await expect(
      service.schedule(principal(B.org), {
        integrationId: A.integ, adAccountAssetId: A.asset, dateFrom: '2026-09-01', dateTo: '2026-09-01',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(graph.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // INT-05 - typed, replay-safe storage
  // -------------------------------------------------------------------

  it('stores spend as a typed row, not a JSON blob in the import landing table', async () => {
    graph.responses = [{ data: [insight('70001', '2026-09-01', '100.25', 'Campaign A')] }];
    await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-typed');

    const row = await prisma.adSpendDaily.findFirstOrThrow({ where: { organisationId: A.org } });
    expect(row.spend).toBeInstanceOf(Prisma.Decimal);
    expect(row.spend.toFixed(2)).toBe('100.25');
    expect(row.currency).toBe('INR');
    expect(row.date.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(row.impressions).toBe(1000n);
    expect(row.externalAccountId).toBe(A.account);

    // LegacyRow is the import staging table. Money no longer lands there.
    expect(
      await prisma.legacyRow.count({
        where: { organisationId: A.org, sourceTable: { startsWith: 'meta_ads_insights' } },
      }),
    ).toBe(0);
  });

  it('follows only opaque cursors and upserts duplicate provider rows exactly once', async () => {
    const first = insight('70001', '2026-09-01', '100.25', 'Campaign A');
    graph.responses = [
      {
        data: [first, { ...first }],
        paging: { cursors: { after: 'opaque-cursor-2' }, next: 'https://not-followed.example/page' },
      },
      { data: [insight('70002', '2026-09-02', '50.75', 'Campaign B')] },
    ];

    const result = await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-02', 'job-pages');

    expect(result).toMatchObject({ pages: 2, providerRows: 3, uniqueRows: 2, coverageComplete: true });
    expect(graph.calls[1].query.after).toBe('opaque-cursor-2');
    expect(JSON.stringify(graph.calls)).not.toContain('not-followed.example');
    expect(await prisma.adSpendDaily.count({ where: { organisationId: A.org } })).toBe(2);
    expect(await prisma.adSpendCoverage.count({ where: { organisationId: A.org } })).toBe(2);
  });

  it('is replay-safe: re-running a window updates spend rather than adding to it', async () => {
    graph.responses = [{ data: [insight('70001', '2026-09-01', '100.00', 'A')] }];
    await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-1');

    graph.responses = [{ data: [insight('70001', '2026-09-01', '140.00', 'A renamed')] }];
    await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-2');

    const rows = await prisma.adSpendDaily.findMany({ where: { organisationId: A.org } });
    expect(rows).toHaveLength(1);
    // 140, not 240. The unique key is what makes that a database guarantee.
    expect(rows[0].spend.toFixed(2)).toBe('140.00');
    expect(rows[0].campaignName).toBe('A renamed');
  });

  it('refuses a second row for the same account, day and campaign at the database level', async () => {
    graph.responses = [{ data: [insight('70001', '2026-09-01', '10.00', 'A')] }];
    await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-unique');
    const existing = await prisma.adSpendDaily.findFirstOrThrow({ where: { organisationId: A.org } });

    await expect(
      prisma.adSpendDaily.create({
        data: {
          organisationId: A.org, integrationId: A.integ, adAccountAssetId: A.asset,
          externalAccountId: A.account, externalCampaignId: existing.externalCampaignId,
          date: existing.date, timezone: 'Asia/Kolkata', currency: 'INR', spend: '99.00',
          fetchedAt: new Date(), jobId: 'manual',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a lowercase currency code, so a total cannot silently split in two', async () => {
    await expect(
      prisma.adSpendDaily.create({
        data: {
          organisationId: A.org, integrationId: A.integ, adAccountAssetId: A.asset,
          externalAccountId: A.account, externalCampaignId: '70009',
          date: new Date('2026-09-05T00:00:00.000Z'), timezone: 'Asia/Kolkata',
          currency: 'inr', spend: '1.00', fetchedAt: new Date(), jobId: 'manual',
        },
      }),
    ).rejects.toThrow(/currency_iso_check/);
  });

  it('makes a partial failure unreportable, then retries without double-counting', async () => {
    graph.responses = [
      {
        data: [insight('70001', '2026-09-01', '100', 'Campaign A')],
        paging: { cursors: { after: 'page-two' }, next: 'present' },
      },
      new Error('provider failed access_token=do-not-retain'),
    ];
    await expect(ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-02', 'job-partial')).rejects.toThrow(
      /provider failed/,
    );
    expect(await prisma.adSpendDaily.count({ where: { organisationId: A.org } })).toBe(1);
    // No coverage: a window nobody finished cannot be reported on.
    expect(await prisma.adSpendCoverage.count({ where: { organisationId: A.org } })).toBe(0);
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: A.integ } });
    expect(integration.lastError).toBe('provider failed access_token=[redacted]');

    const incomplete = await service.performance(principal(A.org), {
      integrationId: A.integ, adAccountAssetId: A.asset,
      dateFrom: '2026-09-01', dateTo: '2026-09-02', model: 'last_touch',
    });
    expect(incomplete.coverage.complete).toBe(false);
    expect(incomplete.totals.measuredRoas).toBeNull();
    expect(incomplete.totals.measuredRoasStatus).toBe('incomplete_spend_window');

    graph.responses = [
      { data: [insight('70001', '2026-09-01', '100', 'A'), insight('70002', '2026-09-02', '50', 'B')] },
    ];
    await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-02', 'job-partial-retry');
    expect(await prisma.adSpendDaily.count({ where: { organisationId: A.org } })).toBe(2);
    expect(await prisma.adSpendCoverage.count({ where: { organisationId: A.org } })).toBe(2);
  });

  it('rejects conflicting duplicates and repeated cursors instead of choosing arbitrarily', async () => {
    graph.responses = [
      { data: [insight('70001', '2026-09-01', '100', 'A'), insight('70001', '2026-09-01', '101', 'A')] },
    ];
    await expect(
      ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-conflict'),
    ).rejects.toThrow(/conflicting duplicates/);

    graph.responses = [
      { data: [], paging: { cursors: { after: 'same' }, next: 'present' } },
      { data: [], paging: { cursors: { after: 'same' }, next: 'present' } },
    ];
    await expect(
      ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-cursor-loop'),
    ).rejects.toThrow(/repeated pagination cursor/);
  });

  it('removes stale in-window rows only after a complete provider traversal', async () => {
    graph.responses = [
      { data: [insight('70001', '2026-09-01', '100', 'A'), insight('79999', '2026-09-01', '20', 'Old')] },
    ];
    await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-old');

    graph.responses = [{ data: [insight('70001', '2026-09-01', '110', 'A')] }];
    const refreshed = await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-new');

    // The retired campaign is gone, not carried forward as a phantom denominator.
    expect(refreshed.staleRowsRemoved).toBe(1);
    const rows = await prisma.adSpendDaily.findMany({ where: { organisationId: A.org } });
    expect(rows.map((r) => r.externalCampaignId)).toEqual(['70001']);
  });

  it('refuses currency, account and day mismatches as untrusted provider data', async () => {
    for (const bad of [
      insight('70001', '2026-09-01', '1', 'A', { account_currency: 'USD' }),
      insight('70001', '2026-09-01', '1', 'A', { account_id: '9876543210' }),
      insight('70001', '2026-09-03', '1', 'A'),
    ]) {
      graph.responses = [{ data: [bad] }];
      await expect(
        ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-bad'),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(await prisma.adSpendDaily.count({ where: { organisationId: A.org } })).toBe(0);
  });

  // -------------------------------------------------------------------
  // Reporting, and INT-06 currency safety
  // -------------------------------------------------------------------

  describe('reporting', () => {
    beforeEach(async () => {
      await prisma.attributionTouch.deleteMany({ where: { organisationId: { in: [A.org, C.org] } } });
      await prisma.sale.deleteMany({ where: { organisationId: { in: [A.org, C.org] } } });
      await prisma.marketingCampaign.deleteMany({ where: { organisationId: { in: [A.org, C.org] } } });
    });

    async function revenue(
      org: string,
      store: string,
      externalCampaignId: string,
      amounts: Array<{ total: string; evidence: 'measured' | 'declared' }>,
    ) {
      const campaign = await prisma.marketingCampaign.create({
        data: {
          organisationId: org, name: `Campaign ${externalCampaignId}`, type: 'digital',
          provider: 'meta_ads', externalCampaignId, spend: '999.00',
        },
      });
      let n = 0;
      for (const amount of amounts) {
        n += 1;
        const sale = await prisma.sale.create({
          data: {
            organisationId: org, storeId: store, docNo: `INV-${externalCampaignId}-${n}`,
            docDate: new Date('2026-09-01T06:00:00.000Z'), totalAmount: amount.total,
          },
        });
        await prisma.attributionTouch.create({
          data: {
            organisationId: org, channel: 'ads', externalCampaignId, campaignId: campaign.id,
            evidence: amount.evidence, saleId: sale.id, creditModel: 'both',
          },
        });
      }
      return campaign;
    }

    it('computes only measured ROAS while keeping declared revenue and spend separate', async () => {
      await revenue(A.org, A.store, '70001', [
        { total: '300.00', evidence: 'measured' },
        { total: '400.00', evidence: 'declared' },
      ]);
      graph.responses = [{ data: [insight('70001', '2026-09-01', '100', 'Campaign A')] }];
      await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-roas');

      const report = await service.performance(principal(A.org, { allStores: false, storeIds: [A.store] }), {
        integrationId: A.integ, adAccountAssetId: A.asset,
        dateFrom: '2026-09-01', dateTo: '2026-09-01', model: 'first_touch',
      });

      expect(report.coverage.complete).toBe(true);
      expect(report.currencies).toMatchObject({ spend: 'INR', revenue: 'INR', mismatch: false, foreignSpend: [] });
      expect(report.rows[0]).toMatchObject({
        measuredSpend: '100.00',
        declaredCampaignSpend: '999.00',
        declaredSpendScope: 'campaign_lifetime_not_windowed',
        measuredRevenue: '300.00',
        declaredRevenue: '400.00',
        measuredRoas: '3.00',
        measuredRoasStatus: 'measured',
      });
      expect(report.totals).toMatchObject({
        measuredSpendCurrency: 'INR',
        measuredRevenueCurrency: 'INR',
        currencyMismatch: false,
      });
    });

    it('uses explicit zero-denominator semantics on a fully covered zero-spend day', async () => {
      graph.responses = [{ data: [] }];
      await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-zero');

      const report = await service.performance(principal(A.org), {
        integrationId: A.integ, adAccountAssetId: A.asset,
        dateFrom: '2026-09-01', dateTo: '2026-09-01', model: 'last_touch',
      });

      expect(report.coverage.complete).toBe(true);
      expect(report.totals).toMatchObject({
        measuredSpend: '0.00', measuredRoas: null, measuredRoasStatus: 'zero_denominator',
      });
    });

    it('never divides revenue in one currency by spend in another', async () => {
      // Tenant C bills in INR; its ad account bills in USD.
      await revenue(C.org, C.store, '80001', [{ total: '90000.00', evidence: 'measured' }]);
      graph.responses = [
        {
          data: [
            {
              account_id: C.account, account_currency: 'USD', campaign_id: '80001',
              campaign_name: 'US campaign', date_start: '2026-09-01', date_stop: '2026-09-01',
              spend: '500.00', impressions: '10', clicks: '1',
            },
          ],
        },
      ];
      await ingest(C.org, C.integ, C.asset, '2026-09-01', '2026-09-01', 'job-usd');

      const report = await service.performance(principal(C.org, { storeIds: [C.store] }), {
        integrationId: C.integ, adAccountAssetId: C.asset,
        dateFrom: '2026-09-01', dateTo: '2026-09-01', model: 'last_touch',
      });

      // The window IS fully covered and the denominator IS positive. The only
      // reason there is no ratio is that 90000 INR over 500 USD has no unit.
      expect(report.coverage.complete).toBe(true);
      expect(report.totals.measuredSpend).toBe('500.00');
      expect(report.totals.measuredRevenue).toBe('90000.00');
      expect(report.totals.measuredRoas).toBeNull();
      expect(report.totals.measuredRoasStatus).toBe('currency_mismatch');
      expect(report.totals.currencyMismatch).toBe(true);
      // Both sides are labelled, so a reader can see what would have to be
      // converted and by whom. Nothing here converts anything.
      expect(report.currencies).toMatchObject({ spend: 'USD', revenue: 'INR', mismatch: true });
      expect(report.rows[0]).toMatchObject({ measuredRoas: null, measuredRoasStatus: 'currency_mismatch' });
      expect(report.note).toMatch(/No currency conversion is performed/);
    });

    it('surfaces spend stored under a foreign currency instead of dropping it', async () => {
      graph.responses = [{ data: [insight('70001', '2026-09-01', '100', 'A')] }];
      await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-mixed');
      // An account reconfigured partway through history leaves days behind in
      // the old currency. Those used to be dropped by a bare `continue`, while
      // coverage was not currency-checked at all -- so the report claimed a
      // complete window over a denominator that had quietly lost a day.
      await prisma.adSpendDaily.create({
        data: {
          organisationId: A.org, integrationId: A.integ, adAccountAssetId: A.asset,
          externalAccountId: A.account, externalCampaignId: '70002',
          date: new Date('2026-09-01T00:00:00.000Z'), timezone: 'Asia/Kolkata',
          currency: 'USD', spend: '7.00', fetchedAt: new Date(), jobId: 'legacy-usd',
        },
      });

      const report = await service.performance(principal(A.org), {
        integrationId: A.integ, adAccountAssetId: A.asset,
        dateFrom: '2026-09-01', dateTo: '2026-09-01', model: 'last_touch',
      });

      expect(report.totals.measuredSpend).toBe('100.00');
      expect(report.totals.currencyMismatch).toBe(true);
      expect(report.totals.measuredRoas).toBeNull();
      expect(report.totals.measuredRoasStatus).toBe('currency_mismatch');
      expect(report.currencies.foreignSpend).toEqual([{ currency: 'USD', measuredSpend: '7.00' }]);
    });

    it('counts a day covered in another currency as not covered', async () => {
      await prisma.adSpendCoverage.create({
        data: {
          organisationId: A.org, integrationId: A.integ, adAccountAssetId: A.asset,
          externalAccountId: A.account, date: new Date('2026-09-01T00:00:00.000Z'),
          timezone: 'Asia/Kolkata', currency: 'USD', completedAt: new Date(), jobId: 'legacy-usd',
        },
      });

      const report = await service.performance(principal(A.org), {
        integrationId: A.integ, adAccountAssetId: A.asset,
        dateFrom: '2026-09-01', dateTo: '2026-09-01', model: 'last_touch',
      });

      // Covered in USD is not covered in INR. Partial coverage stays visible.
      expect(report.coverage.complete).toBe(false);
      expect(report.coverage.missingDates).toEqual(['2026-09-01']);
    });

    it('never reads another tenant spend into this tenant report', async () => {
      graph.responses = [{ data: [insight('70001', '2026-09-01', '100', 'A')] }];
      await ingest(A.org, A.integ, A.asset, '2026-09-01', '2026-09-01', 'job-iso');

      const report = await service.performance(principal(B.org, { storeIds: [B.store] }), {
        integrationId: B.integ, adAccountAssetId: B.asset,
        dateFrom: '2026-09-01', dateTo: '2026-09-01', model: 'last_touch',
      });
      expect(report.totals.measuredSpend).toBe('0.00');
      expect(report.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // INT-05 backfill
  // -------------------------------------------------------------------

  describe('LegacyRow backfill', () => {
    const SOURCE = `meta_ads_insights:${A.integ}:${A.asset}`;
    const COVERAGE = `meta_ads_insights_coverage:${A.integ}:${A.asset}`;

    const runBackfill = (apply: boolean) =>
      execFileSync(
        process.execPath,
        [join(__dirname, '..', 'scripts', 'backfill-ad-spend.mjs'), ...(apply ? ['--apply'] : []), '--organisation', A.org],
        { cwd: join(__dirname, '..'), env: process.env, encoding: 'utf8' },
      );

    beforeAll(async () => {
      await prisma.legacyRow.deleteMany({ where: { organisationId: A.org } });
      const base = {
        schemaVersion: 1, kind: 'meta_ads.daily_campaign_insight',
        integrationId: A.integ, adAccountAssetId: A.asset, adAccountId: A.account,
        currency: 'INR', timezone: 'Asia/Kolkata', fetchedAt: '2026-09-02T00:00:00.000Z', jobId: 'historic',
      };
      await prisma.legacyRow.createMany({
        data: [
          {
            organisationId: A.org, sourceTable: SOURCE, rowKey: '2026-08-01:70001',
            data: { ...base, externalCampaignId: '70001', campaignName: 'Old A', date: '2026-08-01', spend: '11.50', impressions: '5', clicks: '1' },
            syncedAt: new Date('2026-08-02T00:00:00.000Z'),
          },
          {
            organisationId: A.org, sourceTable: SOURCE, rowKey: '2026-08-02:70001',
            data: { ...base, externalCampaignId: '70001', campaignName: 'Old A', date: '2026-08-02', spend: '12.50', impressions: null, clicks: null },
            syncedAt: new Date('2026-08-03T00:00:00.000Z'),
          },
          {
            // Unreadable: no spend. Counted and located, never coerced to zero.
            organisationId: A.org, sourceTable: SOURCE, rowKey: '2026-08-03:70001',
            data: { ...base, externalCampaignId: '70001', date: '2026-08-03' },
            syncedAt: new Date('2026-08-04T00:00:00.000Z'),
          },
          {
            organisationId: A.org, sourceTable: COVERAGE, rowKey: '2026-08-01',
            data: {
              schemaVersion: 1, kind: 'meta_ads.daily_campaign_insight_coverage',
              integrationId: A.integ, adAccountAssetId: A.asset, adAccountId: A.account,
              date: '2026-08-01', currency: 'INR', timezone: 'Asia/Kolkata',
              completedAt: '2026-08-02T00:00:00.000Z', jobId: 'historic',
            },
            syncedAt: new Date('2026-08-02T00:00:00.000Z'),
          },
        ],
      });
    });

    afterAll(async () => {
      await prisma.legacyRow.deleteMany({ where: { organisationId: A.org } });
    });

    it('reports what it would do without writing anything', async () => {
      const out = runBackfill(false);

      expect(out).toContain('DRY RUN');
      expect(out).toMatch(/spend\s+scanned=3 written=2 invalid=1/);
      expect(out).toMatch(/coverage scanned=1 written=1 invalid=0/);
      // The row it could not read is located, and its unreadable value is not
      // reprinted into a report that gets pasted into tickets.
      expect(out).toContain('2026-08-03:70001');
      expect(out).not.toContain('do-not-print');
      expect(await prisma.adSpendDaily.count({ where: { organisationId: A.org } })).toBe(0);
    });

    it('copies the readable rows, and re-running changes nothing', async () => {
      runBackfill(true);
      const first = await prisma.adSpendDaily.findMany({
        where: { organisationId: A.org }, orderBy: { date: 'asc' },
      });
      expect(first).toHaveLength(2);
      expect(first[0].spend.toFixed(2)).toBe('11.50');
      expect(first[0].date.toISOString().slice(0, 10)).toBe('2026-08-01');
      expect(first[1].impressions).toBeNull();
      expect(await prisma.adSpendCoverage.count({ where: { organisationId: A.org } })).toBe(1);

      runBackfill(true);
      const second = await prisma.adSpendDaily.findMany({
        where: { organisationId: A.org }, orderBy: { date: 'asc' },
      });
      expect(second).toHaveLength(2);
      expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
      expect(second[0].spend.toFixed(2)).toBe('11.50');

      // Non-destructive: the source blobs are still there to re-read.
      expect(await prisma.legacyRow.count({ where: { organisationId: A.org } })).toBe(4);
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const t of [A, B, C]) {
    await prisma.adSpendDaily.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.adSpendCoverage.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.attributionTouch.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.sale.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.marketingCampaign.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.legacyRow.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.jobTask.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.integrationAsset.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.userStore.deleteMany({ where: { store: { organisationId: t.org } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.integration.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.organisation.deleteMany({ where: { id: t.org } }).catch(() => undefined);
  }
}
