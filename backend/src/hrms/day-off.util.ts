/**
 * The dated roster's one rule, in one place (client, 9 Oct).
 *
 * A week that has ANY dated off rows for a person is governed by those rows —
 * the weekday pattern is silent for that week. A week with none falls back to
 * the pattern (their StaffWeekOff rows, else the store's weekOffDay). So
 * "Monday off this week, Friday the next" is two dated rows, and a month
 * nobody planned behaves exactly as before.
 *
 * Weeks are Monday-based and computed on the STORE-LOCAL date string, which is
 * what both the register (@db.Date) and the dated rows store — no timezone
 * arithmetic happens here, only calendar arithmetic on YYYY-MM-DD keys.
 *
 * Payroll (`countDays`) and attendance (`eligibleStaff` → `classifyDay` →
 * day-close) MUST both read through this, or the register and the payslip
 * will disagree about who was off.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Monday of the week containing this YYYY-MM-DD, as YYYY-MM-DD. */
export function weekKeyOf(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export interface OffCalendar {
  /** The fallback pattern: weekday numbers, 0 = Sunday … 6 = Saturday. */
  weekdays: Set<number>;
  /** Dated offs, grouped by their week's Monday key. */
  datesByWeek: Map<string, Set<string>>;
}

export function buildOffCalendar(weekdays: Set<number>, datedKeys: string[]): OffCalendar {
  const datesByWeek = new Map<string, Set<string>>();
  for (const key of datedKeys) {
    const wk = weekKeyOf(key);
    const set = datesByWeek.get(wk) ?? new Set<string>();
    set.add(key);
    datesByWeek.set(wk, set);
  }
  return { weekdays, datesByWeek };
}

/** Is this person off on this date? `weekday` is the store-local day number. */
export function isOffOn(cal: OffCalendar, dateKey: string, weekday: number): boolean {
  const planned = cal.datesByWeek.get(weekKeyOf(dateKey));
  if (planned) return planned.has(dateKey);
  return cal.weekdays.has(weekday);
}
