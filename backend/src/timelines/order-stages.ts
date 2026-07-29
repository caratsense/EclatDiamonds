import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import { ROLE_LABELS, ROLE_RANK } from '../common/role.util';

/**
 * The production state machine behind Module 8 order timelines.
 *
 * Previously `advanceStage` accepted ANY `OrderStatus` for any non-terminal
 * order. That let a piece jump straight from `booked` to `delivered` — skipping
 * casting, setting, polish and QC — and equally let it slide backwards from
 * `ready` to `designing`, rewriting the customer's promised timeline with no
 * record of why. Neither is a legitimate move on a shop floor, and both quietly
 * corrupt the delivery-performance numbers that hang off these stages.
 *
 * Here each stage declares exactly which stages may follow it.
 */

/** Terminal stages — an order here can no longer move. */
export const TERMINAL_STAGES: readonly OrderStatus[] = [
  OrderStatus.delivered,
  OrderStatus.cancelled,
];

/**
 * Allowed forward transitions. Skipping ahead is permitted only where the shop
 * floor genuinely does so (a stock piece needs no stone setting, an already-cast
 * design goes straight to polish); everything else must move one step at a time.
 * `cancelled` is reachable from any non-terminal stage and is handled separately
 * so it can demand a reason.
 */
const ALLOWED_NEXT: Record<OrderStatus, OrderStatus[]> = {
  booked: [OrderStatus.designing, OrderStatus.casting],
  designing: [OrderStatus.casting],
  casting: [OrderStatus.stone_setting, OrderStatus.polishing],
  stone_setting: [OrderStatus.polishing],
  polishing: [OrderStatus.qc],
  qc: [OrderStatus.ready, OrderStatus.polishing], // QC may send a piece back for re-polish
  ready: [OrderStatus.delivered],
  delivered: [],
  cancelled: [],
};

/**
 * Minimum role that may move an order INTO a stage.
 *
 * `delivered` is the one that matters most: handing the piece over closes the
 * order, stops the delay clock and is the last point at which the balance can be
 * collected. The route-level guard only required `store_manager` for stage moves
 * in general, so any manager could close out an order from their phone. Handover
 * now sits with the store manager explicitly, and cancellation — which writes off
 * a booked order — is escalated to area management.
 */
const STAGE_MIN_ROLE: Partial<Record<OrderStatus, Role>> = {
  delivered: 'store_manager',
  cancelled: 'area_manager',
};

/** Human-friendly stage labels for error messages and the UI. */
export const STAGE_LABELS: Record<OrderStatus, string> = {
  booked: 'Booked',
  designing: 'Designing',
  casting: 'Gold melting / casting',
  stone_setting: 'Stone setting',
  polishing: 'Polishing',
  qc: 'Quality check',
  ready: 'Ready for collection',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/**
 * Frontend ORDER_STAGES are 5 collapsed steps:
 *   0 Gold melting · 1 Designing · 2 Stone setting · 3 Polishing · 4 Ready
 *
 * `cancelled` maps to -1 rather than 4: it used to share an index with "ready
 * for collection", so a written-off order rendered as complete in the stepper.
 */
export const STAGE_INDEX: Record<OrderStatus, number> = {
  booked: 0,
  casting: 0,
  designing: 1,
  stone_setting: 2,
  polishing: 3,
  qc: 3,
  ready: 4,
  delivered: 4,
  cancelled: -1,
};

/**
 * Working-day budget for each stage, used to flag a piece that has been sitting
 * in one place too long. This is what turns a passive timeline into something
 * that surfaces a stalled order before the customer calls to ask.
 */
export const STAGE_SLA_DAYS: Partial<Record<OrderStatus, number>> = {
  booked: 2,
  designing: 4,
  casting: 3,
  stone_setting: 5,
  polishing: 3,
  qc: 2,
  ready: 7, // waiting on the customer to collect
};

/** The stages an order may legitimately move to next, given where it is now. */
export function nextStages(from: OrderStatus): OrderStatus[] {
  if (TERMINAL_STAGES.includes(from)) return [];
  return [...ALLOWED_NEXT[from], OrderStatus.cancelled];
}

/**
 * Validate a stage move, throwing a message that tells the user what they CAN do
 * rather than just refusing.
 */
export function assertTransitionAllowed(from: OrderStatus, to: OrderStatus): void {
  if (from === to) {
    throw new BadRequestException(`Order is already at "${STAGE_LABELS[to]}"`);
  }
  if (TERMINAL_STAGES.includes(from)) {
    throw new BadRequestException(
      `Order is already ${STAGE_LABELS[from].toLowerCase()} and cannot be moved`,
    );
  }
  if (to === OrderStatus.cancelled) return; // always reachable, gated on role + reason
  if (!ALLOWED_NEXT[from].includes(to)) {
    const options = ALLOWED_NEXT[from].map((s) => `"${STAGE_LABELS[s]}"`).join(', ');
    throw new BadRequestException(
      `Cannot move from "${STAGE_LABELS[from]}" to "${STAGE_LABELS[to]}". ` +
        (options ? `Next allowed: ${options}, or cancel.` : 'Only cancellation is available.'),
    );
  }
}

/** Enforce the minimum role for entering a stage (delivery, cancellation). */
export function assertStageRoleAllowed(role: Role, to: OrderStatus): void {
  const required = STAGE_MIN_ROLE[to];
  if (required && ROLE_RANK[role] < ROLE_RANK[required]) {
    throw new ForbiddenException(
      `Moving an order to "${STAGE_LABELS[to]}" requires ${ROLE_LABELS[required]} or above`,
    );
  }
}
