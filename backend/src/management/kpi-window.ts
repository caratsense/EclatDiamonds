import { BadRequestException } from '@nestjs/common';

import { DEFAULT_TZ, instantFromLocalTime, resolveTz, zonedParts } from '../common/tz.util';

/**
 * The window a management figure covers, and which clock decided it.
 *
 * ## Why this is its own file
 *
 * Every number on the management dashboard is "how many, between these two
 * instants". Get the instants wrong and every figure is wrong together, in a way
 * that looks plausible: a month that starts at UTC midnight is five and a half
 * hours short in India, so the 1st of the month quietly loses its early sales to
 * the previous month and nobody can see why the totals do not match the till.
 *
 * ## The multi-timezone problem, stated rather than hidden
 *
 * A single branch has one obvious answer: its own clock. An organisation-wide
 * report across branches in different timezones has NO correct single answer —
 * "yesterday" genuinely began at different instants in each. The choices are to
 * refuse, to pick one silently, or to pick one and say so.
 *
 * Refusing makes the most useful screen in the product unavailable to exactly
 * the person it was built for. Picking silently produces a number that is right
 * for one branch and wrong for the others with nothing to indicate it. So: the
 * caller may name a timezone; otherwise, when every branch in scope shares one,
 * that one is used; otherwise the organisation's own timezone is used and
 * `ambiguous` is set with the distinct zones listed, for the screen to show.
 */

export interface KpiWindow {
  from: Date;
  to: Date;
  /** The IANA zone the boundaries were computed in. */
  timezone: string;
  /** True when branches in scope disagree and one had to be chosen. */
  ambiguous: boolean;
  /** The distinct zones in scope, when ambiguous. */
  zonesInScope: string[];
  /** How the zone was arrived at, so a screen can explain itself. */
  resolvedBy: 'requested' | 'single_store' | 'organisation_default';
  /** yyyy-mm-dd, inclusive, as the caller asked for them. */
  fromDate: string;
  toDate: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The longest window a single request may ask for. Two years of daily rows. */
const MAX_DAYS = 731;

export function resolveKpiWindow(input: {
  from?: string;
  to?: string;
  requestedTimezone?: string;
  /** Distinct timezones of the branches in the caller's scope. */
  storeTimezones: (string | null | undefined)[];
  organisationTimezone?: string | null;
  now?: Date;
}): KpiWindow {
  const distinct = [
    ...new Set(input.storeTimezones.map((tz) => resolveTz(tz)).filter(Boolean)),
  ].sort();

  let timezone: string;
  let resolvedBy: KpiWindow['resolvedBy'];
  if (input.requestedTimezone) {
    timezone = assertZone(input.requestedTimezone);
    resolvedBy = 'requested';
  } else if (distinct.length === 1) {
    timezone = distinct[0];
    resolvedBy = 'single_store';
  } else {
    timezone = resolveTz(input.organisationTimezone) || DEFAULT_TZ;
    resolvedBy = 'organisation_default';
  }

  const now = input.now ?? new Date();
  const today = zonedParts(now, timezone);
  const defaultTo = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
  const toDate = input.to ?? defaultTo;
  // Thirty days back INCLUSIVE of today, which is the window every operational
  // review actually asks for. An explicit `from` overrides it.
  const fromDate = input.from ?? shiftDays(toDate, -29);

  if (!YMD.test(fromDate) || !YMD.test(toDate)) {
    throw new BadRequestException('Dates must be yyyy-mm-dd.');
  }
  if (fromDate > toDate) {
    throw new BadRequestException('The start of the range is after its end.');
  }
  if (daysBetween(fromDate, toDate) > MAX_DAYS) {
    throw new BadRequestException(
      `That range is longer than ${MAX_DAYS} days. Narrow it, or export the detail instead.`,
    );
  }

  return {
    // Local midnight to local midnight of the day AFTER `to`, so the last day is
    // included in full. A `lt` bound on the next midnight is exact at every
    // offset, including the half-hour ones and the days a zone changes offset.
    from: instantFromLocalTime(localMidnight(fromDate), 0, timezone),
    to: instantFromLocalTime(localMidnight(shiftDays(toDate, 1)), 0, timezone),
    timezone,
    ambiguous: distinct.length > 1 && resolvedBy !== 'requested',
    zonesInScope: distinct,
    resolvedBy,
    fromDate,
    toDate,
  };
}

/** The same window, one period earlier — for "compared with". */
export function previousWindow(window: KpiWindow): { from: Date; to: Date } {
  const span = window.to.getTime() - window.from.getTime();
  return { from: new Date(window.from.getTime() - span), to: window.from };
}

function assertZone(tz: string): string {
  try {
    // Throws on an unknown zone, which is the only reliable way to check one.
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    throw new BadRequestException(`"${tz}" is not a timezone this server recognises.`);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function shiftDays(ymd: string, days: number): string {
  const base = localMidnight(ymd);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (localMidnight(to).getTime() - localMidnight(from).getTime()) / 86_400_000,
  );
}

/**
 * A ratio that refuses to be a number when it cannot be one.
 *
 * Zero and "no data" are different answers and a dashboard that shows 0% for
 * both teaches people to distrust it: a branch that converted none of its forty
 * leads and a branch that had no leads at all are not the same Tuesday. Null
 * means the question could not be asked; the numerator and denominator travel
 * with it so the screen can show the working rather than a bare percentage.
 */
export interface Ratio {
  value: number | null;
  numerator: number;
  denominator: number;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return {
    value: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null,
    numerator,
    denominator,
  };
}
