import { MetalKind } from '@prisma/client';

/**
 * What a design is made of — the "items used" a customer asks about and a
 * manager prices from: the metal, the diamonds, the stones, and the making.
 *
 * Two sources, same shape:
 *   - Gati: the StyleMstSummary totals the sync agent already merges into every
 *     StyleMst row (NetWt, TotDiaWt/Pc/Amt, TotCZWt/Amt, TotMtlAmt,
 *     TotHandlingAmt) — the same columns InwardSummary gives each piece.
 *   - Website: the product feed's `billOfMaterial` (material, weight, rate,
 *     line total).
 * Gati is the authority when it has one; the website only fills a gap.
 */
export type CompositionKind = 'metal' | 'diamond' | 'stone' | 'labour' | 'other';

export interface CompositionLine {
  item: string;
  kind: CompositionKind;
  weight?: number;
  unit?: 'g' | 'ct';
  pieces?: number;
  /** Rate per unit, and the line's amount — margin information (see forViewer). */
  rate?: number;
  amount?: number;
}

export interface Composition {
  source: 'gati' | 'website';
  lines: CompositionLine[];
}

const pos = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const METAL_NAMES: Partial<Record<MetalKind, string>> = {
  gold_24k: 'Gold 24K',
  gold_22k: 'Gold 22K',
  gold_18k: 'Gold 18K',
  gold_14k: 'Gold 14K',
  gold_12k: 'Gold 12K',
  gold_10k: 'Gold 10K',
  gold_9k: 'Gold 9K',
  rose_gold_18k: 'Rose gold 18K',
  platinum: 'Platinum',
  silver: 'Silver',
  gold_unspecified: 'Gold',
};

/** From a Gati StyleMst row with its summary merged in. Null when it carries none. */
export function gatiComposition(r: Record<string, unknown>, metal: MetalKind): Composition | null {
  const lines: CompositionLine[] = [];
  const metalWt = pos(r.NetWt) ?? pos(r.GrossWt);
  if (metalWt || pos(r.TotMtlAmt)) {
    lines.push({ item: METAL_NAMES[metal] ?? 'Metal', kind: 'metal', weight: metalWt, unit: 'g', amount: pos(r.TotMtlAmt) });
  }
  if (pos(r.TotDiaWt) || pos(r.TotDiaPc) || pos(r.TotDiaAmt)) {
    lines.push({ item: 'Diamonds', kind: 'diamond', weight: pos(r.TotDiaWt), unit: 'ct', pieces: pos(r.TotDiaPc), amount: pos(r.TotDiaAmt) });
  }
  if (pos(r.TotCZWt) || pos(r.TotCZPc) || pos(r.TotCZAmt)) {
    lines.push({ item: 'Stones', kind: 'stone', weight: pos(r.TotCZWt), unit: 'ct', pieces: pos(r.TotCZPc), amount: pos(r.TotCZAmt) });
  }
  if (pos(r.TotHandlingAmt)) {
    lines.push({ item: 'Making charges', kind: 'labour', amount: pos(r.TotHandlingAmt) });
  }
  return lines.length ? { source: 'gati', lines: lines.map(clean) } : null;
}

/** From the website feed's billOfMaterial, as import_website.py sends it. */
export function websiteComposition(raw: unknown): Composition | null {
  if (!Array.isArray(raw)) return null;
  const lines: CompositionLine[] = [];
  for (const m of raw) {
    const item = typeof m?.materialName === 'string' ? m.materialName.trim() : '';
    if (!item) continue;
    const kind: CompositionKind = m.isDiamond
      ? 'diamond'
      : /gold|silver|platinum/i.test(item)
        ? 'metal'
        : /making|labou?r|charge/i.test(item)
          ? 'labour'
          : /stone|cz|ruby|emerald|sapphire|pearl|gem/i.test(item)
            ? 'stone'
            : 'other';
    const grams = /^(g|gm|gms|gram|grams)$/i.test(String(m.unit ?? '').trim());
    // The feed labels every diamond weight "gram", but the numbers are carats:
    // "1CT Solitaire Studs" sums to 1.02, "0.50CT Solitaire Studs" to 0.50, a
    // "30 pointer" ring to 0.28. A 1ct stone weighs 0.2g, so read as grams they
    // would be five times too heavy.
    const unit =
      grams && (kind === 'diamond' || kind === 'stone')
        ? 'ct'
        : grams
          ? 'g'
          : /^(ct|cts|carat|carats)$/i.test(String(m.unit ?? '').trim())
            ? 'ct'
            : undefined;
    lines.push(
      clean({
        item,
        kind,
        weight: pos(m.weight),
        unit,
        // "quantity 1" on a gold line is not a piece count.
        pieces: kind === 'diamond' || kind === 'stone' ? pos(m.quantity) : undefined,
        rate: pos(m.rate),
        amount: pos(m.lineTotal),
      }),
    );
  }
  return lines.length ? { source: 'website', lines } : null;
}

/**
 * What this viewer may see. Rates, amounts and making charges show what the
 * shop pays and so what it makes — store managers and up only, never a
 * salesperson's screen or one turned round to a customer. Weights and counts
 * are the piece itself, and everyone sees those.
 */
export function forViewer(c: unknown, amounts: boolean): Composition | null {
  const comp = c as Composition | null;
  if (!comp?.lines?.length) return null;
  if (amounts) return comp;
  return {
    source: comp.source,
    lines: comp.lines
      .filter((l) => l.kind !== 'labour')
      .map(({ rate: _rate, amount: _amount, ...rest }) => rest),
  };
}

/** Drop undefined keys so the stored JSON holds only what is known. */
function clean(l: CompositionLine): CompositionLine {
  return Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)) as CompositionLine;
}
