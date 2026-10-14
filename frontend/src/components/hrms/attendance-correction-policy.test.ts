/**
 * The Attendance module must not offer a button that is going to 403 or 409,
 * and must not send a correction that asks for more than it means to.
 *
 * These are the rules the correction screens read before drawing Approve /
 * Reject and before posting the form, checked against the server's own: a peer
 * manager cannot sign off a peer's correction, nobody signs off their own, a
 * settled request is settled, a day that drifted cannot be APPROVED (but can
 * still be rejected), and only the punch that actually changed is sent — because
 * approving a side voids that side's geo evidence with it.
 */
import { describe, expect, it } from "vitest";

import {
  attendanceStatusLabel,
  correctedCheckOutDate,
  correctionDecisionRight,
  correctionSides,
  driftBlocksApproval,
  formatWorkedMins,
  nextDay,
} from "./attendance-correction-policy";

describe("who may decide a correction request", () => {
  const pending = { status: "pending" } as const;

  it("lets a store manager decide a salesperson's", () => {
    expect(
      correctionDecisionRight({
        ...pending,
        approverRole: "store_manager",
        approverId: "mgr",
        requesterRole: "salesperson",
        requesterId: "sales",
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses a PEER manager, and names who can", () => {
    const right = correctionDecisionRight({
      ...pending,
      approverRole: "store_manager",
      approverId: "mgr-a",
      requesterRole: "store_manager",
      requesterId: "mgr-b",
    });
    expect(right.allowed).toBe(false);
    if (right.allowed) return;
    expect(right.because).toBe("rank");
    expect(right.message).toContain("one rank above");
    expect(right.message).toContain("Area Manager");
    expect(right.message).toContain("Head Office");
  });

  it("lets head office decide a store manager's", () => {
    expect(
      correctionDecisionRight({
        ...pending,
        approverRole: "head_office",
        approverId: "ho",
        requesterRole: "store_manager",
        requesterId: "mgr",
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses head office its OWN request — there is no rank above it", () => {
    const right = correctionDecisionRight({
      ...pending,
      approverRole: "head_office",
      approverId: "ho",
      requesterRole: "head_office",
      requesterId: "ho",
    });
    expect(right.allowed).toBe(false);
    if (right.allowed) return;
    expect(right.because).toBe("self");
  });

  it("refuses a salesperson and a marketing user outright", () => {
    for (const approverRole of ["salesperson", "marketing"] as const) {
      const right = correctionDecisionRight({
        ...pending,
        approverRole,
        approverId: "a",
        requesterRole: "salesperson",
        requesterId: "b",
      });
      expect(right.allowed).toBe(false);
      if (right.allowed) continue;
      expect(right.because).toBe("role");
    }
  });

  it("refuses a second decision on a settled request", () => {
    for (const status of ["approved", "rejected", "cancelled"] as const) {
      const right = correctionDecisionRight({
        status,
        approverRole: "head_office",
        approverId: "ho",
        requesterRole: "salesperson",
        requesterId: "sales",
      });
      expect(right.allowed).toBe(false);
      if (right.allowed) continue;
      expect(right.because).toBe("settled");
      expect(right.message).toContain(status);
    }
  });

  it("offers the buttons when the requester's role is unknown, as the server does", () => {
    expect(
      correctionDecisionRight({
        ...pending,
        approverRole: "store_manager",
        approverId: "mgr",
        requesterRole: undefined,
        requesterId: "gone",
      }),
    ).toEqual({ allowed: true });
  });
});

describe("a day that moved after the request was filed", () => {
  it("blocks approval with something to read", () => {
    expect(driftBlocksApproval(true)).toContain("Reload");
  });

  it("blocks nothing when the day has not moved", () => {
    expect(driftBlocksApproval(false)).toBeNull();
  });
});

describe("which calendar date a corrected check-out belongs to", () => {
  it("keeps a day shift's check-out on the same date", () => {
    expect(
      correctedCheckOutDate({
        date: "2026-10-14",
        checkIn: "10:00",
        checkOut: "19:30",
      }),
    ).toBe("2026-10-14");
  });

  it("moves a night shift's check-out to the next morning", () => {
    expect(
      correctedCheckOutDate({
        date: "2026-10-14",
        checkIn: "21:00",
        checkOut: "05:30",
      }),
    ).toBe("2026-10-15");
  });

  it("closes the day the RECORDED check-in opened when only the out is corrected", () => {
    expect(
      correctedCheckOutDate({
        date: "2026-10-14",
        checkIn: "",
        checkOut: "02:15",
        recordedCheckIn: "22:40",
      }),
    ).toBe("2026-10-15");
  });

  it("crosses a month and a year end without losing a day", () => {
    expect(nextDay("2026-10-31")).toBe("2026-11-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    // 2028 is a leap year — the 29th exists and must not be skipped.
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
  });

  it("leaves the date alone when there is no check-out to place", () => {
    expect(
      correctedCheckOutDate({ date: "2026-10-14", checkIn: "10:00", checkOut: "" }),
    ).toBe("2026-10-14");
  });
});

describe("which side of the day a request asks to change", () => {
  it("sends only the check-out when only the check-out was edited", () => {
    expect(
      correctionSides({
        checkIn: "10:02",
        checkOut: "19:30",
        recordedCheckIn: "10:02",
        recordedCheckOut: null,
      }),
    ).toEqual({ fixIn: false, fixOut: true, sendable: true });
  });

  it("sends only the check-in when only the check-in was edited", () => {
    expect(
      correctionSides({
        checkIn: "09:45",
        checkOut: "19:30",
        recordedCheckIn: "10:02",
        recordedCheckOut: "19:30",
      }),
    ).toEqual({ fixIn: true, fixOut: false, sendable: true });
  });

  it("sends both when the day had neither punch", () => {
    expect(
      correctionSides({
        checkIn: "10:00",
        checkOut: "19:00",
        recordedCheckIn: null,
        recordedCheckOut: null,
      }),
    ).toEqual({ fixIn: true, fixOut: true, sendable: true });
  });

  it("refuses a form that matches the record, rather than resubmitting it", () => {
    const sides = correctionSides({
      checkIn: "10:02",
      checkOut: "19:30",
      recordedCheckIn: "10:02",
      recordedCheckOut: "19:30",
    });
    expect(sides.sendable).toBe(false);
    if (sides.sendable) return;
    expect(sides.message).toContain("already recorded");
  });

  it("refuses an empty form with a different message", () => {
    const sides = correctionSides({ checkIn: "", checkOut: "" });
    expect(sides.sendable).toBe(false);
    if (sides.sendable) return;
    expect(sides.message).toContain("corrected check-in");
  });
});

describe("how the figures read", () => {
  it("prints hours and minutes, and an em dash for no figure at all", () => {
    expect(formatWorkedMins(380)).toBe("6h 20m");
    expect(formatWorkedMins(45)).toBe("45m");
    expect(formatWorkedMins(0)).toBe("0m");
    expect(formatWorkedMins(null)).toBe("—");
    expect(formatWorkedMins(undefined)).toBe("—");
  });

  it("names every status the register can show, and passes an unknown one through", () => {
    expect(attendanceStatusLabel("half_day")).toBe("Half day");
    expect(attendanceStatusLabel("week_off")).toBe("Week off");
    expect(attendanceStatusLabel("on_leave")).toBe("On leave");
    expect(attendanceStatusLabel(null)).toBe("—");
    expect(attendanceStatusLabel("some_new_status")).toBe("some_new_status");
  });
});
