import { describe, expect, it } from "vitest";

import {
  addDaysYmd,
  dayLabel,
  mondayOf,
  shiftMonth,
  shortDate,
  weekDates,
} from "@/lib/queries/hrms-roster";

/**
 * The grid's week boundary has to be the SERVER's week boundary.
 *
 * A dated off governs the whole week it falls in (backend `day-off.util`:
 * Monday-based, computed on the YYYY-MM-DD key). If the grid drew a Sunday-based
 * week, planning the last column would re-plan a week the manager is not looking
 * at — the pattern would go silent on days still shown as pattern offs. These
 * cases are the same ones `weekKeyOf` is specified by.
 */
describe("roster week boundaries", () => {
  it("takes the Monday of the week, and leaves a Monday alone", () => {
    // 12 Oct 2026 is a Monday.
    expect(mondayOf("2026-10-12")).toBe("2026-10-12");
    expect(mondayOf("2026-10-18")).toBe("2026-10-12"); // the Sunday belongs to it
    expect(mondayOf("2026-10-19")).toBe("2026-10-19"); // the next Monday starts a new week
  });

  it("gives seven consecutive dates, Monday first, across a month end", () => {
    expect(weekDates("2026-11-01")).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });
});

describe("calendar arithmetic on date keys", () => {
  it("steps days across a month and a year boundary", () => {
    expect(addDaysYmd("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysYmd("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysYmd("2026-10-14", 27)).toBe("2026-11-10");
  });

  it("steps months without drifting on a 31st", () => {
    expect(shiftMonth("2026-10", 1)).toBe("2026-11");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("labels a date from the key itself, not from the device's timezone", () => {
    expect(shortDate("2026-10-06")).toBe("6 Oct");
    expect(dayLabel("2026-10-06")).toBe("Tue 6 Oct");
  });
});
