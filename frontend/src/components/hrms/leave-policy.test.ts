/**
 * The Leave Tracker must not offer a button that is going to 403.
 *
 * These are the rules the screens read before drawing Approve / Reject /
 * Withdraw / Edit / Delete, checked against the server's own: a peer manager
 * cannot sign off or correct a peer's leave, nobody signs off or corrects their
 * own, a settled request is settled, only a PENDING request can be edited, and
 * approving a pending request moves days from `pending` into `used` WITHOUT
 * moving `available` — the arithmetic the balance-impact line states to an
 * approver.
 */
import { describe, expect, it } from "vitest";

import {
  durationLabel,
  leaveBalanceImpact,
  leaveCorrectionRight,
  leaveDecisionRight,
  leaveWithdrawRight,
  skippedDaysNote,
} from "./leave-policy";

const PENDING = { status: "pending" } as const;

describe("who may decide a leave request", () => {
  it("lets a store manager decide a salesperson's", () => {
    expect(
      leaveDecisionRight({
        ...PENDING,
        approverRole: "store_manager",
        approverId: "mgr",
        requesterRole: "salesperson",
        requesterId: "sales",
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses a PEER manager, and names who can", () => {
    const right = leaveDecisionRight({
      ...PENDING,
      approverRole: "store_manager",
      approverId: "mgr-a",
      requesterRole: "store_manager",
      requesterId: "mgr-b",
    });
    expect(right.allowed).toBe(false);
    if (right.allowed) throw new Error("unreachable");
    expect(right.because).toBe("rank");
    expect(right.message).toBe(
      "A store manager's leave request is decided one rank above — by Area Manager or Head Office.",
    );
  });

  it("lets head office decide a store manager's", () => {
    expect(
      leaveDecisionRight({
        ...PENDING,
        approverRole: "head_office",
        approverId: "ho",
        requesterRole: "store_manager",
        requesterId: "mgr",
      }).allowed,
    ).toBe(true);
  });

  it("refuses head office its OWN request, even though nothing outranks it", () => {
    const right = leaveDecisionRight({
      ...PENDING,
      approverRole: "head_office",
      approverId: "ho",
      requesterRole: "head_office",
      requesterId: "ho",
    });
    expect(right.allowed).toBe(false);
    if (right.allowed) throw new Error("unreachable");
    expect(right.because).toBe("self");
  });

  it("tells a manager deciding their own request WHO can, not merely that they cannot", () => {
    // The rank rule fires before the self rule, exactly as decideLeave orders
    // them — so the message is actionable.
    const right = leaveDecisionRight({
      ...PENDING,
      approverRole: "store_manager",
      approverId: "mgr",
      requesterRole: "store_manager",
      requesterId: "mgr",
    });
    if (right.allowed) throw new Error("unreachable");
    expect(right.because).toBe("rank");
  });

  it("refuses a salesperson and a marketing user outright", () => {
    for (const approverRole of ["salesperson", "marketing"] as const) {
      const right = leaveDecisionRight({
        ...PENDING,
        approverRole,
        approverId: "x",
        requesterRole: "salesperson",
        requesterId: "y",
      });
      if (right.allowed) throw new Error("unreachable");
      expect(right.because).toBe("role");
    }
  });

  it("refuses a second decision on a settled request", () => {
    for (const status of ["approved", "rejected", "cancelled"] as const) {
      const right = leaveDecisionRight({
        status,
        approverRole: "head_office",
        approverId: "ho",
        requesterRole: "salesperson",
        requesterId: "sales",
      });
      if (right.allowed) throw new Error("unreachable");
      expect(right.because).toBe("settled");
      expect(right.message).toContain(status);
    }
  });

  it("allows the decision when the applicant's role is unknown, as the server does", () => {
    expect(
      leaveDecisionRight({
        ...PENDING,
        approverRole: "store_manager",
        approverId: "mgr",
        requesterRole: null,
        requesterId: "gone",
      }).allowed,
    ).toBe(true);
  });
});

describe("who may withdraw a request", () => {
  it("lets the applicant withdraw their own pending one", () => {
    expect(
      leaveWithdrawRight({ status: "pending", isOwner: true, viewerRole: "salesperson" }),
    ).toMatchObject({ allowed: true, label: "Withdraw" });
  });

  it("does NOT let a salesperson withdraw their own approved one", () => {
    expect(
      leaveWithdrawRight({ status: "pending", isOwner: false, viewerRole: "salesperson" }),
    ).toEqual({ allowed: false });
    expect(
      leaveWithdrawRight({ status: "approved", isOwner: true, viewerRole: "salesperson" }),
    ).toEqual({ allowed: false });
  });

  it("lets a manager revoke an approved one, and says the days come back", () => {
    const right = leaveWithdrawRight({
      status: "approved",
      isOwner: true,
      viewerRole: "store_manager",
    });
    expect(right).toMatchObject({ allowed: true, label: "Revoke" });
    if (!right.allowed) throw new Error("unreachable");
    expect(right.warning).toBe("The days go back to the balance.");
  });

  it("offers nothing on a rejected or cancelled request", () => {
    for (const status of ["rejected", "cancelled"] as const) {
      expect(
        leaveWithdrawRight({ status, isOwner: true, viewerRole: "head_office" }),
      ).toEqual({ allowed: false });
    }
  });
});

describe("who may correct a request — edit / delete", () => {
  const manager = { managerRole: "store_manager", managerId: "mgr" } as const;

  it("lets a store manager edit a salesperson's PENDING request", () => {
    expect(
      leaveCorrectionRight({
        action: "edit",
        status: "pending",
        ...manager,
        staffRole: "salesperson",
        staffId: "sales",
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses an edit once the request is decided, as editLeave does with a 400", () => {
    for (const status of ["approved", "rejected", "cancelled"] as const) {
      const right = leaveCorrectionRight({
        action: "edit",
        status,
        ...manager,
        staffRole: "salesperson",
        staffId: "sales",
      });
      if (right.allowed) throw new Error("unreachable");
      expect(right.because).toBe("not_pending");
      expect(right.message).toContain(status);
    }
  });

  it("still allows DELETE on a decided request — that is the route that gives days back", () => {
    for (const status of ["pending", "approved", "rejected"] as const) {
      expect(
        leaveCorrectionRight({
          action: "delete",
          status,
          ...manager,
          staffRole: "salesperson",
          staffId: "sales",
        }).allowed,
      ).toBe(true);
    }
  });

  it("withholds delete on a withdrawn request, which stays in the history", () => {
    const right = leaveCorrectionRight({
      action: "delete",
      status: "cancelled",
      ...manager,
      staffRole: "salesperson",
      staffId: "sales",
    });
    if (right.allowed) throw new Error("unreachable");
    expect(right.because).toBe("withdrawn");
  });

  it("refuses a PEER manager's row, and names who handles it", () => {
    const right = leaveCorrectionRight({
      action: "delete",
      status: "approved",
      managerRole: "store_manager",
      managerId: "mgr-a",
      staffRole: "store_manager",
      staffId: "mgr-b",
    });
    if (right.allowed) throw new Error("unreachable");
    expect(right.because).toBe("peer");
    expect(right.message).toBe(
      "You cannot correct the leave of someone at or above your role — a store manager's request is handled by Area Manager or Head Office.",
    );
  });

  it("refuses one's OWN row before it refuses a peer's — assertCanCorrect's order", () => {
    // The opposite order to the decision path, and the reason the two rules are
    // separate functions: a manager editing their own request is told it is
    // theirs, not that it belongs to a peer.
    const right = leaveCorrectionRight({
      action: "edit",
      status: "pending",
      managerRole: "store_manager",
      managerId: "mgr",
      staffRole: "store_manager",
      staffId: "mgr",
    });
    if (right.allowed) throw new Error("unreachable");
    expect(right.because).toBe("self");
  });

  it("lets head office correct a store manager's but never its own", () => {
    expect(
      leaveCorrectionRight({
        action: "edit",
        status: "pending",
        managerRole: "head_office",
        managerId: "ho",
        staffRole: "store_manager",
        staffId: "mgr",
      }).allowed,
    ).toBe(true);
    // Head office outranks everyone, including another head office user.
    expect(
      leaveCorrectionRight({
        action: "delete",
        status: "approved",
        managerRole: "head_office",
        managerId: "ho-a",
        staffRole: "head_office",
        staffId: "ho-b",
      }).allowed,
    ).toBe(true);
    const own = leaveCorrectionRight({
      action: "delete",
      status: "approved",
      managerRole: "head_office",
      managerId: "ho",
      staffRole: "head_office",
      staffId: "ho",
    });
    if (own.allowed) throw new Error("unreachable");
    expect(own.because).toBe("self");
  });

  it("refuses a salesperson and a marketing user outright", () => {
    for (const managerRole of ["salesperson", "marketing", "storeperson"] as const) {
      const right = leaveCorrectionRight({
        action: "delete",
        status: "pending",
        managerRole,
        managerId: "x",
        staffRole: "salesperson",
        staffId: "y",
      });
      if (right.allowed) throw new Error("unreachable");
      expect(right.because).toBe("role");
    }
  });

  it("offers the correction when the applicant's role is unknown", () => {
    // Somebody no longer on the roster `GET /users` returns still has rows a
    // manager may need to clean up; the server re-checks with the real role.
    expect(
      leaveCorrectionRight({
        action: "delete",
        status: "approved",
        ...manager,
        staffRole: null,
        staffId: "gone",
      }).allowed,
    ).toBe(true);
  });
});

describe("what approving does to the balance", () => {
  const balance = { allocated: 12, used: 3, pending: 2 };

  it("moves pending into used and leaves available alone", () => {
    const impact = leaveBalanceImpact({ type: "casual", days: 2, balance });
    expect(impact).toMatchObject({
      paid: true,
      available: 7, // 12 − 3 − 2
      used: 3,
      usedAfter: 5,
      chargeableAfter: 7, // 12 − 3 − 2
      overdrawn: false,
    });
  });

  it("flags the overdraw the server re-checks at decision time", () => {
    // Two pending requests of 5 days each against 9 allotted and 0 used: both
    // passed the apply-time check, the second cannot be approved.
    const impact = leaveBalanceImpact({
      type: "sick",
      days: 5,
      balance: { allocated: 9, used: 5, pending: 5 },
    });
    // 4 left to charge, 5 asked for — the figure the refusal has to quote.
    expect(impact).toMatchObject({ chargeableNow: 4, chargeableAfter: -1, overdrawn: true });
  });

  it("charges nothing for festival leave, with or without a balance row", () => {
    expect(leaveBalanceImpact({ type: "festival", days: 3, balance: null })).toMatchObject({
      paid: false,
      overdrawn: false,
    });
  });

  it("says nothing at all when a paid type has no balance row yet", () => {
    expect(leaveBalanceImpact({ type: "earned", days: 1, balance: null })).toBeNull();
  });

  it("keeps half-days to two places", () => {
    const impact = leaveBalanceImpact({
      type: "casual",
      days: 0.5,
      balance: { allocated: 12, used: 11.5, pending: 0 },
    });
    expect(impact?.usedAfter).toBe(12);
    expect(impact?.chargeableAfter).toBe(0);
  });
});

describe("reconciling the count against the roster", () => {
  it("names the offs and holidays it skipped", () => {
    expect(
      skippedDaysNote({
        offDates: ["2026-09-07"],
        holidays: [{ date: "2026-09-08", label: "Ganesh Chaturthi" }],
      }),
    ).toBe("Not charged: 1 off day and 1 holiday.");
  });

  it("stays silent when it skipped nothing", () => {
    expect(skippedDaysNote({ offDates: [], holidays: [] })).toBeNull();
  });
});

describe("how a day count reads", () => {
  it("is singular only at exactly one", () => {
    expect(durationLabel(1)).toBe("1 day");
    // Half a day is "0.5 days", like every other non-one quantity — the same
    // rule the existing leave list uses.
    expect(durationLabel(0.5)).toBe("0.5 days");
    expect(durationLabel(4)).toBe("4 days");
  });
});
