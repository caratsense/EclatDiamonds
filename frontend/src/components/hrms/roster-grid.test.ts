import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Roster, RosterDay } from "@/lib/queries/hrms-roster";

/**
 * What a roster cell SAYS, which is the whole job of the grid.
 *
 * Three states a planner must never confuse, because they are three different
 * conversations: an off the branch planned, leave that is approved, and leave
 * nobody has decided yet. The last one is the client's own point — a pending
 * request shown like granted time off has managers rostering around absence
 * that may never happen.
 *
 * Rendered once on the server, with the roster the screen reads put in its
 * place. No DOM is needed: what a cell says is decided before anybody taps it.
 */

const seen = vi.hoisted(() => ({
  roster: {} as Record<string, unknown>,
  /** The topbar's store context, so a test can put the grid on "All Stores". */
  store: {} as { id: string; name: string; isAggregate?: boolean },
  /** What the grid actually ASKED the server for — the store scope included. */
  args: null as { from: string; to: string; storeId?: string } | null,
}));

// A Monday, so the week the grid draws is exactly the fixture's week.
const MONDAY = "2026-11-09";
const SURAT = { id: "s1", name: "Surat Main" };

vi.mock("@/store/use-session", () => ({
  useSession: (select?: (session: unknown) => unknown) => {
    const session = { currentStore: seen.store, role: "store_manager" };
    return select ? select(session) : session;
  },
}));

vi.mock("@/lib/queries/hrms-roster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/hrms-roster")>()),
  useRoster: (params: { from: string; to: string; storeId?: string }) => {
    seen.args = params;
    return seen.roster;
  },
  todayYmd: () => MONDAY,
}));

import { RosterGrid } from "./roster-grid";

const SHIFT = {
  id: "sh1",
  name: "Morning",
  startTime: "10:00",
  endTime: "19:00",
  isNightBatch: false,
  isFlexible: false,
};

function day(date: string, over: Partial<RosterDay> = {}): RosterDay {
  return {
    date,
    weekday: new Date(`${date}T00:00:00.000Z`).getUTCDay(),
    employed: true,
    shift: SHIFT,
    shiftSource: "assignment",
    isOff: false,
    offSource: null,
    isHoliday: false,
    holidayLabel: null,
    leave: null,
    conflict: null,
    ...over,
  };
}

function employee(
  days: RosterDay[],
  over: Partial<Roster["employees"][number]> = {},
): Roster["employees"][number] {
  return {
    userId: "u1",
    name: "Asha Patel",
    role: "salesperson",
    employeeCode: "E-1",
    storeId: "s1",
    storeName: "Surat Main",
    timezone: "Asia/Kolkata",
    isPrimary: true,
    weekOffDays: [0],
    followsStore: true,
    days,
    ...over,
  };
}

/** The grid's HTML for one employee's week. */
function shown(days: RosterDay[], over: Partial<Roster["employees"][number]> = {}): string {
  const dates = days.map((d) => d.date);
  seen.roster = {
    data: {
      from: dates[0],
      to: dates[dates.length - 1],
      dates,
      stores: [{ id: "s1", name: "Surat Main", timezone: "Asia/Kolkata", weekOffDay: 0 }],
      holidays: [],
      employees: [employee(days, over)],
    } satisfies Roster,
    isLoading: false,
    isError: false,
    refetch: async () => ({}),
  };
  return renderToStaticMarkup(createElement(RosterGrid));
}

const week = (over: Record<string, Partial<RosterDay>> = {}) =>
  ["09", "10", "11", "12", "13", "14", "15"].map((d) =>
    day(`2026-11-${d}`, over[`2026-11-${d}`] ?? {}),
  );

// Each test states its own store context; a leaked "All Stores" from the test
// before it would make the single-branch assertions pass for the wrong reason.
beforeEach(() => {
  seen.store = { ...SURAT };
  seen.args = null;
});

