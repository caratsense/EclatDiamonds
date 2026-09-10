#!/usr/bin/env node
/**
 * INT-05 backfill: LegacyRow advertising-spend blobs -> AdSpendDaily / AdSpendCoverage.
 *
 * Measured ad spend used to be stored as JSON in LegacyRow, the untyped table
 * the import pipeline stages raw source rows in. It now has typed models with a
 * Decimal amount, an ISO currency and a unique key. This copies the history
 * across.
 *
 * Three properties this script is built around:
 *
 *   IDEMPOTENT   Every write is an upsert on the natural key, so running it
 *                twice produces the same rows. Interrupt it and re-run it.
 *   NON-DESTRUCTIVE
 *                The LegacyRow blobs are left exactly where they are. Nothing is
 *                deleted, so a bad backfill is re-runnable rather than fatal.
 *   HONEST ABOUT WHAT IT COULD NOT READ
 *                A blob that fails validation is counted and located (source
 *                table and row key), never coerced into a zero and never
 *                silently skipped. Refusing to guess a number is the whole point
 *                of moving this out of a JSON column.
 *
 * Usage:
 *   node scripts/backfill-ad-spend.mjs              # dry run, reports only
 *   node scripts/backfill-ad-spend.mjs --apply      # writes
 *   node scripts/backfill-ad-spend.mjs --apply --organisation <id>
 */
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const orgFlag = process.argv.indexOf('--organisation');
const ORGANISATION = orgFlag > -1 ? process.argv[orgFlag + 1] : null;

const SPEND_PREFIX = 'meta_ads_insights:';
const COVERAGE_PREFIX = 'meta_ads_insights_coverage:';
const PAGE = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const COUNT_RE = /^(?:0|[1-9]\d*)$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ID_RE = /^[1-9]\d{4,63}$/;

const prisma = new PrismaClient();

/** A blob is usable only if every field a money row depends on is present and well formed. */
function validSpend(d) {
  return (
    d &&
    d.schemaVersion === 1 &&
    d.kind === 'meta_ads.daily_campaign_insight' &&
    typeof d.integrationId === 'string' && d.integrationId &&
    typeof d.adAccountAssetId === 'string' && d.adAccountAssetId &&
    typeof d.adAccountId === 'string' && d.adAccountId &&
    typeof d.externalCampaignId === 'string' && ID_RE.test(d.externalCampaignId) &&
    typeof d.date === 'string' && DATE_RE.test(d.date) &&
    typeof d.currency === 'string' && CURRENCY_RE.test(d.currency) &&
    typeof d.timezone === 'string' && d.timezone &&
    typeof d.spend === 'string' && MONEY_RE.test(d.spend) &&
    (d.impressions == null || COUNT_RE.test(String(d.impressions))) &&
    (d.clicks == null || COUNT_RE.test(String(d.clicks)))
  );
}

function validCoverage(d) {
  return (
    d &&
    d.schemaVersion === 1 &&
    d.kind === 'meta_ads.daily_campaign_insight_coverage' &&
    typeof d.integrationId === 'string' && d.integrationId &&
    typeof d.adAccountAssetId === 'string' && d.adAccountAssetId &&
    typeof d.adAccountId === 'string' && d.adAccountId &&
    typeof d.date === 'string' && DATE_RE.test(d.date) &&
    typeof d.currency === 'string' && CURRENCY_RE.test(d.currency) &&
    typeof d.timezone === 'string' && d.timezone
  );
}

const day = (s) => new Date(`${s}T00:00:00.000Z`);

async function* pages(prefix) {
  let cursor = null;
  for (;;) {
    const batch = await prisma.legacyRow.findMany({
      where: {
        sourceTable: { startsWith: prefix },
        ...(ORGANISATION ? { organisationId: ORGANISATION } : {}),
      },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, organisationId: true, sourceTable: true, rowKey: true, data: true, syncedAt: true },
    });
    if (!batch.length) return;
    yield batch;
    cursor = batch[batch.length - 1].id;
  }
}

/** Integration rows that still exist. A blob pointing at a deleted one cannot be filed. */
const knownIntegrations = new Map();
async function integrationExists(organisationId, integrationId) {
  const key = `${organisationId}:${integrationId}`;
  if (!knownIntegrations.has(key)) {
    const row = await prisma.integration.findFirst({
      where: { id: integrationId, organisationId },
      select: { id: true },
    });
    knownIntegrations.set(key, Boolean(row));
  }
  return knownIntegrations.get(key);
}

