/**
 * The attendance-correction rules the Attendance screens have to AGREE with, as
 * pure functions.
 *
 * Same purpose as its sibling `leave-policy.ts`: each of these mirrors a check
 * the server already makes, kept away from the screens because the same rule is
 * needed in three places (my requests, the team list, the decision dialog) and
 * a rule the UI only *implies* through a disabled button cannot be tested. The
 * server stays the authority — nothing here grants anything. It only decides
 * whether to OFFER an action, and how to say what the day would become.
 *
 * Mirrored from, in order: `assertUndecided`, `assertRankAboveRequester` and
 * `assertNotSelfApproval` in backend/src/common/approval.util.ts,
 * `attendanceDriftedSinceFiling` in hrms/attendance-ops.service.ts, and
 * `HrmsService.resolveRegularizationTimes`.
 */
import {
  ATTENDANCE_STATUS_LABELS,
  type AttendanceStatus,
  type LeaveStatus,
} from "@/lib/mock/hrms";
import { ROLE_LABELS, ROLE_RANK, type Role } from "@/lib/types";

/** Minutes → "6h 20m" / "45m". An absent day has no figure, not a zero. */
export function formatWorkedMins(mins: number | null | undefined): string {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "Wed 8 Jul" from a YYYY-MM-DD, read as parts so no zone can shift the day. */
export function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** A day status as a person reads it; the API may send one we don't know yet. */
export function attendanceStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return ATTENDANCE_STATUS_LABELS[status as AttendanceStatus] ?? status;
}

/**
 * The day after a YYYY-MM-DD, counted in UTC so a daylight-saving change cannot
 * move the calendar date being named.
 */
export function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Which calendar date a corrected check-out belongs to                */
/* ------------------------------------------------------------------ */

/**
 * The store-local DATE to send with a corrected check-out time.
 *
 * A night batch's out-punch belongs to the day its in-punch opened but falls on
 * the next calendar date, and the server will only accept it on exactly that
 * basis (`resolveRegularizationTimes`: the out must close that day's check-in
 * within 24 hours). So an out earlier than the in is read as the next morning —
 * the same rule a manager's own edit applies.
 *
 * `recordedCheckIn` is the fallback opener for a request that corrects only the
 * out-punch: the day it closes is the one the existing check-in opened.
 * Zero-padded "HH:mm" compares correctly as a string.
 */
export function correctedCheckOutDate(input: {
  /** The day being corrected (YYYY-MM-DD). */
  date: string;
  /** The check-in time on the form, store-local "HH:mm". */
  checkIn: string;
  /** The check-out time on the form, store-local "HH:mm". */
  checkOut: string;
  /** The check-in already on the record, store-local "HH:mm". */
  recordedCheckIn?: string | null;
}): string {
  const { date, checkIn, checkOut, recordedCheckIn } = input;
  if (!date || !checkOut) return date;
  const opensAt = checkIn || recordedCheckIn || "";
  return opensAt && checkOut < opensAt ? nextDay(date) : date;
}

/* ------------------------------------------------------------------ */
/* Which side of the day a request should actually ask to change       */
/* ------------------------------------------------------------------ */

export type CorrectionSides =
  | { fixIn: boolean; fixOut: boolean; sendable: true }
  | { fixIn: false; fixOut: false; sendable: false; message: string };

/**
 * Which punches to send, given a form prefilled from the day's own record.
 *
 * Only a side that actually DIFFERS is sent. Approving a side voids that side's
 * punches and clears its location evidence with them (`decideRegularization`
 * nulls `checkInLat/Lng/DistanceM` and `geoVerified` for every requested side),
 * so re-sending a check-in the staffer never touched would quietly strip a
 * verified on-site punch of its verification. The prefill is there to be read.
 */
export function correctionSides(input: {
  checkIn: string;
  checkOut: string;
  recordedCheckIn?: string | null;
  recordedCheckOut?: string | null;
}): CorrectionSides {
  const { checkIn, checkOut, recordedCheckIn, recordedCheckOut } = input;
  if (!checkIn && !checkOut) {
    return {
      fixIn: false,
      fixOut: false,
      sendable: false,
      message: "Enter a corrected check-in and/or check-out time.",
    };
  }
  const fixIn = !!checkIn && checkIn !== (recordedCheckIn ?? "");
  const fixOut = !!checkOut && checkOut !== (recordedCheckOut ?? "");
  if (!fixIn && !fixOut) {
    return {
      fixIn: false,
      fixOut: false,
      sendable: false,
      message: "Change a time first — these are the times already recorded.",
    };
  }
  return { fixIn, fixOut, sendable: true };
}

/* ------------------------------------------------------------------ */
/* Who may decide a correction request                                 */
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
 * Whether to offer Approve / Reject on a correction request.
 *
 * The order matches the server's, because the order decides WHICH message a
 * manager looking at their own request is shown: the rank rule fires first, so
 * they are told who can decide it rather than merely that they cannot.
 *
 * `requesterRole` undefined — the staff list has not loaded, or the requester's
 * account is gone — is allowed through exactly as the server allows it
 * (`assertRankAboveRequester` returns early on a null role). Hiding an action we
 * cannot actually disprove strands the request with no explanation at all.
 */
export function correctionDecisionRight(input: {
  status: LeaveStatus;
  approverRole: Role;
  approverId: string;
  requesterRole?: Role | null;
  requesterId: string;
}): DecisionRight {
  const { status, approverRole, approverId, requesterRole, requesterId } = input;

  if (status !== "pending") {
    return {
      allowed: false,
      because: "settled",
      message: `This regularization is already ${status} and cannot be decided again.`,
    };
  }
  // The route is @Roles('store_manager', 'head_office'), and the role hierarchy
  // rolls up — so area manager qualifies and marketing (rank 1) does not.
  if (ROLE_RANK[approverRole] < ROLE_RANK.store_manager) {
    return {
      allowed: false,
      because: "role",
      message: "Attendance corrections are decided by a store manager or above.",
    };
  }
  if (requesterRole && !rankAboveRequester(approverRole, requesterRole)) {
    return {
      allowed: false,
      because: "rank",
      message: `A ${ROLE_LABELS[
        requesterRole
      ].toLowerCase()}'s regularization request is decided one rank above — by ${deciders(
        requesterRole,
      )}.`,
    };
  }
  if (requesterId && requesterId === approverId) {
    return {
      allowed: false,
      because: "self",
      message:
        "You cannot approve your own regularization request — it must be decided by another approver.",
    };
  }
  return { allowed: true };
}

/**
 * Approval alone is additionally blocked once the day has moved: the server
 * re-reads the record inside the transaction and refuses with a 409 rather than
 * apply a correction against punches the approver never saw. REJECTING a stale
 * request is still fine — it writes nothing to the day.
 */
export function driftBlocksApproval(stale: boolean): string | null {
  return stale
    ? "This day changed after the request was filed. Reload to see the refreshed punches before approving."
    : null;
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
