import { ConflictException } from '@nestjs/common';
import { StockTransferStatus } from '@prisma/client';

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
 * Off-ramps:
 *   submitted ──reject──▶ rejected           (HO declines)
 *   draft | submitted | ho_approved ──cancel──▶ cancelled
 *
 * Cancellation is only allowed *before dispatch*: once goods are physically in
 * transit the transfer must be received to reconcile the pieces — there is no
 * "un-dispatch". A cancel from `ho_approved` releases the reservation the
 * approval placed (reserved → in_stock); a cancel from draft/submitted has no
 * inventory effect because nothing is reserved until approval.
 */
export const ALLOWED_NEXT: Record<StockTransferStatus, StockTransferStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['ho_approved', 'rejected', 'cancelled'],
  ho_approved: ['dispatched', 'cancelled'],
  dispatched: ['received'],
  received: ['acknowledged'],
  acknowledged: [],
  rejected: [],
  cancelled: [],
};

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
