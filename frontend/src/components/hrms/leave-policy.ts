/**
 * The leave rules the Leave Tracker has to AGREE with, as pure functions.
 *
 * Every one of these mirrors a check the server already makes. They live here,
 * away from the screens, for two reasons: the same rule is needed in three
 * places (the my-requests list, the team list, the decision dialog), and a rule
 * the UI only *implies* through a disabled button cannot be tested. The server
 * remains the authority — nothing here grants anything, it only decides whether
 * to OFFER an action that would otherwise be refused with a 403 the employee
 * cannot act on.
 *
 * Mirrored from, in order: `assertUndecided`, `assertRankAboveRequester` and
 * `assertNotSelfApproval` in backend/src/common/approval.util.ts, and
 * `HrmsService.cancelLeave`.
 */
import type { LeaveStatus, LeaveType } from "@/lib/mock/hrms";
import { ROLE_LABELS, ROLE_RANK, type Role } from "@/lib/types";

/**
 * Balance-tracked (paid) leave types — mirrors `PAID_LEAVE_TYPES` in
 * hrms.service.ts. Festival leave is unpaid: it charges no allocation, so a
 * balance figure against it would be a number that means nothing.
 */
const PAID_LEAVE_TYPES: readonly LeaveType[] = [
  "casual",
  "sick",
  "earned",
  "week_off_leave",
];

export function isPaidLeaveType(type: LeaveType | undefined): boolean {
  return !!type && PAID_LEAVE_TYPES.includes(type);
}

/** Leave states that can no longer be decided (backend `LEAVE_TERMINAL`). */
const SETTLED: readonly LeaveStatus[] = ["approved", "rejected", "cancelled"];

export const LEAVE_STATUS_BADGE: Record<
  LeaveStatus,
  { label: string; variant: "warning" | "success" | "destructive" | "secondary" }
