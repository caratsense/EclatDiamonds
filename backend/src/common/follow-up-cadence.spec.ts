import {
  FOLLOW_UP_CADENCE_DAYS,
  MAX_SOP_FOLLOW_UPS,
  addUtcDays,
  sopFollowUps,
} from './follow-up-cadence';

/**
 * The follow-up rule the client asked for by name (18 Nov): "make sure each
 * manager gets a reminder to follow up on each contact up to 10 times. after
 * that no reminder for that customer."
 *
 * Before this the SOP was two touches, +7d and +30d, written out separately in
 * three services. These tests pin the number, the spacing and the cap, because
 * the number is a promise to a client and the three callers used to hold their
 * own copies of it.
 */

describe('the cadence the client agreed', () => {
  it('is ten touches', () => {
    expect(FOLLOW_UP_CADENCE_DAYS).toHaveLength(10);
    expect(MAX_SOP_FOLLOW_UPS).toBe(10);
  });

  it('is the spacing that was shown and approved', () => {
    expect([...FOLLOW_UP_CADENCE_DAYS]).toEqual([1, 2, 7, 14, 21, 28, 35, 42, 49, 56]);
  });

  it('starts the next day, while the enquiry is still warm', () => {
    expect(FOLLOW_UP_CADENCE_DAYS[0]).toBe(1);
  });

  it('is strictly increasing — a repeated or backwards day would be a typo', () => {
    const days = [...FOLLOW_UP_CADENCE_DAYS];
    expect(days).toEqual([...new Set(days)]);
    expect(days.every((d, i) => i === 0 || d > days[i - 1])).toBe(true);
  });

  it('is 24 hours, 48 hours, then weekly', () => {
    // The client's own words on 18 Nov. The first two are measured from the
    // lead, not from each other, which is why the second is day 2 and not 3.
    const gaps = FOLLOW_UP_CADENCE_DAYS.map((d, i) => d - (FOLLOW_UP_CADENCE_DAYS[i - 1] ?? 0));
    expect(FOLLOW_UP_CADENCE_DAYS[0]).toBe(1);
    expect(FOLLOW_UP_CADENCE_DAYS[1]).toBe(2);
    expect(gaps.slice(3)).toEqual([7, 7, 7, 7, 7, 7, 7]);
  });

  it('finishes within eight weeks', () => {
    // A jewellery enquiry goes cold long before five months, which is what
    // the first version of this cadence spread ten touches over.
    expect(FOLLOW_UP_CADENCE_DAYS[FOLLOW_UP_CADENCE_DAYS.length - 1]).toBe(56);
  });

  it('keeps the cap and the cadence as one fact', () => {
    // Two numbers that must agree are one number, or they drift.
    expect(MAX_SOP_FOLLOW_UPS).toBe(FOLLOW_UP_CADENCE_DAYS.length);
  });
});

describe('the rows generated for one lead', () => {
  const from = new Date(Date.UTC(2026, 10, 18)); // 18 Nov 2026
  const rows = sopFollowUps('lead-1', 'mumbai-bandra', from, 'imported');

  it('produces exactly the capped number, never more', () => {
    expect(rows).toHaveLength(MAX_SOP_FOLLOW_UPS);
  });

  it('numbers them 1..10 in order', () => {
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('lands on the dates the client was shown', () => {
    const dates = rows.map((r) => r.dueDate.toISOString().slice(0, 10));
    expect(dates).toEqual([
      '2026-11-19', '2026-11-20', '2026-11-25', '2026-12-02', '2026-12-09',
      '2026-12-16', '2026-12-23', '2026-12-30', '2027-01-06', '2027-01-13',
    ]);
  });

  it('carries the branch, so reminders reach the right manager', () => {
    expect(new Set(rows.map((r) => r.storeId))).toEqual(new Set(['mumbai-bandra']));
  });

  it('keeps every row on the same lead', () => {
    expect(new Set(rows.map((r) => r.leadId))).toEqual(new Set(['lead-1']));
  });

  it('defaults the note to null rather than undefined', () => {
    expect(sopFollowUps('l', 's', from)[0].note).toBeNull();
  });
});

describe('where the clock starts', () => {
  /*
   * The reason this is a parameter and not `new Date()`. 95% of the imported
   * enquiries were over a month old; counting from the enquiry date would have
   * made almost every one of the 11,620 rows overdue on the day it was
   * created, and a manager who opens the app to 1,800 late tasks stops opening
   * the app.
   */
  it('counts from the day it is given, not the day the enquiry arrived', () => {
    const enquiry = new Date(Date.UTC(2026, 7, 2)); // 2 Aug, long past
    const today = new Date(Date.UTC(2026, 10, 18)); // 18 Nov
    const fromToday = sopFollowUps('l', 's', today);
    expect(fromToday.every((r) => r.dueDate > today)).toBe(true);
    // Same lead counted from its enquiry date would already be entirely overdue.
    const fromEnquiry = sopFollowUps('l', 's', enquiry);
    expect(fromEnquiry.filter((r) => r.dueDate < today)).toHaveLength(10);
  });
});

describe('addUtcDays stays on calendar days', () => {
  it('crosses a month end', () => {
    expect(addUtcDays(new Date(Date.UTC(2026, 10, 25)), 7).toISOString().slice(0, 10))
      .toBe('2026-12-02');
  });

  it('crosses a year end', () => {
    expect(addUtcDays(new Date(Date.UTC(2026, 11, 28)), 7).toISOString().slice(0, 10))
      .toBe('2027-01-04');
  });

  it('keeps midnight, so a @db.Date column stores the day meant', () => {
    const out = addUtcDays(new Date(Date.UTC(2026, 10, 18)), 1);
    expect([out.getUTCHours(), out.getUTCMinutes(), out.getUTCSeconds()]).toEqual([0, 0, 0]);
  });
});
