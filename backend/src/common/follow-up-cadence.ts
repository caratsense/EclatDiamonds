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
 * Front-loaded on purpose, and chosen with the client: the first touch is the
 * next day while the enquiry is still warm, and the gaps widen to monthly once
 * it is clear the sale is not immediate. Ten in five months, not ten in a
 * fortnight.
 */
export const FOLLOW_UP_CADENCE_DAYS = [1, 3, 7, 14, 30, 45, 60, 90, 120, 150] as const;

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
export function sopFollowUps(
  leadId: string,
  storeId: string,
  from: Date,
  note?: string | null,
): { leadId: string; storeId: string; seq: number; dueDate: Date; note: string | null }[] {
  return FOLLOW_UP_CADENCE_DAYS.map((days, i) => ({
    leadId,
    storeId,
    seq: i + 1,
    dueDate: addUtcDays(from, days),
    note: note ?? null,
  }));
}
