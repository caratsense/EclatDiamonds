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

/**
 * Per-piece KARAT. The base-metal karat is carried literally in the piece's code
 * as a `-14KT-` / `-18KT-` / `-9KT-` token (validated 100% on the client's live
 * data against the authoritative `InwardDetail(IsBase=1) → SPM_Items → QualityMst`
 * join: 14KT×2128, 9KT×450, 18KT×112). The extractor may also attach an explicit
 * `Karat` int; prefer it, else parse the token off any code field.
 */
export function karatFromRow(r: any): number | null {
  const explicit = Number(r?.Karat);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const code = String(
    r?.InwardSKUNo ?? r?.StyleSKUNo ?? r?.JewelCode ?? r?.StyleCode ?? '',
  );
  const m = code.match(/-(\d{1,2})\s*KT?-/i);
  return m ? Number(m[1]) : null;
}

/**
 * Tone + karat -> Eclat MetalKind. Colour comes from the tone (PG/PINK/ROSE ->
 * rose gold); the karat (karatFromRow) picks the gold bucket. The EXACT karat
 * always rides on the Int column — the enum is a coarse label.
 */
export function metalFromRow(r: any): string {
  const tone = String(r?.ToneCode ?? '').toUpperCase();
  const code = String(
    r?.InwardSKUNo ?? r?.StyleSKUNo ?? r?.JewelCode ?? r?.StyleCode ?? '',
  ).toUpperCase();
  if (tone.includes('PG') || tone.includes('PINK') || tone.includes('ROSE') || /-PG-/.test(code))
    return 'rose_gold_18k';
  const k = karatFromRow(r);
  if (k == null) return 'gold_unspecified';
  if (k >= 23) return 'gold_24k'; // 24 / 999 / 995
  if (k === 22) return 'gold_22k';
  if (k === 18) return 'gold_18k';
  if (k === 14) return 'gold_14k';
  if (k === 12) return 'gold_12k';
  if (k === 10) return 'gold_10k';
  if (k === 9) return 'gold_9k';
  return 'gold_unspecified';
}

/** Karat implied by a mapped metal (fallback when no per-row karat is present). */
export function karatFromMetal(metal: string): number | null {
  const k: Record<string, number> = {
    gold_24k: 24,
    gold_22k: 22,
    gold_18k: 18,
    gold_14k: 14,
    gold_12k: 12,
    gold_10k: 10,
    gold_9k: 9,
    rose_gold_18k: 18,
  };
  return k[metal] ?? null;
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
  // `Status` is authoritative — it is the client's Const_InwardStatus letter and
  // is 100% populated. `SaleId` must NOT be trusted first: on this install it is
  // also set on branch-transfer vouchers (every `V` Branch-Issue row carries
  // one), so a SaleId-first rule flips ~550 transferred pieces to a phantom
  // "sold" and drops them from transfer tracking. Use SaleId only as a tie-break
  // when there is no status letter at all.
  const code = String(row.Status ?? '').trim().toUpperCase();
  if (code) return INWARD_STATUS[code] ?? 'transferred';
  return row.SaleId ? 'sold' : 'in_stock';
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
