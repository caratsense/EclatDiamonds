import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthUser } from './auth-user';

/**
 * Guardrails shared by every approval flow in the platform (leave, attendance
 * regularization, discount requests, returns).
 *
 * Each flow used to re-implement — or quietly skip — these checks. Discounts had
 * a terminal-state guard but no separation-of-duties rule; leave had an
 * idempotency guard but no attribution; regularization had neither, so the same
 * request could be approved twice and re-apply its effect, with no record of who
 * approved it.
 */

/**
 * Separation of duties: nobody signs off their own request.
 *
 * This is the single most universal control in any approval system, and it was
 * absent everywhere. A store manager could file leave and immediately approve
 * it; a manager could raise an attendance regularization for a day they never
 * worked and self-clear it. The escalation ladder does not cover this on its own
 * — a request that stays within the requester's own rank never leaves them.
 *
 * `requesterId` may be null on legacy rows that predate attribution; those are
 * allowed through rather than blocking a manager from clearing an old backlog.
 */
export function assertNotSelfApproval(
  approver: AuthUser,
  requesterId: string | null | undefined,
  what = 'request',
): void {
  if (requesterId && requesterId === approver.id) {
    throw new ForbiddenException(
      `You cannot approve your own ${what} — it must be decided by another approver.`,
    );
  }
}

/**
 * Refuse to re-decide something already decided.
 *
 * Beyond being wrong on its face, a second decision double-applies side effects:
 * approving a leave request twice would decrement the balance twice, and
 * approving a regularization twice would re-stamp the punch record.
 */
export function assertUndecided(
  currentStatus: string,
  terminalStatuses: readonly string[],
  what = 'request',
): void {
  if (terminalStatuses.includes(currentStatus)) {
    throw new BadRequestException(
      `This ${what} is already ${currentStatus} and cannot be decided again.`,
    );
  }
}

/** The decision-attribution columns every approvable row now carries. */
export interface DecisionStamp {
  decidedById: string;
  decidedByName: string;
  decidedAt: Date;
  decisionNote: string | null;
}

/** Build the attribution payload written alongside an approve/reject. */
export function decisionStamp(approver: AuthUser, note?: string | null): DecisionStamp {
  return {
    decidedById: approver.id,
    decidedByName: approver.name,
    decidedAt: new Date(),
    decisionNote: note ?? null,
  };
}
