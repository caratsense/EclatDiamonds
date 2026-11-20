import { ConflictException } from '@nestjs/common';
import { StockTransferInitiator, StockTransferStatus } from '@prisma/client';

/**
 * The ONE place inter-store transfer transitions are defined.
 *
 * Every status change routes through `assertTransition`; no service may write a
 * `StockTransferStatus` it did not first validate here. Keeping the graph in a
 * single map (rather than scattered `if (status === …)` checks across the
 * service) is what makes "illegal transitions are rejected" a property of the
 * type, not a thing each handler has to remember.
 *
 * Lifecycle:
 *   draft ──submit──▶ submitted ──approve──▶ ho_approved ──dispatch──▶
 *   dispatched ──receive──▶ received ──acknowledge──▶ acknowledged
 *
 * A PULL (the asking branch is the destination) takes one extra step in front
 * of that same line, and only that:
 *   draft ──submit──▶ pending_source ──accept──▶ submitted ──▶ (as above)
 *
 * Off-ramps:
 *   submitted ──reject──▶ rejected           (HO declines)
 *   pending_source ──decline──▶ declined     (the holding branch declines)
 *   draft | pending_source | submitted | ho_approved ──cancel──▶ cancelled
 *
 * Cancellation is only allowed *before dispatch*: once goods are physically in
 * transit the transfer must be received to reconcile the pieces — there is no
 * "un-dispatch". A cancel from `ho_approved` releases the reservation the
 * approval placed (reserved → in_stock); a cancel from draft/submitted has no
 * inventory effect because nothing is reserved until approval.
 */
export const ALLOWED_NEXT: Record<StockTransferStatus, StockTransferStatus[]> = {
  draft: ['submitted', 'pending_source', 'cancelled'],
  pending_source: ['submitted', 'declined', 'cancelled'],
  submitted: ['ho_approved', 'rejected', 'cancelled'],
  ho_approved: ['dispatched', 'cancelled'],
  dispatched: ['received'],
  received: ['acknowledged'],
  acknowledged: [],
  declined: [],
  rejected: [],
  cancelled: [],
};

/**
 * Where `submit` sends a transfer, which is the ONE place direction changes the
 * line a transfer walks.
 *
 * A push goes straight to head office: the branch already holds the pieces and
 * is giving them up, so nobody else has to agree first. A pull cannot — the
 * pieces belong to a branch that has not been asked yet, and sending it to head
 * office first would make their answer a formality after the decision. So it
 * stops at `pending_source` until they accept.
 */
export function submitTarget(initiatedBy: StockTransferInitiator): StockTransferStatus {
  return initiatedBy === 'destination' ? 'pending_source' : 'submitted';
}

/** A status from which no further transition is possible. */
export function isTerminal(status: StockTransferStatus): boolean {
  return ALLOWED_NEXT[status].length === 0;
}

/**
 * Guard a transition. Throws `ConflictException` (409) if `to` is not reachable
 * from `from`, so an out-of-order or repeated action is a clean client error
 * rather than a silent corrupt write.
 */
export function assertTransition(
  from: StockTransferStatus,
  to: StockTransferStatus,
): void {
  if (!ALLOWED_NEXT[from].includes(to)) {
    throw new ConflictException(
      `Cannot move transfer from ${from} to ${to}`,
    );
  }
}
