import { describe, expect, it } from "vitest";

import {
  describeRange,
  presetRange,
  rangeParams,
  rangeProblem,
  ymd,
} from "@/lib/queries/exports";

/**
 * What the Excel dialog's quick choices actually ask for.
 *
 * The client's ask (21 Nov) was "a pop-up should open when you click on Excel to
 * ask from which to which date". These are the rules that decide what the server
 * then filters on, and every one of them has a way of being wrong that produces a
 * file that LOOKS right: a month that starts a day early, a 90-day window that is
 * really 91 days, an "all time" that silently became a range.
 */

describe("the quick choices", () => {
  // A Saturday, mid-month, so a month boundary cannot hide an off-by-one.
  const midNovember = new Date(2026, 10, 14, 12, 0, 0);

  it("takes This month from the 1st to today, not to the month end", () => {
    // To the month end would ask the server for dates that have not happened,
    // and a file dated "1-30 November" taken on the 14th overstates its period.
    expect(presetRange("this-month", midNovember)).toEqual({
      from: "2026-11-01",
      to: "2026-11-14",
    });
  });

  it("takes Last month as the whole of the previous month", () => {
    expect(presetRange("last-month", midNovember)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  it("gets February right, without a table of month lengths", () => {
    // Day 0 of March is 28 February 2027 — 2027 is not a leap year.
    expect(presetRange("last-month", new Date(2027, 2, 9, 12))).toEqual({
      from: "2027-02-01",
      to: "2027-02-28",
    });
    // And 2028 is.
    expect(presetRange("last-month", new Date(2028, 2, 9, 12))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("makes Last 90 days ninety days, counting today as one of them", () => {
    const range = presetRange("last-90", midNovember);
    expect(range).toEqual({ from: "2026-08-17", to: "2026-11-14" });

    // The arithmetic the label promises: both ends inclusive, so the span is 90.
    const days =
      (new Date(range.to!).getTime() - new Date(range.from!).getTime()) / 86_400_000 + 1;
    expect(days).toBe(90);
  });

  it("crosses a year end without landing in the wrong year", () => {
    expect(presetRange("this-month", new Date(2027, 0, 3, 12))).toEqual({
      from: "2027-01-01",
      to: "2027-01-03",
    });
    expect(presetRange("last-month", new Date(2027, 0, 3, 12))).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  it("sends NOTHING for All time, rather than a very wide range", () => {
    /*
     * The one the client actually uses. An absent bound is no filter at all on
     * the server, which is both cheaper and honest — a pair of sentinel dates
     * would make "everything" and "a range that happens to be enormous"
     * indistinguishable to whoever reads the file afterwards.
     */
    expect(presetRange("all", midNovember)).toEqual({});
    expect(rangeParams(presetRange("all", midNovember))).toEqual({});
    expect(describeRange(presetRange("all", midNovember))).toBe("All time");
  });
});

describe("ymd", () => {
  it("reads the viewer's own day, not UTC's", () => {
    /*
     * The bug this exists to stop: `toISOString().slice(0, 10)` is the obvious
     * way to format a date and it is wrong east of Greenwich. At 02:00 in
     * Asia/Kolkata it returns yesterday, so "This month" pressed in the small
     * hours of the 1st would have asked for a range starting in October.
     */
    const earlyMorning = new Date(2026, 10, 1, 2, 0, 0);
    expect(ymd(earlyMorning)).toBe("2026-11-01");
    expect(ymd(new Date(2026, 0, 9, 23, 59, 0))).toBe("2026-01-09");
  });
});

describe("what the Download button refuses", () => {
  it("allows All time, which is the whole point of the preset", () => {
    expect(rangeProblem({})).toBeNull();
  });

  it("allows one end on its own", () => {
    // "Everything since 1 November" is a real question and the server answers it.
    expect(rangeProblem({ from: "2026-11-01" })).toBeNull();
    expect(rangeProblem({ to: "2026-11-30" })).toBeNull();
  });

  it("allows a single day", () => {
    expect(rangeProblem({ from: "2026-11-14", to: "2026-11-14" })).toBeNull();
  });

  it("refuses a backwards range, before the request rather than after", () => {
    expect(rangeProblem({ from: "2026-11-30", to: "2026-11-01" })).toBe(
      "The second date is before the first.",
    );
  });
});

describe("what the range is called", () => {
  it("names both ends when both were chosen", () => {
    expect(describeRange({ from: "2026-11-01", to: "2026-11-30" })).toBe(
      "2026-11-01 to 2026-11-30",
    );
  });

  it("says which end it has when only one was given", () => {
    expect(describeRange({ from: "2026-11-01" })).toBe("2026-11-01 onwards");
    expect(describeRange({ to: "2026-11-30" })).toBe("up to 2026-11-30");
  });
});

describe("rangeParams", () => {
  it("drops the end that was not chosen rather than sending it blank", () => {
    // A blank `to=` on the query string is a parameter the server has to defend
    // against; not sending it is the same request with one less thing to get wrong.
    expect(rangeParams({ from: "2026-11-01" })).toEqual({ from: "2026-11-01" });
    expect(rangeParams({ from: "2026-11-01", to: "2026-11-30" })).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });
});
