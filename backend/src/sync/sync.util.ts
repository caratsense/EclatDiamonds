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

/** Legacy Inward.Status/SaleId -> Eclat StockStatus. */
export function stockStatusFromInward(row: { SaleId?: unknown }): string {
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
