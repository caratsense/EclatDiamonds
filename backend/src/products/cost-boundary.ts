import { Role } from '@prisma/client';
import { ROLE_RANK } from '../common/role.util';

/**
 * How much of what a design COSTS the shop a viewer may see.
 *
 *   none    — salesperson, storeperson, and every public/unauthenticated path:
 *             weights, counts, the selling price. No rate, amount, margin,
 *             making charge or landed cost — a screen turned round to a customer
 *             must not show what the shop pays.
 *   amounts — store manager and area manager: rates, line amounts, margins,
 *             component amounts, cost. Not the supplier's raw-material ids.
 *   full    — head office: everything, including `rawMaterialId`.
 */
export type CostTier = 'none' | 'amounts' | 'full';

export function costTier(role: Role | null | undefined): CostTier {
  if (!role) return 'none';
  if (role === 'head_office') return 'full';
  return ROLE_RANK[role] >= ROLE_RANK.store_manager ? 'amounts' : 'none';
}

/** Keys that carry a price the shop pays or makes (BOM lines, variant attributes). */
const COST_KEY = /rate|amount|cost|price|margin|making|charge|linetotal|^total$|^value$/i;
const RAW_MATERIAL_KEY = /rawmaterial/i;

/**
 * Strip cost keys from source JSON (a website BOM, variant attributes) at any
 * depth. A denylist on key NAMES, because the source's shape is not ours and a
 * nested `{ rate }` must not slip through just because it moved a level down.
 */
export function stripCostJson(v: unknown, tier: CostTier): unknown {
  if (tier === 'full' || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => stripCostJson(x, tier));
  if (typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !RAW_MATERIAL_KEY.test(k) && (tier === 'amounts' || !COST_KEY.test(k)))
      .map(([k, x]) => [k, stripCostJson(x, tier)]),
  );
}

/** Variant columns and ProductPrice kinds that reveal margin. */
export const VARIANT_COST_FIELDS = ['priceWithMargin', 'marginPercentage', 'makingCharge'] as const;
export const COST_PRICE_KINDS = new Set(['variant_with_margin']);
/** StockItem columns that are what the piece cost, not what it sells for. */
export const STOCK_COST_FIELDS = [
  'metalAmount',
  'diamondAmount',
  'stoneAmount',
  'makingAmount',
  'cpfAmount',
  'cost',
] as const;
