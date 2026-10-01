import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SelfAttendance } from "@/lib/mock/hrms";
import type { AccessMap, Role } from "@/lib/types";

/**
 * What the punch screen shows, by who is looking and by today's punches.
 *
 * The screen is rendered once per case on the server, which needs no DOM, with
 * the session and the attendance it reads put in their place. That covers what
 * is decided before a tap: which face, which buttons, whether "Skip for now"
 * is offered. What a tap or the passing of time does is decided by the pure
 * functions the screen calls, tested next to them (lib/attendance-punch-policy
 * and lib/attendance-gate).
 */

const seen = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  attendance: {} as Record<string, unknown>,
  fence: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {} }) }));
vi.mock("@/store/use-session", () => ({
  useSession: (select?: (session: unknown) => unknown) =>
    select ? select(seen.session) : seen.session,
}));
vi.mock("@/lib/queries/tenant-config", () => ({ useEnabledNavigation: () => undefined }));
vi.mock("@/lib/queries/hrms", () => {
  const idle = { isPending: false, mutate() {} };
  return {
    useMyAttendance: () => seen.attendance,
    useGeofence: () => seen.fence,
    useCheckIn: () => idle,
    useCheckOut: () => idle,
  };
});

import CheckInPage from "./page";

interface Person {
  role: Role;
  access: AccessMap;
}

/** Set to attendance only in People & Access: every screen off but HRMS. */
const ATTENDANCE_ONLY: Person = { role: "salesperson", access: { hrms: "own" } };
const SALES: Person = {
  role: "salesperson",
  access: { hrms: "own", crm: "own", catalogue: "own", quotation: "own" },
};
/** CRM switched off, other screens kept: not attendance only. */
const NO_CRM: Person = {
  role: "salesperson",
  access: { hrms: "own", catalogue: "own", quotation: "own" },
};

/** A date no test run is ever past, so the shift is always "today's". */
const TODAY = "2999-01-01";
const AN_EARLIER_DAY = "2020-01-01";

/** A shift checked in at 10:02, and out at `out` if it has ended. */
const shift = (date: string, out: string | null): SelfAttendance => ({
  id: "a1",
  storeId: "s1",
  date,
  status: "present",
  checkInAt: `${date}T04:32:00.000Z`,
  checkOutAt: out ? `${date}T13:35:00.000Z` : null,
  checkInLocal: "10:02",
  checkOutLocal: out,
  timezone: "Asia/Kolkata",
  checkInDistanceM: 12,
  withinFence: true,
  workedMins: null,
  isLate: false,
  lateMinutes: null,
  shiftId: null,
});

const FENCE = {
  storeId: "s1",
  storeName: "Surat Main",
  latitude: 21.17,
  longitude: 72.83,
  geofenceRadiusM: 150,
  hasCoords: true,
};

/** The screen's HTML for this person, given today's record (null: not punched). */
function shown(
  person: Person,
  today: SelfAttendance | null,
  { failed = false, fence = FENCE }: { failed?: boolean; fence?: typeof FENCE } = {},
): string {
  seen.session = {
    user: { id: "u1", name: "Asha Patel", initials: "AP", email: "" },
    role: person.role,
    access: person.access,
    currentStore: { id: "s1", name: "Surat Main" },
  };
  seen.attendance = {
    data: failed ? undefined : { today, records: [] },
    isLoading: false,
    isError: failed,
    isFetching: false,
    refetch: async () => ({}),
  };
  seen.fence = { data: fence, isLoading: false, refetch: async () => ({}) };
  return renderToStaticMarkup(createElement(CheckInPage));
}

const buttons = (html: string) => html.match(/<button/g)?.length ?? 0;

describe("the punch screen for someone set to attendance only", () => {
  it("never offers 'Skip for now': there is nowhere to skip to", () => {
    const locating = shown(ATTENDANCE_ONLY, null);
    const noFence = shown(ATTENDANCE_ONLY, null, { fence: { ...FENCE, hasCoords: false } });
    const failed = shown(ATTENDANCE_ONLY, null, { failed: true });
    expect(locating).toContain("Locating you");
    expect(noFence).toContain("Mark attendance");
    expect(failed).toContain("load your attendance");
    for (const html of [locating, noFence, failed]) {
      expect(html).not.toContain("Skip for now");
    }
  });

  it("can still check in while the phone finds no location", () => {
    // Allowed to read the location, but no fix ever comes. Everyone else skips
    // and punches from HRMS; without a button here this face was a dead end.
    expect(shown(ATTENDANCE_ONLY, null)).toContain("Continue with reason");
  });

  it("links to leave and fixing attendance, its one other screen", () => {
    expect(shown(ATTENDANCE_ONLY, null)).toContain('href="/hrms"');
  });

  it("shows the check-in time and one button, Check out, once checked in", () => {
    const html = shown(ATTENDANCE_ONLY, shift(TODAY, null));
    expect(html).toContain("Checked in at 10:02");
    expect(html).toContain("Check out");
    expect(buttons(html)).toBe(1);
    // Not sent on, and not asked to check in again.
    expect(html).not.toContain("Continue to app");
    expect(html).not.toContain("Check in for today");
  });

  it("says 'Done for today' with both times once checked out, with nothing left to tap", () => {
    const html = shown(ATTENDANCE_ONLY, shift(TODAY, "19:05"));
    expect(html).toContain("Done for today");
    expect(html).toContain("In 10:02 · Out 19:05");
    expect(buttons(html)).toBe(0);
  });

  it("offers today's check-in when the finished shift on screen is an earlier day's", () => {
    // The screen was left open overnight. It asks; it does not check in itself.
    const html = shown(ATTENDANCE_ONLY, shift(AN_EARLIER_DAY, "19:05"));
    expect(html).toContain("Last shift");
    expect(html).toContain("In 10:02 · Out 19:05");
    expect(html).toContain("Check in for today");
    expect(html).not.toContain("Done for today");
    expect(buttons(html)).toBe(1);
  });

  it("keeps Check out for a shift still open from an earlier day, beside today's check-in", () => {
    // After midnight Check out is how that shift is closed. If it was simply
    // forgotten yesterday, today's can be started without it.
    const html = shown(ATTENDANCE_ONLY, shift(AN_EARLIER_DAY, null));
    expect(html).toContain("Checked in at 10:02");
    expect(html).toContain("Check out");
    expect(html).toContain("Check in for today");
  });
});

describe("the punch screen for everyone else", () => {
  it("still offers 'Skip for now', and nothing that belongs to the one-screen app", () => {
    for (const person of [SALES, NO_CRM]) {
      const html = shown(person, null);
      expect(html).toContain("Locating you");
      expect(html).toContain("Skip for now");
      expect(html).not.toContain("Continue with reason");
      expect(html).not.toContain('href="/hrms"');
    }
  });

  it("still welcomes someone already in and sends them on, with no Check out here", () => {
    for (const person of [SALES, NO_CRM]) {
      const html = shown(person, shift(TODAY, null));
      expect(html).toContain("Continue to app");
      expect(html).not.toContain("Check out");
      expect(html).not.toContain("Checked in at");
    }
  });
});