> = {
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

/** "1 day", "0.5 days", "4 days" — a leave duration, halves and all. */
export function durationLabel(days: number): string {
  const n = Math.round(days * 100) / 100;
  return `${n} ${n === 1 ? "day" : "days"}`;
}

/* ------------------------------------------------------------------ */
/* Who may decide a leave request                                      */
/* ------------------------------------------------------------------ */

export type DecisionRight =
  | { allowed: true }
  | {
      allowed: false;
      /** Which server rule would refuse it. */
      because: "settled" | "role" | "rank" | "self";
      /** Said the way the server says it, so the two never disagree. */
      message: string;
    };

/**
 * Whether to offer Approve / Reject on a request.
 *
 * The order matches the server's, because the order decides WHICH message a
 * manager looking at their own request is shown: the rank rule fires first, so
 * they are told who can decide it rather than merely that they cannot.
 *
 * `requesterRole` undefined — the roster has not loaded, or the applicant's
 * account is gone — is allowed through exactly as the server allows it
 * (`assertRankAboveRequester` returns early on a null role); refusing here
 * would hide a decidable request behind a loading state.
 */
export function leaveDecisionRight(input: {
  status: LeaveStatus;
  approverRole: Role;
  approverId: string;
  requesterRole?: Role | null;
  requesterId: string;
}): DecisionRight {
  const { status, approverRole, approverId, requesterRole, requesterId } = input;

  if (SETTLED.includes(status)) {
    return {
      allowed: false,
      because: "settled",
      message: `This leave request is already ${status} and cannot be decided again.`,
    };
  }
  // The route is @Roles('store_manager', 'head_office'), and the role hierarchy
  // rolls up — so area manager qualifies and marketing (rank 1) does not.
  if (ROLE_RANK[approverRole] < ROLE_RANK.store_manager) {
    return {
      allowed: false,
      because: "role",
      message: "Leave is decided by a store manager or above.",
    };
  }
  if (requesterRole && !rankAboveRequester(approverRole, requesterRole)) {
    return {
      allowed: false,
      because: "rank",
      message: `A ${ROLE_LABELS[requesterRole].toLowerCase()}'s leave request is decided one rank above — by ${deciders(requesterRole)}.`,
    };
  }
  if (requesterId && requesterId === approverId) {
    return {
      allowed: false,
      because: "self",
      message:
        "You cannot approve your own leave request — it must be decided by another approver.",
    };
  }
  return { allowed: true };
}

/** Head office may decide anything; everybody else must outrank the requester. */
function rankAboveRequester(approverRole: Role, requesterRole: Role): boolean {
  return (
    approverRole === "head_office" ||
    ROLE_RANK[approverRole] > ROLE_RANK[requesterRole]
  );
}

/** "Area Manager or Head Office" — every role that outranks the requester. */
function deciders(requesterRole: Role): string {
  const who = (Object.keys(ROLE_RANK) as Role[])
    .filter((r) => ROLE_RANK[r] > ROLE_RANK[requesterRole])
    .map((r) => ROLE_LABELS[r]);
  return who.length ? who.join(" or ") : ROLE_LABELS.head_office;
}

/* ------------------------------------------------------------------ */
/* Who may withdraw a request                                          */
/* ------------------------------------------------------------------ */

export type WithdrawRight =
  | { allowed: true; label: string; warning?: string }
  | { allowed: false };

/**
 * Withdrawal, mirroring `cancelLeave`: the applicant may withdraw their OWN
 * while it is still pending, and a manager+ may revoke one already approved,
 * which releases the days back to the balance. Rejected and cancelled are done.
 */
export function leaveWithdrawRight(input: {
  status: LeaveStatus;
  isOwner: boolean;
  viewerRole: Role;
}): WithdrawRight {
  const { status, isOwner, viewerRole } = input;
  const isManager = ROLE_RANK[viewerRole] >= ROLE_RANK.store_manager;
  if (status === "rejected" || status === "cancelled") return { allowed: false };
  if (status === "pending") {
    return isOwner || isManager
      ? { allowed: true, label: isOwner ? "Withdraw" : "Withdraw for them" }
      : { allowed: false };
  }
  // Approved.
  return isManager
    ? {
        allowed: true,
        label: "Revoke",
        warning: "The days go back to the balance.",
      }
    : { allowed: false };
}

/* ------------------------------------------------------------------ */
/* Who may correct a request — a manager's edit or delete              */
/* ------------------------------------------------------------------ */

export type CorrectionAction = "edit" | "delete";

export type CorrectionRight =
  | { allowed: true }
  | {
      allowed: false;
      /** Which rule refuses it. */
      because: "role" | "self" | "peer" | "not_pending" | "withdrawn";
      /** Said the way the server says it, so the two never disagree. */
      message: string;
    };

/**
 * Whether to offer a manager's Edit / Delete on somebody else's request.
 *
 * A different rule from deciding it, and stricter. `PATCH leave/:id/edit` and
 * `DELETE leave/:id` are `@Roles('store_manager')` and both run
 * `assertCanCorrectUser` → `assertCanCorrect`, which refuses a correction of
 * one's OWN row before it refuses a peer's — the opposite order to the decision
 * path, and the reason the two live in separate functions rather than one with
 * a flag. Editing is then pending-only (`editLeave` throws 400 on anything
 * else); deleting is not.
 *
 * Two deliberate departures from exact mirroring, both stated out loud:
 *
 * - `staffRole` unknown is allowed through, as the decision path allows it. The
 *   server loads the real role and refuses with it, so this one CAN produce a
 *   403 — but the alternative hides delete from exactly the rows a manager most
 *   wants to clean up, the ones belonging to somebody no longer on the roster
 *   `GET /users` returns. One verbatim refusal beats an unreachable capability.
 * - A CANCELLED request is not offered for deletion even though the server
 *   permits it. That is a product rule, not a server rule: a withdrawal is the
 *   answer to "what happened to my leave", and the screens show it rather than
 *   hide it. The old approvals inbox withheld delete here too.
 */
export function leaveCorrectionRight(input: {
  action: CorrectionAction;
  status: LeaveStatus;
  managerRole: Role;
  managerId: string;
  staffRole?: Role | null;
  staffId: string;
}): CorrectionRight {
  const { action, status, managerRole, managerId, staffRole, staffId } = input;

  // @Roles('store_manager'), and the hierarchy rolls up — area manager and head
  // office qualify, a salesperson or marketing user (rank 1) does not.
  if (ROLE_RANK[managerRole] < ROLE_RANK.store_manager) {
    return {
      allowed: false,
      because: "role",
      message: "Leave requests are corrected by a store manager or above.",
    };
  }
  if (staffId === managerId) {
    return {
      allowed: false,
      because: "self",
      message:
        "You cannot correct your own leave request — it has to be handled by another approver.",
    };
  }
  if (staffRole && !canCorrectRank(managerRole, staffRole)) {
    return {
      allowed: false,
      because: "peer",
      message: `You cannot correct the leave of someone at or above your role — a ${ROLE_LABELS[
        staffRole
      ].toLowerCase()}'s request is handled by ${deciders(staffRole)}.`,
    };
  }
  if (action === "edit" && status !== "pending") {
    return {
      allowed: false,
      because: "not_pending",
      message: `Only a pending request can be edited (this one is ${status}).`,
    };
  }
  if (action === "delete" && status === "cancelled") {
    return {
      allowed: false,
      because: "withdrawn",
      message: "A withdrawn request stays in the history.",
    };
  }
  return { allowed: true };
}

/**
 * `assertCanCorrect`: head office corrects anyone (but itself, checked before
 * this); everybody else must be strictly senior — a store manager cannot touch
 * a co-manager's row.
 */
function canCorrectRank(managerRole: Role, staffRole: Role): boolean {
  return (
    managerRole === "head_office" ||
    ROLE_RANK[managerRole] > ROLE_RANK[staffRole]
  );
}

/* ------------------------------------------------------------------ */
/* What approving a request does to the balance                        */
/* ------------------------------------------------------------------ */

export interface BalanceImpact {
  paid: boolean;
  allocated: number;
  used: number;
  /** Days held by undecided requests — this one included, while it is pending. */
  pending: number;
  /** allocated − used − pending, as the balances view computes it. */
  available: number;
  /**
   * allocated − used: what is left to charge RIGHT NOW, ignoring reservations.
   * This is the figure the server's decision-time check compares against, and
   * the one to quote when an approval would overdraw.
   */
  chargeableNow: number;
  /** Where `used` lands if this request is approved. */
  usedAfter: number;
  /**
   * What is left to charge once this request is approved: allocated − used −
   * days. Negative means approving it would overdraw the allocation, which is
   * the check the server repeats at DECISION time.
   */
  chargeableAfter: number;
  overdrawn: boolean;
}

/**
 * The balance arithmetic an approver needs, stated honestly.
 *
 * The subtlety worth spelling out on screen: approving a PENDING request does
 * not move `available`. The days are already reserved against it, so approval
 * only moves them from `pending` into `used`. What approval can still fail on
 * is `allocated − used < days` — several pending requests can each pass the
 * apply-time check and together overdraw the allocation — so that is the figure
 * `chargeableAfter` reports.
 */
export function leaveBalanceImpact(input: {
  type: LeaveType;
  days: number;
  balance?: { allocated: number; used: number; pending?: number } | null;
}): BalanceImpact | null {
  const { type, days, balance } = input;
  if (!isPaidLeaveType(type)) {
    return {
      paid: false,
      allocated: 0,
      used: 0,
      pending: 0,
      available: 0,
      chargeableNow: 0,
      usedAfter: 0,
      chargeableAfter: 0,
      overdrawn: false,
    };
  }
  if (!balance) return null;
  const allocated = balance.allocated;
  const used = balance.used;
  const pending = balance.pending ?? 0;
  const chargeableAfter = round2(allocated - used - days);
  return {
    paid: true,
    allocated,
    used,
    pending,
    available: Math.max(0, round2(allocated - used - pending)),
    chargeableNow: round2(allocated - used),
    usedAfter: round2(used + days),
    chargeableAfter,
    overdrawn: chargeableAfter < 0,
  };
}

/** Two places keeps 11.5 − 0.5 from reading 11.000000001 (backend `round2`). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Reconciling the server's day count against the employee's calendar  */
/* ------------------------------------------------------------------ */

/**
 * Why the count is what it is, in one sentence: the days the server skipped.
 *
 * A number an employee cannot reconcile against their own roster is a number
 * they will dispute at the counter, so the preview always says which dates it
 * left out. Returns null when it skipped nothing — there is then nothing to
 * explain, and a sentence saying so is noise.
 */
export function skippedDaysNote(input: {
  offDates: string[];
  holidays: { date: string; label: string | null }[];
}): string | null {
  const parts: string[] = [];
  if (input.offDates.length > 0) {
    parts.push(
      `${input.offDates.length} off ${input.offDates.length === 1 ? "day" : "days"}`,
    );
  }
  if (input.holidays.length > 0) {
    parts.push(
      `${input.holidays.length} ${input.holidays.length === 1 ? "holiday" : "holidays"}`,
    );
  }
  return parts.length ? `Not charged: ${parts.join(" and ")}.` : null;
}
