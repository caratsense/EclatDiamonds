import { Role, SpecialRequestKind } from '@prisma/client';
import { ROLE_RANK } from '../common/role.util';

/**
 * Who has to sign off a branch's special request.
 *
 * Mirrors the discount ladder the platform already runs on, so approvers deal
 * with one mental model rather than two: the request names the minimum role that
 * may decide it, and anyone at or above that rank can act.
 */

/**
 * The floor for each kind of request, regardless of value.
 *
 * `diamond_rate` sits at head office because HO owns the `DiamondRate` table —
 * approving one WRITES a new rate that every branch then prices against, so it
 * is a pricing-policy change dressed as a single request, not a local call.
 */
const KIND_MIN_ROLE: Record<SpecialRequestKind, Role> = {
  diamond_rate: Role.head_office,
  price_override: Role.area_manager,
  purchase: Role.area_manager,
  stock_transfer: Role.store_manager,
  expense: Role.store_manager,
  staff: Role.store_manager,
  other: Role.store_manager,
};

/**
 * Value thresholds (INR) that pull a request further up the ladder, checked
 * highest-first. A ₹5,000 stock transfer is a store-manager call; the same
 * request for ₹5,00,000 is not.
 */
const AMOUNT_ESCALATION: { above: number; role: Role }[] = [
  { above: 100_000, role: Role.head_office },
  { above: 25_000, role: Role.area_manager },
];

/** Human-readable summary of a kind, for notification bodies and the assistant. */
export const REQUEST_KIND_LABELS: Record<SpecialRequestKind, string> = {
  diamond_rate: 'Diamond rate',
  price_override: 'Price override',
  stock_transfer: 'Stock transfer',
  purchase: 'Purchase',
  expense: 'Expense',
  staff: 'Staffing',
  other: 'Other',
};

/** The next role up from `role`, or null at the top of the ladder. */
export function roleAbove(role: Role): Role | null {
  const ordered = (Object.keys(ROLE_RANK) as Role[]).sort(
    (a, b) => ROLE_RANK[a] - ROLE_RANK[b],
  );
  return ordered.find((r) => ROLE_RANK[r] > ROLE_RANK[role]) ?? null;
}

/**
 * The minimum role that may decide a request.
 *
 * Takes the strictest of three constraints:
 *  1. the floor for that kind of request;
 *  2. any escalation the amount triggers;
 *  3. **one rank above the requester** — the separation-of-duties rule. Without
 *     this a store manager could raise a routine expense request and immediately
 *     approve it, which is precisely the loophole the approval guardrails close
 *     everywhere else.
 *
 * head_office has nothing above it, so a request it raises stays at head_office
 * — but `assertNotSelfApproval` still stops the raiser personally deciding it,
 * meaning it needs a second HO user. That is the correct outcome: the top of the
 * ladder is a four-eyes check, not a free pass.
 */
export function resolveRequiredRole(
  kind: SpecialRequestKind,
  requesterRole: Role,
  amount?: number | null,
): Role {
  let required = KIND_MIN_ROLE[kind];

  if (amount != null) {
    for (const tier of AMOUNT_ESCALATION) {
      if (amount > tier.above && ROLE_RANK[tier.role] > ROLE_RANK[required]) {
        required = tier.role;
        break; // thresholds are ordered highest-first
      }
    }
  }

  // At the top of the ladder there is nobody above, so fall back to the
  // requester's OWN rank rather than leaving the kind floor in place. Without
  // this clamp a head-office expense request would route down to a store
  // manager — inverting the hierarchy and letting a junior approve their
  // superior's spend. The four-eyes requirement is still met, because
  // `assertNotSelfApproval` forces a different head-office user to decide it.
  const floor = roleAbove(requesterRole) ?? requesterRole;
  if (ROLE_RANK[floor] > ROLE_RANK[required]) required = floor;

  return required;
}

/** True when `role` may decide a request requiring `requiredRole`. */
export function canDecide(role: Role, requiredRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[requiredRole];
}
