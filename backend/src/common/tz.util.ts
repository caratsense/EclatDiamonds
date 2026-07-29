/**
 * Store-local time helpers for attendance (Module 6).
 *
 * ## Why this file exists
 *
 * Punch instants are stored in UTC (`DateTime`), but a shift is configured as a
 * wall-clock string in the store's own timezone ("10:00"–"19:00"), and the
 * attendance day is a calendar date at the store (`@db.Date`). Comparing a UTC
 * instant directly against a local "HH:MM" is wrong by the zone offset — in IST
 * (UTC+5:30) a 10:00 punch reads as 04:30, so lateness never fires and every
 * displayed punch time is 5h30m early.
 *
 * Every attendance calculation therefore goes through here, with the store's
 * `timezone` (IANA id, e.g. "Asia/Kolkata") as the anchor. Nothing else in the
 * codebase should call `getUTCHours()` on a punch.
 */

/** Fallback zone when a store has no (or an invalid) timezone configured. */
export const DEFAULT_TZ = 'Asia/Kolkata';

/** Wall-clock components of an instant, as observed in a given timezone. */
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number;
  /** 0 = Sunday … 6 = Saturday, in the target zone. */
  weekday: number;
}

/** `Intl.DateTimeFormat` instances are expensive to build; one per zone is enough. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * True when the runtime recognises `tz` as an IANA zone. A store row carrying a
 * typo must degrade to the default rather than throw mid-punch.
 */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Normalise any store/user-supplied zone to one the runtime can actually use. */
export function resolveTz(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? (tz as string) : DEFAULT_TZ;
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    // h23 (not hour12:false) — some engines render midnight as "24" under
    // hour12:false, which would silently shift the day by one.
    hourCycle: 'h23',
  });
  formatterCache.set(tz, fmt);
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Decompose a UTC instant into the wall-clock parts an observer in `tz` sees. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = formatterFor(resolveTz(tz)).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/**
 * The attendance/business DATE an instant falls on at the store, as the
 * UTC-midnight `Date` that Postgres `@db.Date` columns round-trip.
 *
 * Use this — never `new Date().setUTCHours(0,0,0,0)` and never `setHours(0,0,0,0)`
 * — as the key for `AttendanceRecord.date`. The old code mixed both, so a manual
 * mark and a self check-in for the same working day could land on different rows
 * (or collide with the `[storeId, staffId, date]` unique index).
 */
