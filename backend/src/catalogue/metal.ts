import { MetalKind } from '@prisma/client';

/**
 * The one karat → MetalKind mapping for every catalogue source.
 *
 * It replaces a website table that mapped 9KT and 14KT to 18K: a 9KT ring
 * recorded as 18K is priced and filtered as something it is not. Colour (rose,
 * white, yellow) never changes the enum — it lives on the variant. Anything we
 * cannot read is `gold_unspecified`, never a guess.
 */
const GOLD: Record<number, MetalKind> = {
  9: 'gold_9k',
  10: 'gold_10k',
  14: 'gold_14k',
  18: 'gold_18k',
  22: 'gold_22k',
  24: 'gold_24k',
};

/** "9KT", "14 kt", "18K", 22, "750" → 9, 14, 18, 22, 18. Null when unreadable. */
export function parseKarat(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  const fineness: Record<string, number> = { '375': 9, '417': 10, '585': 14, '750': 18, '916': 22, '999': 24 };
  if (fineness[s]) return fineness[s];
  const m = /^(\d{1,2})\s*(K|KT|KARAT|CT)?$/.exec(s.replace(/\s+/g, ' '));
  return m ? Number(m[1]) : null;
}

/** MetalKind for a metal name and karat, from any source. */
export function karatToMetal(metalName: unknown, karat: unknown): MetalKind {
  const name = String(metalName ?? '').toLowerCase();
  if (name.includes('platinum')) return 'platinum';
  if (name.includes('silver')) return 'silver';
  const k = parseKarat(karat);
  return (k != null && GOLD[k]) || 'gold_unspecified';
}
