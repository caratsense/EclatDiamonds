import { MetalKind } from '@prisma/client';

/**
 * IBJA — the India Bullion and Jewellers Association's daily benchmark, the
 * rate Indian jewellers quote from. Published on ibjarates.com per gram,
 * exclusive of GST, on weekdays (AM and PM sessions); not on weekends or
 * central-government holidays, when the last published rate stands.
 */
export const IBJA_URL = 'https://ibjarates.com/';

/** IBJA fineness → the metals it prices. 18K rose gold is 18K gold. */
const PUBLISHED: Array<[string, MetalKind[]]> = [
  ['999', ['gold_24k']],
  ['916', ['gold_22k']],
  ['750', ['gold_18k', 'rose_gold_18k']],
  ['585', ['gold_14k']],
];

/** Not published by IBJA: derived from the 999 rate by fineness, as IBJA derives its own. */
export const DERIVED_FROM_999: Array<[MetalKind, number]> = [
  ['gold_10k', 0.417],
  ['gold_9k', 0.375],
];

export interface IbjaRates {
  /** The IBJA publication day, YYYY-MM-DD. */
  publishedOn: string;
  /** INR per gram, ex-GST. */
  perGram: Partial<Record<MetalKind, number>>;
  /** Metals whose rate IBJA did not publish and was derived here. */
  derived: MetalKind[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function lastLabelDate(html: string, id: string): string | null {
  const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
  if (!m) return null;
  try {
    const j = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as { labels?: string[] } & Record<string, number[]>;
    const label = j.labels?.[j.labels.length - 1];
    const d = label?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return d ? `${d[3]}-${d[2]}-${d[1]}` : null;
  } catch {
    return null;
  }
}

function lastSeriesValue(html: string, id: string, key: string): number | null {
  const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
  if (!m) return null;
  try {
    const j = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as Record<string, unknown>;
    const s = j[key];
    const v = Array.isArray(s) ? Number(s[s.length - 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The latest IBJA rates from the ibjarates.com page, or null when the page does
 * not carry a believable 999 rate — a changed page layout must stop the refresh,
 * never store a wrong number. Each published fineness is checked against 999 ×
 * its fineness (IBJA derives them that way) and dropped if it disagrees by >3%.
 */
export function parseIbja(html: string): IbjaRates | null {
  const span = (fineness: string): number | null => {
    const m = html.match(new RegExp(`id="GoldRatesCompare${fineness}"[^>]*>\\s*([\\d.,]+)\\s*<`));
    const v = m ? Number(m[1].replace(/,/g, '')) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const fine = span('999');
  if (fine == null || fine < 1_000 || fine > 100_000) return null;
  const publishedOn = lastLabelDate(html, 'HdnGold');
  if (!publishedOn) return null;

  const perGram: Partial<Record<MetalKind, number>> = {};
  for (const [fineness, metals] of PUBLISHED) {
    const v = span(fineness);
    const expected = (fine * Number(fineness)) / 1000;
    if (v == null || Math.abs(v - expected) / expected > 0.03) continue;
    for (const metal of metals) perGram[metal] = round2(v);
  }
  perGram.gold_24k = round2(fine);
  const derived: MetalKind[] = [];
  for (const [metal, fineness] of DERIVED_FROM_999) {
    perGram[metal] = round2(fine * fineness);
    derived.push(metal);
  }
  // Silver is published per kilogram; stored per gram like everything else.
  const silverKg = lastSeriesValue(html, 'HdnSilver', 'silverRate');
  if (silverKg != null && silverKg > 10_000 && silverKg < 10_000_000 && lastLabelDate(html, 'HdnSilver') === publishedOn) {
    perGram.silver = round2(silverKg / 1000);
  }
  return { publishedOn, perGram, derived };
}
