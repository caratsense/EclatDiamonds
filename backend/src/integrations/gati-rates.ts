import { MetalKind } from '@prisma/client';

/**
 * Gati's daily rate master — `RateDailyMst` — as the shop types it every
 * morning (Gati SJE Plus → Masters → Daily Rate). One row per raw material,
 * INR per gram. `GOLD` is fine (24K) gold; `SILVER` is fine silver; `OLD GOLD`
 * is the buy-back rate and is not a selling price, so it is not mapped.
 *
 * Mapped by `RawMst.RawName`, not `RawNo`: the number is an identity value on
 * one install, the name is what the shop reads on the Daily Rate screen.
 */
const RAW_NAME_METALS: Record<string, Array<[MetalKind, number]>> = {
  // Fineness as IBJA publishes/derives it (ibja-rates.ts), so a Gati 22K rate
  // and an IBJA 22K rate are the same arithmetic on their own 24K number.
  GOLD: [
    ['gold_24k', 1],
    ['gold_22k', 0.916],
    ['gold_18k', 0.75],
    ['rose_gold_18k', 0.75],
    ['gold_14k', 0.585],
    ['gold_12k', 0.5],
    ['gold_10k', 0.417],
    ['gold_9k', 0.375],
  ],
  SILVER: [['silver', 1]],
};

export interface GatiRateRow {
  metal: MetalKind;
  ratePerGram: number;
  /** Not keyed in Gati; derived here from the fine rate by fineness. */
  derived: boolean;
  /** Stable per (rate day, metal, rate): a re-send renews, a new rate adds a row. */
  legacyId: string;
  /** The Gati rate day (`RateDailyMst_LogMain.RateDate`), or its last edit. */
  rateDate: Date | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function day(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : 'undated';
}

function toDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The CaratOS MetalRate rows one batch of `RateDailyMst` records stands for.
 *
 * Returns `{ rows, used }`: `used` counts the input records that mapped to a
 * metal, so the sync ack can report the rest (OLD GOLD, a zero rate) as
 * deliberately skipped rather than silently dropped.
 */
export function gatiRateRows(records: Array<Record<string, unknown>>): {
  rows: GatiRateRow[];
  used: number;
} {
  const rows: GatiRateRow[] = [];
  let used = 0;
  for (const r of records) {
    const name = String(r.RawName ?? '').trim().toUpperCase();
    const map = RAW_NAME_METALS[name];
    const fine = Number(r.SaleRate);
    if (!map || !Number.isFinite(fine) || fine <= 0) continue;
    const rateDate = toDate(r.RateDate) ?? toDate(r.UpdateDate) ?? toDate(r.EntryDate);
    for (const [metal, mult] of map) {
      const ratePerGram = round2(fine * mult);
      const derived = mult !== 1;
      rows.push({
        metal,
        ratePerGram,
        derived,
        legacyId: `gati:${day(rateDate)}:${metal}:${ratePerGram}${derived ? ':derived' : ''}`,
        rateDate,
      });
    }
    used++;
  }
  return { rows, used };
}
