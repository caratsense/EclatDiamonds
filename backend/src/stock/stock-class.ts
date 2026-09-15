import { Prisma, StockClass } from '@prisma/client';

/**
 * One definition of "what kind of stock is this piece", read by every screen
 * that counts stock as available, dead or sellable.
 *
 * A piece's own classification wins; NULL means it inherits its design's; a
 * piece with no design is ordinary stock. Written once here because the stock
 * summary, the dead-stock list and the catalogue's "on the shelf" count each
 * resolving it their own way is how a customised ring ends up sellable on one
 * screen and excluded on the next.
 */

export const STOCK_CLASSES: StockClass[] = ['standard', 'customised', 'non_stock'];

export const STOCK_CLASS_LABEL: Record<StockClass, string> = {
  standard: 'Standard stock',
  customised: 'Customised / made to order',
  non_stock: 'Non-stock (display / sample)',
};

export function effectiveStockClass(item: {
  stockClass: StockClass | null;
  product?: { stockClass: StockClass } | null;
}): StockClass {
  return item.stockClass ?? item.product?.stockClass ?? 'standard';
}

/** The same resolution as a Prisma filter, for queries that never load the rows. */
export function stockClassWhere(cls: StockClass): Prisma.StockItemWhereInput {
  const inherited: Prisma.StockItemWhereInput =
    cls === 'standard'
      ? { OR: [{ productId: null }, { product: { is: { stockClass: 'standard' } } }] }
      : { product: { is: { stockClass: cls } } };
  return { OR: [{ stockClass: cls }, { AND: [{ stockClass: null }, inherited] }] };
}

/**
 * A spreadsheet's word for it, or null when the word is not one we recognise.
 *
 * Deliberately no yes/no forms. "Y" under a column called "Made to order" and
 * "Y" under one called "Display piece" mean opposite things, and a mapping only
 * knows the field, never what the header meant — so a bare boolean is reported
 * back rather than guessed at.
 */
export function parseStockClass(raw: string | null | undefined): StockClass | null {
  const v = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!v) return null;
  return WORDS.get(v) ?? null;
}

const WORDS = new Map<string, StockClass>([
  ...(['standard', 'std', 'stock', 'standardstock', 'regular', 'ready', 'readystock', 'normal', 'general', 'ordinary']
    .map((w) => [w, 'standard'] as const)),
  ...(['customised', 'customized', 'custom', 'customorder', 'madetoorder', 'mto', 'bespoke', 'customerorder',
    'personalised', 'personalized', 'order', 'orderpiece']
    .map((w) => [w, 'customised'] as const)),
  ...(['nonstock', 'notstock', 'display', 'displaypiece', 'sample', 'showpiece', 'demo', 'dummy', 'notforsale', 'nfs',
    'exhibition']
    .map((w) => [w, 'non_stock'] as const)),
]);
