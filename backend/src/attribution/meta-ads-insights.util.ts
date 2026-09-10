import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type {
  MetaAdsWindow,
  MetaInsightRecord,
  MetaInsightsApiRow,
} from './meta-ads-insights.types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const COUNT_RE = /^(?:0|[1-9]\d*)$/;

/** Syncs are intentionally bounded: an operator can backfill history in chunks. */
export const MAX_META_SYNC_DAYS = 31;
export const MAX_META_REPORT_DAYS = 366;

export function parseDateWindow(
  dateFrom: string,
  dateTo: string,
  maxDays = MAX_META_SYNC_DAYS,
): MetaAdsWindow {
  const from = parseIsoDate(dateFrom, 'dateFrom');
  const to = parseIsoDate(dateTo, 'dateTo');
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException('dateFrom must be on or before dateTo.');
  }
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > maxDays) {
    throw new BadRequestException(`The date window may contain at most ${maxDays} days.`);
  }
  const dates: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dates.push(new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  }
  return { dateFrom, dateTo, dates };
}

export function assertCurrency(value: unknown): string {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BadRequestException('The Meta ad account needs a three-letter account currency.');
  }
  return currency;
}

export function assertTimezone(value: unknown): string {
  const timezone = typeof value === 'string' ? value.trim() : '';
  try {
    if (!timezone) throw new Error('missing');
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new BadRequestException('The Meta ad account needs a valid IANA timezone.');
  }
  return timezone;
}

export function normaliseAdAccountId(value: string): string {
  const id = value.trim().replace(/^act_/i, '');
  if (!/^[1-9]\d{4,31}$/.test(id)) {
    throw new BadRequestException('Meta ad account id must contain 5 to 32 digits.');
  }
  return id;
}

/**
 * Validate a provider row before it can become measured spend. Unknown and
 * malformed numbers are rejected rather than coerced to zero.
 */
export function normaliseInsightRow(
  row: MetaInsightsApiRow,
  context: {
    integrationId: string;
    adAccountAssetId: string;
    adAccountId: string;
    currency: string;
    timezone: string;
    window: MetaAdsWindow;
    fetchedAt: string;
    jobId: string;
  },
): MetaInsightRecord {
  const accountId = normaliseAdAccountId(row.account_id ?? context.adAccountId);
  if (accountId !== context.adAccountId) {
    throw new BadRequestException('Meta returned insights for a different ad account.');
  }
  const currency = assertCurrency(row.account_currency);
  if (currency !== context.currency) {
    throw new BadRequestException(
      `Meta returned ${currency}, but this ad account is configured as ${context.currency}.`,
    );
  }
  const campaignId = (row.campaign_id ?? '').trim();
  if (!/^[1-9]\d{4,63}$/.test(campaignId)) {
    throw new BadRequestException('Meta returned an invalid campaign id.');
  }
  const date = row.date_start ?? '';
  if (!DATE_RE.test(date) || row.date_stop !== date || !context.window.dates.includes(date)) {
    throw new BadRequestException('Meta returned a non-daily or out-of-window insight row.');
  }

  return {
    schemaVersion: 1,
    kind: 'meta_ads.daily_campaign_insight',
    integrationId: context.integrationId,
    adAccountAssetId: context.adAccountAssetId,
    adAccountId: context.adAccountId,
    externalCampaignId: campaignId,
    campaignName: cleanLabel(row.campaign_name),
    date,
    currency,
    timezone: context.timezone,
    spend: decimalString(row.spend, 'spend'),
    impressions: countString(row.impressions, 'impressions'),
    clicks: countString(row.clicks, 'clicks'),
    fetchedAt: context.fetchedAt,
    jobId: context.jobId,
  };
}

export function insightRowKey(row: Pick<MetaInsightRecord, 'date' | 'externalCampaignId'>): string {
  return `${row.date}:${row.externalCampaignId}`;
}

export function insightFingerprint(row: MetaInsightRecord): string {
  return [
    row.date,
    row.externalCampaignId,
    row.currency,
    row.spend,
    row.impressions ?? '',
    row.clicks ?? '',
  ].join('|');
}

export function insightSourceTable(integrationId: string, assetId: string): string {
  return `meta_ads_insights:${integrationId}:${assetId}`;
}

export function coverageSourceTable(integrationId: string, assetId: string): string {
  return `meta_ads_insights_coverage:${integrationId}:${assetId}`;
}

/** UTC bounds corresponding to local midnights in the account timezone. */
export function zonedDateBounds(window: MetaAdsWindow, timezone: string): { gte: Date; lt: Date } {
  const next = new Date(`${window.dateTo}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    gte: zonedMidnightToUtc(window.dateFrom, timezone),
    lt: zonedMidnightToUtc(next.toISOString().slice(0, 10), timezone),
  };
}

export function isInsightRecord(value: unknown): value is MetaInsightRecord {
  const v = value as Partial<MetaInsightRecord> | null;
  return !!v && v.schemaVersion === 1 && v.kind === 'meta_ads.daily_campaign_insight';
}

export function isCoverageRecord(value: unknown): value is { date: string } {
  const v = value as { schemaVersion?: unknown; kind?: unknown; date?: unknown } | null;
  return !!v && v.schemaVersion === 1 && v.kind === 'meta_ads.daily_campaign_insight_coverage' && typeof v.date === 'string';
}

export function decimalOrZero(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value || '0');
}

function parseIsoDate(value: string, field: string): Date {
  if (!DATE_RE.test(value)) throw new BadRequestException(`${field} must be YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} is not a real calendar date.`);
  }
  return parsed;
}

function decimalString(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!MONEY_RE.test(raw)) throw new BadRequestException(`Meta returned invalid ${field}.`);
  const decimal = new Prisma.Decimal(raw);
  if (decimal.isNegative()) throw new BadRequestException(`Meta returned negative ${field}.`);
  return decimal.toFixed();
}

function countString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!COUNT_RE.test(raw)) throw new BadRequestException(`Meta returned invalid ${field}.`);
  return BigInt(raw).toString();
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label ? label.slice(0, 500) : null;
}

function zonedMidnightToUtc(date: string, timezone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  // Two passes are enough to resolve the zone offset around DST boundaries.
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)]),
    );
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += desired - rendered;
  }
  return new Date(guess);
}
