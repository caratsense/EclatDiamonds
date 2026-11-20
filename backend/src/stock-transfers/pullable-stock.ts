import { Prisma, StockStatus } from '@prisma/client';

import { stockClassWhere } from '../stock/stock-class';

/**
 * Statuses from which a piece may be pulled into a transfer / reserved — and,
 * identically, the only pieces another branch is ever shown when it asks.
 *
 * One definition because the picker and the create-time check must agree: a
 * piece offered in the picker that `create` then refuses is a salesperson
 * promising a customer something the server will not do.
 */
export const TRANSFERABLE_STATUSES: StockStatus[] = ['in_stock', 'aging', 'dead_stock'];

/** The words the stock ledger puts on those three. */
const STATUS_LABEL: Partial<Record<StockStatus, string>> = {
  in_stock: 'In stock',
  aging: 'Aging',
  dead_stock: 'Dead stock',
};

/**
 * THE cross-branch read, and the only one in the platform.
 *
 * ## What is now visible, to whom, and why that is acceptable
 *
 * Branch staff (salesperson and up, holding the `stock-transfers` screen) may
 * see, at ONE named branch of their own organisation at a time, the pieces that
 * branch currently has available — SKU, design name and number, category,
 * metal, karat, gross weight, and that it is available. That is what a
 * salesperson needs in order to say "Borivali has one, shall I ask for it"
 * and nothing more.
 *
 * What it deliberately does not carry: no tag price, MRP, cost or margin — the
 * ask is about availability, not about pricing another branch's shelf, and the
 * design's own indicative price is already in the catalogue every branch sees.
 * No sold, reserved, melted, damaged or in-transit pieces either: a piece that
 * cannot be asked for is not the asker's business. The same is true of HUID,
 * certificate and hallmark numbers — they identify the piece to a regulator,
 * not to somebody deciding whether to ask for it.
 *
 * Why it is acceptable: the pieces are the same organisation's stock, the
 * branch asked about finds out the moment a request is raised (the pull lands
 * in their list and their manager answers it), and nothing here lets the asker
 * move a piece — only ask. The widening is bounded by purpose: it lives on the
 * transfer module, takes one explicit `fromStoreId`, and no other code path
 * reads it, so `StoreScopeService` keeps governing every other stock read
 * exactly as before. GET /stock, the summary, the by-store view and dead stock
 * are untouched and remain limited to a caller's own branches.
 */
export function pullableStockWhere(
  organisationId: string,
  fromStoreId: string,
  q?: string,
): Prisma.StockItemWhereInput {
  const search = q?.trim();
  return {
    // Tenant first, branch second. Both are pinned by the caller's own
    // organisation and by a store the service has already checked belongs to
    // it — never by anything the request body says on its own.
    organisationId,
    storeId: fromStoreId,
    status: { in: TRANSFERABLE_STATUSES },
    // Sellable merchandise only, as low-stock counts it: a customised piece is
    // another customer's order and a display piece is not for sale.
    AND: [stockClassWhere('standard')],
    ...(search
      ? {
          OR: [
            { sku: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            // The person at the counter types whichever code is in front of
            // them — the design number on the docket or the piece number on
            // the tag — exactly as they would on their own stock list.
            { styleNumber: { contains: search, mode: 'insensitive' } },
            { vin: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

/** One row of the cross-branch picker, as the asking branch is allowed to see it. */
export interface PullableStockRow {
  id: string;
  sku: string;
  name: string;
  styleNumber: string | null;
  category: string;
  metal: string | null;
  karat: number;
  grossGrams: number;
  status: string;
  storeId: string;
  storeName: string;
}

/**
 * Map a piece for the picker.
 *
 * Written out field by field rather than reusing the stock ledger's own view:
 * that one carries `tagPrice`, and a shared mapper is how a money column ends
 * up on another branch's screen the next time somebody adds one to it.
 */
export function pullableStockView(s: {
  id: string;
  sku: string | null;
  name: string | null;
  styleNumber: string | null;
  category: string;
  metal: string | null;
  karat: number | null;
  grossWeight: Prisma.Decimal | null;
  status: StockStatus;
  storeId: string;
  store?: { name: string } | null;
  product?: { name: string | null; styleNumber: string | null } | null;
}): PullableStockRow {
  return {
    id: s.id,
    sku: s.sku ?? '',
    // A synced piece carries its design's name on the linked product, the same
    // fallback the stock ledger uses.
    name: s.name ?? s.product?.name ?? '',
    styleNumber: s.styleNumber ?? s.product?.styleNumber ?? null,
    category: s.category,
    metal: s.metal ?? null,
    karat: s.karat ?? 0,
    grossGrams: s.grossWeight != null ? Number(s.grossWeight) : 0,
    status: STATUS_LABEL[s.status] ?? s.status,
    storeId: s.storeId,
    storeName: s.store?.name ?? '',
  };
}