export function businessDate(instant: Date, tz: string): Date {
  const p = zonedParts(instant, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

/** Minutes since store-local midnight — the unit shift maths works in. */
export function minutesOfDayInTz(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  return p.hour * 60 + p.minute;
}

/** Day of week at the store (0 = Sunday), for week-off resolution. */
export function weekdayInTz(instant: Date, tz: string): number {
  return zonedParts(instant, tz).weekday;
}

/** Store-local "HH:MM" for display. Replaces the old UTC-slicing `hhmm()`. */
export function formatHHMMInTz(instant: Date | null | undefined, tz: string): string | null {
  if (!instant) return null;
  const p = zonedParts(instant, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" of a `@db.Date` value (already UTC-midnight — no zone shift). */
export function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Start of the store-local day containing `instant`, as a real UTC instant.
 *
 * This is the boundary every "today"/"this month" report window should be built
 * from. Using `new Date().setHours(0,0,0,0)` instead anchors the window to the
 * API SERVER's timezone, which is an environment variable, not a business fact —
 * the same report then covers a different slice of the day depending on where
 * the container happens to run.
 */
export function startOfDayInTz(instant: Date, tz: string): Date {
  return instantFromLocalTime(businessDate(instant, tz), 0, tz);
}

/** Start of the store-local day `daysAgo` before `instant`. */
export function startOfDayAgoInTz(instant: Date, tz: string, daysAgo: number): Date {
  const day = businessDate(instant, tz);
  day.setUTCDate(day.getUTCDate() - daysAgo);
  return instantFromLocalTime(day, 0, tz);
}

/** Start of the store-local calendar month containing `instant`. */
export function startOfMonthInTz(instant: Date, tz: string): Date {
  const p = zonedParts(instant, tz);
  return instantFromLocalTime(new Date(Date.UTC(p.year, p.month - 1, 1)), 0, tz);
}

/** Start of the store-local month `monthsAgo` before `instant`. */
export function startOfMonthAgoInTz(instant: Date, tz: string, monthsAgo: number): Date {
  const p = zonedParts(instant, tz);
  return instantFromLocalTime(
    new Date(Date.UTC(p.year, p.month - 1 - monthsAgo, 1)),
    0,
    tz,
  );
}

/** Signed offset of `tz` from UTC, in minutes, at a given instant (+330 for IST). */
function tzOffsetMins(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - instant.getTime()) / 60000);
}

/**
 * Inverse of {@link zonedParts}: the UTC instant at which a store-local wall
 * clock reads `minutesOfDay` on the calendar date `businessDay`.
 *
 * Needed by the day-close job, which has to synthesise "19:00 at this store on
 * this date" as a real instant in order to auto-close a dangling punch.
 *
 * Resolved in two passes because the offset itself depends on the instant: the
 * first pass guesses using the offset at local-midnight, the second re-checks at
 * the candidate result. That second pass is what keeps a punch straddling a DST
 * boundary from landing an hour out — India has no DST, but the platform is
 * multi-store and this must not be the thing that breaks on expansion.
 *
 * @param businessDay UTC-midnight `Date` of the local calendar date (a `@db.Date`).
 * @param minutesOfDay Local minutes since midnight; may exceed 1440 to mean
 *                     "that many minutes into the following day" (night shifts).
 */
export function instantFromLocalTime(
  businessDay: Date,
  minutesOfDay: number,
  tz: string,
): Date {
  const zone = resolveTz(tz);
  const base = Date.UTC(
    businessDay.getUTCFullYear(),
    businessDay.getUTCMonth(),
    businessDay.getUTCDate(),
  );
  const naive = base + minutesOfDay * 60000;
  const firstPass = naive - tzOffsetMins(new Date(naive), zone) * 60000;
  const secondOffset = tzOffsetMins(new Date(firstPass), zone);
  return new Date(naive - secondOffset * 60000);
}

/** Parse a configured "HH:MM" shift boundary into minutes since local midnight. */
export function parseHHMM(s: string): number {
  const [h, m] = (s ?? '').split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}

/**
 * Signed minute difference between two points on a 24h clock, expressed as the
 * SHORTEST path and therefore always within (-720, +720].
 *
 * This is what makes night shifts work. A 21:00 shift with a 00:30 punch is a
 * naive `30 - 1275 = -1245` ("early"), which is nonsense; the circular reading
 * is `+195` — three and a quarter hours late, which is the truth. It also stops
 * an on-time 21:05 punch from reading as 21 hours late.
 */
export function circularDeltaMins(actualMins: number, referenceMins: number): number {
  let d = (actualMins - referenceMins) % 1440;
  if (d > 720) d -= 1440;
  if (d <= -720) d += 1440;
  return d;
}

/** Scheduled length of a shift in minutes, midnight-crossing aware. */
export function shiftDurationMins(startTime: string, endTime: string): number {
  const d = parseHHMM(endTime) - parseHHMM(startTime);
  return d > 0 ? d : d + 1440;
}

/**
 * A shift's end expressed as local minutes from the START day's midnight, so a
 * 21:00–02:00 night batch returns 1560 (26:00) rather than 120. Feed this to
 * {@link instantFromLocalTime} to get the real closing instant.
 */
export function shiftEndMinutesOfDay(startTime: string, endTime: string): number {
  return parseHHMM(startTime) + shiftDurationMins(startTime, endTime);
}

/** The subset of `Shift` the attendance maths needs. */
export interface ShiftWindow {
  startTime: string;
  endTime: string;
  bufferMins: number;
  fullDayMins?: number | null;
  halfDayMins?: number | null;
}

/**
 * Lateness of a check-in against its assigned shift, measured in STORE-LOCAL
 * time and tolerant of shifts that run past midnight.
 *
 * A staffer is late only once they punch after `startTime + bufferMins`. Because
 * the comparison is against the shift they are actually rostered on, a night
 * batch punching in at 21:05 is on time — it is not measured against the morning
 * batch's 10:00 start.
 */
export function computeLateness(
  checkInAt: Date,
  shift: ShiftWindow,
  tz: string,
): { isLate: boolean; lateMinutes: number } {
  const actual = minutesOfDayInTz(checkInAt, tz);
  const threshold = parseHHMM(shift.startTime) + (shift.bufferMins ?? 0);
  const delta = circularDeltaMins(actual, threshold);
  return { isLate: delta > 0, lateMinutes: Math.max(0, Math.round(delta)) };
}

/**
 * Minutes a check-out landed BEFORE the shift's scheduled end (0 when on or
 * after it). Uses the same circular reading so a 02:00 finish on a 21:00–02:00
 * night shift counts as a full shift, not a 19-hour early exit.
 */
export function computeEarlyOut(checkOutAt: Date, shift: ShiftWindow, tz: string): number {
  const actual = minutesOfDayInTz(checkOutAt, tz);
  const delta = circularDeltaMins(actual, parseHHMM(shift.endTime));
  return delta < 0 ? Math.round(-delta) : 0;
}

/**
 * Payroll day credit from time actually worked.
 *
 * Thresholds come from the shift when configured, else derive from its scheduled
 * duration (full = the whole shift, half = 50% of it). Returned as 1 / 0.5 / 0 so
 * payroll consumes a number rather than re-deriving policy from a status label.
 */
export function computeDayFraction(
  workedMins: number | null | undefined,
  shift: ShiftWindow | null,
): number | null {
  if (workedMins == null) return null;
  if (!shift) return workedMins > 0 ? 1 : 0;
  const full = shift.fullDayMins ?? shiftDurationMins(shift.startTime, shift.endTime);
  const half = shift.halfDayMins ?? Math.round(full / 2);
  if (workedMins >= full) return 1;
  if (workedMins >= half) return 0.5;
  return 0;
}

/**
 * Overtime beyond the shift's scheduled duration. Without a shift there is no
 * baseline to exceed, so overtime is undefined rather than "everything".
 */
export function computeOvertime(
  workedMins: number | null | undefined,
  shift: ShiftWindow | null,
): number | null {
  if (workedMins == null || !shift) return null;
  const scheduled = shift.fullDayMins ?? shiftDurationMins(shift.startTime, shift.endTime);
  return Math.max(0, workedMins - scheduled);
}
