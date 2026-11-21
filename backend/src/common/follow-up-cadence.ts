/**
 * How often a lead is followed up, and how many times.
 *
 * The client asked for this by name (18 Nov): "make sure each manager gets a
 * reminder to follow up on each contact up to 10 times. after that no reminder
 * for that customer."
 *
 * Before that the SOP was two touches, +7d and +30d, written out separately in
 * `leads.service`, `lead-intake.service` and `advanced-crm.service`. Three
 * copies of a number that has to agree is three places to miss when it
 * changes, which is why the cadence now has one home.
 *
 * Revised 18 Nov after the client reconsidered: 24 hours, 48 hours, then a
 * week, then weekly. Ten touches across eight weeks rather than the five
 * months the first version spread them over -- a jewellery enquiry goes cold
 * long before month five, and the client knows her customers.
 */
export const FOLLOW_UP_CADENCE_DAYS = [1, 2, 7, 14, 21, 28, 35, 42, 49, 56] as const;

/*
 * ONE AMBIGUITY, DELIBERATELY NOT RESOLVED IN SILENCE.
 *
 * The instruction was "first in 24 hours, second in 48 hours, third after a
 * week, then consecutive ones each after a week". The first two are plainly
 * measured FROM THE LEAD, which is why they are days 1 and 2 rather than 1 and
 * 3. "Third after a week" has two readings:
 *
 *   from the lead    -> day 7   (what is implemented, matching the first two)
 *   from the second  -> day 9
 *
 * A day either way, and the weekly run after it shifts with whichever is
 * chosen. Change the third entry and the rest follow; the tests state the
 * dates, so the diff will show exactly what moved.
 *
 * The earlier meeting note said "follow-up gaps: 24 hours, 48 hours, 1 week
 * and 2 weeks", which reads as GAPS and would give 1, 3, 10, 24. That is a
 * third cadence again, and it is older than the instruction above.
 */

/**
 * The cap the client asked for — "after that no reminder for that customer".
 *
 * It is the length of the cadence rather than a separate number, so the two
 * cannot drift apart. Anything generating SOP follow-ups must stop here.
 *
 * Deliberately NOT applied to a callback a person books at the counter: that
 * is somebody deciding to ring a customer, not the system nagging, and the
 * check-in path appends it after the SOP rows on purpose.
 */
export const MAX_SOP_FOLLOW_UPS = FOLLOW_UP_CADENCE_DAYS.length;

/** Add whole days to a UTC-midnight date, staying date-only (`@db.Date`). */
export function addUtcDays(base: Date, days: number): Date {
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days),
  );
}

/**
 * The SOP follow-up rows for one lead.
 *
 * `from` is the day the clock starts, which is NOT always the day the enquiry
 * arrived. An enquiry imported months after the fact would otherwise generate
 * ten rows that are all already overdue, and a manager opening the app to
 * 1,800 late tasks stops opening the app.
 */
/**
 * The due days of the SOP cadence, as dates.
 *
 * Separated from the rows so a caller can resolve a reminder instant for each
 * one before writing them — see `sopFollowUps`.
 */
export function sopDueDates(from: Date): Date[] {
  return FOLLOW_UP_CADENCE_DAYS.map((days) => addUtcDays(from, days));
}

export function sopFollowUps(
  leadId: string,
  storeId: string,
  from: Date,
  note?: string | null,
  /*
   * WHEN SOMEBODY IS TOLD, one per due day and in the same order.
   *
   * `dueDate` is the day the CUSTOMER is owed a call; `reminderAt` is the
   * instant the EMPLOYEE hears about it, and it is the only field the reminder
   * sweep looks at. Rows written without one are due forever and announce
   * themselves to nobody — eleven thousand of them had accumulated that way,
   * with exactly one reminder set across the whole database.
   *
   * Optional because the pure shape of the cadence is still useful to a caller
   * that has no organisation settings to resolve against; every caller that
   * writes to the database passes it.
   */
  reminders?: (Date | null)[],
): {
  leadId: string;
  storeId: string;
  seq: number;
  dueDate: Date;
  note: string | null;
  reminderAt: Date | null;
}[] {
  return FOLLOW_UP_CADENCE_DAYS.map((days, i) => ({
    leadId,
    storeId,
    seq: i + 1,
    dueDate: addUtcDays(from, days),
    note: note ?? null,
    reminderAt: reminders?.[i] ?? null,
  }));
}
