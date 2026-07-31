/**
 * Legacy (APRS-SJEP) -> Eclat field coercion + mapping helpers.
 *
 * Ported verbatim from the proven one-time backfill (scripts/backfill-legacy.mjs)
 * so the live `/sync/*` route and the backfill produce IDENTICAL Eclat rows. The
 * sync agent (data_sync/EclatSync/sync_sjep.py) sends records keyed by the legacy
 * column names; these helpers normalise them.
 */

/** Decimal -> string (Prisma Decimal input) or null. */
export function dec(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

/** Integer or null. */
export function int(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : Math.trunc(Number(v));
}

/** Trimmed non-empty string or null. */
export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * Parse a date coming over JSON from the sync agent. Accepts ISO strings, epoch
 * milliseconds, the PowerShell `/Date(ms)/` shape, and native Date.
 */
export function dt(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  let val: unknown = v;
  if (typeof val === 'string') {
    const m = val.match(/\/Date\((-?\d+)\)\//);
    if (m) val = Number(m[1]);
  }
  const d = new Date(val as string | number);
  return isNaN(d.getTime()) ? null : d;
}

/** Truthy across SQL Server bit (1/true/"1"). */
export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

/** Legacy ToneFor (G=gold, D=diamond) + ToneCode -> Eclat MetalKind. */
export function metalFromTone(toneFor: unknown, toneCode: unknown): string {
  const c = String(toneCode ?? '').toUpperCase();
  if (c.includes('PG') || c.includes('PINK') || c.includes('ROSE')) return 'rose_gold_18k';
  // Legacy doesn't store karat on the tone; default gold pieces to 22k (dominant
  // retail purity in this market). Karat refinement needs the live RateChart join.
  if (String(toneFor ?? '').toUpperCase() === 'G') return 'gold_22k';
  return 'gold_22k';
}

export function karatFromMetal(metal: string): number {
  return (
    {
      gold_24k: 24,
      gold_22k: 22,
      gold_18k: 18,
      rose_gold_18k: 18,
      platinum: 0,
      silver: 0,
    }[metal] ?? 0
  );
}

/** Legacy JewelTrans.TranType -> Eclat SaleDocType. */
export function docTypeFromTranType(tt: unknown): string {
  const t = String(tt ?? '').toUpperCase();
  if (t === 'JWSL' || t === 'BJWSL') return 'sale';
  if (t === 'JWPH' || t === 'BJWPH') return 'purchase';
  if (t === 'JWPRM') return 'proforma';
  if (t.includes('BA')) return 'branch_transfer'; // JWBAP / JWBAI
  return 'sale';
}

/**
 * Legacy `Inward.Status` -> Eclat `StockStatus`.
 *
 * The letters are not ours to invent: they are the rows of the legacy system's
 * own `Const_InwardStatus` master, read off the client's live database.
 *
 *   A On Hand              B Broken                C Memo
 *   D Repair Issue         E Reversal Issue        G Merge Issue
 *   I Inward Repair Issue  J Jewellery Merge In Bag
 *   K Memo Split Issue     L Lost                  M Tobe Memo
 *   P Purchase Return      R Memo In Return        S Tobe Sold
 *   T Split Issue          U Branch Memo Issue     V Branch Issue
 *   X Sold
 *
 * This used to read `row.SaleId ? 'sold' : 'in_stock'` — a column that is not
 * even present on this install, so **every** piece imported as in_stock. On the
 * client's live data only 46% are actually On Hand: the rest are sold, lost,
 * broken, out on memo with a customer, or issued to another branch. Eclat would
 * have shown roughly twice the stock that exists, and a salesperson would have
 * promised a customer a ring that was sold last month.
 *
 * Only **A** is sellable. Everything else must land outside
 * `in_stock`/`aging`/`dead_stock`, which is the set the catalogue counts as
 * available (see `ProductsService.stockPresence`).
 *
 * Two judgement calls worth stating:
 *   - `Lost` and `Broken` have no exact Eclat equivalent. They are recorded as
 *     `melted` — not because either was melted, but because that is the bucket
 *     meaning "this piece is not coming back", and the alternative is a label
 *     that lets it be sold.
 *   - An UNKNOWN letter is treated as not-sellable, not as in_stock. Wrongly
 *     hiding a piece costs a sale the staff can see on the shelf; wrongly
 *     showing one costs a promise to a customer that cannot be kept. Unknown
 *     letters are counted and reported by the caller so they never stay unknown.
 */
const INWARD_STATUS: Record<string, string> = {
  A: 'in_stock', // On Hand — the only sellable state
  X: 'sold',

  // Committed to someone: out on approval, or marked to go.
  C: 'reserved', // Memo
  M: 'reserved', // Tobe Memo
  K: 'reserved', // Memo Split Issue
  S: 'reserved', // Tobe Sold

  // Physically gone from this location.
  V: 'transferred', // Branch Issue
  U: 'transferred', // Branch Memo Issue
  D: 'transferred', // Repair Issue
  E: 'transferred', // Reversal Issue
  G: 'transferred', // Merge Issue
  I: 'transferred', // Inward Repair Issue
  J: 'transferred', // Jewellery Merge In Bag
  T: 'transferred', // Split Issue
  P: 'transferred', // Purchase Return
  R: 'transferred', // Memo In Return

  B: 'melted', // Broken
  L: 'melted', // Lost
};

/** The letters above, for callers that want to report what they did not know. */
export const KNOWN_INWARD_STATUSES = new Set(Object.keys(INWARD_STATUS));

export function stockStatusFromInward(row: { SaleId?: unknown; Status?: unknown }): string {
  // A sale reference, where the install has one, is decisive — a piece attached
  // to a bill is sold whatever the status letter still says.
  if (row.SaleId) return 'sold';
  const code = String(row.Status ?? '').trim().toUpperCase();
  if (!code) return 'in_stock'; // no status column at all: the old behaviour
  return INWARD_STATUS[code] ?? 'transferred';
}

/** Highest legacy watermark (UpdateDate else EntryDate) across a record set, as ISO. */
export function maxWatermark(records: Array<Record<string, unknown>>): string | null {
  let max = 0;
  for (const r of records) {
    const d = dt(r.UpdateDate) ?? dt(r.EntryDate);
    if (d && d.getTime() > max) max = d.getTime();
  }
  return max ? new Date(max).toISOString() : null;
}