describe("the roster grid's columns", () => {
  it("are real dates, not weekday names: a variable weekly off cannot be said otherwise", () => {
    const html = shown(week());
    for (const label of ["9 Nov", "10 Nov", "13 Nov", "15 Nov"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Week of 9 Nov");
  });
});

describe("what one cell says", () => {
  it("tells a planned off apart from the weekly pattern", () => {
    const html = shown(
      week({
        "2026-11-11": { isOff: true, offSource: "dated" },
        "2026-11-15": { isOff: true, offSource: "pattern" },
      }),
    );
    expect(html).toContain(">Off<");
    expect(html).toContain("Weekly off");
  });

  it("marks a pending request as pending, and approved leave as leave", () => {
    const approved = shown(
      week({
        "2026-11-12": {
          leave: { id: "l1", type: "casual", status: "approved", halfDay: false },
        },
      }),
    );
    expect(approved).toContain("Casual leave approved.");
    // The legend names the pending state on every render; the CELL must not.
    expect(approved).not.toContain("Casual leave · pending");

    const pending = shown(
      week({
        "2026-11-12": {
          leave: { id: "l2", type: "casual", status: "pending", halfDay: false },
        },
      }),
    );
    expect(pending).toContain("Casual leave · pending");
    // Dashed, so it does not read as a confirmed absence at a glance either.
    expect(pending).toContain("border-dashed");
  });

  it("names the holiday, and says when a shift is only the branch's default", () => {
    const html = shown(
      week({
        "2026-11-11": { isHoliday: true, holidayLabel: "Diwali" },
        "2026-11-13": { shiftSource: "store_default" },
      }),
    );
    expect(html).toContain("Diwali");
    expect(html).toContain("10:00–19:00");
    expect(html).toContain("· default");
  });

  it("warns where an assigned shift collides with approved leave", () => {
    const html = shown(
      week({
        "2026-11-12": {
          leave: { id: "l3", type: "sick", status: "approved", halfDay: false },
          conflict: "shift_on_approved_leave",
        },
      }),
    );
    expect(html).toContain("Shift on approved leave");
  });

  it("leaves a day outside somebody's employment unplannable", () => {
    const html = shown(
      week({ "2026-11-09": { employed: false, shift: null, shiftSource: null } }),
    );
    expect(html).toContain("disabled");
  });
});

/**
 * The grid follows the topbar's store context and asks for nothing wider
 * (CLAUDE.md rule #2). A manager on one branch must not be handed another
 * branch's roster, and on the "All Stores" aggregate every row has to say which
 * branch it belongs to — otherwise two same-named people are one row to the eye.
 */
describe("the store scope the grid plans in", () => {
  it("asks for the one branch the topbar is on, and never names another", () => {
    const html = shown(week());
    expect(seen.args).toMatchObject({
      from: "2026-11-09",
      to: "2026-11-15",
      storeId: "s1",
    });
    // One branch in scope: the row carries the code alone. Printing the branch
    // on every row of a single-branch roster is noise a planner has to read past.
    expect(html).toContain("E-1");
    expect(html).not.toContain("Surat Main");
  });

  it("asks for every branch on All Stores, and names the branch on each row", () => {
    seen.store = { id: "all-stores", name: "All Stores", isAggregate: true };
    const days = week();
    const dates = days.map((d) => d.date);
    seen.roster = {
      data: {
        from: dates[0],
        to: dates[dates.length - 1],
        dates,
        stores: [
          { id: "s1", name: "Surat Main", timezone: "Asia/Kolkata", weekOffDay: 0 },
          { id: "s2", name: "Rajkot Ring Road", timezone: "Asia/Kolkata", weekOffDay: 1 },
        ],
        holidays: [],
        employees: [
          employee(days),
          employee(days, {
            userId: "u2",
            name: "Nikhil Shah",
            employeeCode: "E-2",
            storeId: "s2",
            storeName: "Rajkot Ring Road",
            weekOffDays: [1],
          }),
        ],
      } satisfies Roster,
      isLoading: false,
      isError: false,
      refetch: async () => ({}),
    };
    const html = renderToStaticMarkup(createElement(RosterGrid));

    // "all", not the aggregate option's own id — that id is not a branch.
    expect(seen.args?.storeId).toBe("all");
    expect(html).toContain("E-1 · Surat Main");
    expect(html).toContain("E-2 · Rajkot Ring Road");
    // Each branch keeps its own weekly pattern; the aggregate does not flatten
    // them onto the first branch's day.
    expect(html).toContain("Pattern: Sun (branch)");
    expect(html).toContain("Pattern: Mon (branch)");
  });
});

describe("when there is nothing to show", () => {
  it("says so in a sentence instead of drawing an empty table", () => {
    seen.roster = { data: undefined, isLoading: false, isError: false, refetch: async () => ({}) };
    const html = renderToStaticMarkup(createElement(RosterGrid));
    expect(html).toContain("Nobody is on the roster for this week.");
    expect(html).not.toContain("<table");
  });
});