async function run() {
  const report = {
    spend: { scanned: 0, written: 0, invalid: 0, orphaned: 0 },
    coverage: { scanned: 0, written: 0, invalid: 0, orphaned: 0 },
    rejected: [],
  };
  const note = (kind, row, reason) => {
    report[kind].invalid += 1;
    if (report.rejected.length < 50) {
      // Location only. The value that failed validation is not reprinted: these
      // blobs are provider data and this report gets pasted into tickets.
      report.rejected.push({ kind, sourceTable: row.sourceTable, rowKey: row.rowKey, reason });
    }
  };

  for await (const batch of pages(COVERAGE_PREFIX)) {
    for (const row of batch) {
      report.coverage.scanned += 1;
      const d = row.data;
      if (!validCoverage(d)) { note('coverage', row, 'unreadable or incomplete coverage blob'); continue; }
      if (!(await integrationExists(row.organisationId, d.integrationId))) {
        report.coverage.orphaned += 1; continue;
      }
      if (APPLY) {
        await prisma.adSpendCoverage.upsert({
          where: {
            organisationId_adAccountAssetId_date: {
              organisationId: row.organisationId,
              adAccountAssetId: d.adAccountAssetId,
              date: day(d.date),
            },
          },
          create: {
            organisationId: row.organisationId,
            integrationId: d.integrationId,
            adAccountAssetId: d.adAccountAssetId,
            externalAccountId: d.adAccountId,
            date: day(d.date),
            timezone: d.timezone,
            currency: d.currency,
            completedAt: d.completedAt ? new Date(d.completedAt) : (row.syncedAt ?? new Date()),
            jobId: typeof d.jobId === 'string' ? d.jobId : 'backfill',
          },
          update: {
            timezone: d.timezone,
            currency: d.currency,
            completedAt: d.completedAt ? new Date(d.completedAt) : (row.syncedAt ?? new Date()),
          },
        });
      }
      report.coverage.written += 1;
    }
  }

  for await (const batch of pages(SPEND_PREFIX)) {
    for (const row of batch) {
      // The coverage prefix also starts with the spend prefix, so skip those.
      if (row.sourceTable.startsWith(COVERAGE_PREFIX)) continue;
      report.spend.scanned += 1;
      const d = row.data;
      if (!validSpend(d)) { note('spend', row, 'unreadable or incomplete spend blob'); continue; }
      if (!(await integrationExists(row.organisationId, d.integrationId))) {
        report.spend.orphaned += 1; continue;
      }
      if (APPLY) {
        await prisma.adSpendDaily.upsert({
          where: {
            organisationId_adAccountAssetId_date_externalCampaignId: {
              organisationId: row.organisationId,
              adAccountAssetId: d.adAccountAssetId,
              date: day(d.date),
              externalCampaignId: d.externalCampaignId,
            },
          },
          create: {
            organisationId: row.organisationId,
            integrationId: d.integrationId,
            adAccountAssetId: d.adAccountAssetId,
            externalAccountId: d.adAccountId,
            externalCampaignId: d.externalCampaignId,
            campaignName: typeof d.campaignName === 'string' ? d.campaignName : null,
            date: day(d.date),
            timezone: d.timezone,
            currency: d.currency,
            spend: d.spend,
            impressions: d.impressions == null ? null : BigInt(d.impressions),
            clicks: d.clicks == null ? null : BigInt(d.clicks),
            fetchedAt: d.fetchedAt ? new Date(d.fetchedAt) : (row.syncedAt ?? new Date()),
            jobId: typeof d.jobId === 'string' ? d.jobId : 'backfill',
          },
          update: {
            campaignName: typeof d.campaignName === 'string' ? d.campaignName : null,
            timezone: d.timezone,
            currency: d.currency,
            spend: d.spend,
            impressions: d.impressions == null ? null : BigInt(d.impressions),
            clicks: d.clicks == null ? null : BigInt(d.clicks),
            fetchedAt: d.fetchedAt ? new Date(d.fetchedAt) : (row.syncedAt ?? new Date()),
          },
        });
      }
      report.spend.written += 1;
    }
  }

  console.log(APPLY ? 'ad-spend backfill: APPLIED' : 'ad-spend backfill: DRY RUN (pass --apply to write)');
  console.log(`  spend    scanned=${report.spend.scanned} written=${report.spend.written} invalid=${report.spend.invalid} orphaned=${report.spend.orphaned}`);
  console.log(`  coverage scanned=${report.coverage.scanned} written=${report.coverage.written} invalid=${report.coverage.invalid} orphaned=${report.coverage.orphaned}`);
  if (report.rejected.length) {
    console.log(`  rejected rows (first ${report.rejected.length}):`);
    for (const r of report.rejected) console.log(`    [${r.kind}] ${r.sourceTable} / ${r.rowKey}: ${r.reason}`);
  }
  if (report.spend.orphaned || report.coverage.orphaned) {
    console.log('  orphaned rows point at an Integration that no longer exists; they are left in LegacyRow.');
  }
  console.log('  LegacyRow blobs are left in place. Re-running this script is safe.');
  return report;
}

run()
  .catch((err) => {
    console.error(`ad-spend backfill failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
