/**
 * What stops a quote being saved, said in a way that names the row.
 *
 * Pulled out of the builder so it can be tested without rendering anything.
 * It used to live inside the component, which meant the only way to check an
 * error message was to drive the whole screen — so in practice nobody did, and
 * a message that could not be acted on went to production.
 *
 * The rule every message here follows: SAY WHICH ROW. "a diamond has no code"
 * was true and useless on a quote with four stone rows, because nothing on the
 * page said which one was meant. Each message now carries the item number and,
 * for a stone, its position in that item's list.
 */
import type { ItemRow, StoneRow } from "./quote-item-editor";
import { num, sizeText } from "./quote-item-editor";

/** The material lists a code is checked against. Empty lists check nothing. */
export interface ValidationLists {
  metals: { code: string; karat: number | null }[];
  diamonds: { code: string }[];
  stones: { code: string }[];
}

/** What the builder knows about today's gold rate for a karat. */
export interface RateCheck {
  fallback: boolean;
  stale: boolean;
}

/*
 * A stone row somebody added and never filled in.
 *
 * "+ Diamond" appends an empty row, and it used to make the whole quote
 * unsaveable. An untouched row is not an error, it is one they changed their
 * mind about.
 *
 * Only a WHOLLY blank row. A row carrying any figure — pieces, carats, a rate,
 * a discount, even just a size — must still name its stone, or a half-filled
 * line would be dropped without a word and the quote would go out short.
 */
export function blankStone(s: StoneRow): boolean {
  return (
    !s.code.trim() &&
    !s.size.trim() &&
    !(num(s.pieces) ?? 0) &&
    !(num(s.carats) ?? 0) &&
    !(num(s.rate) ?? 0) &&
    !(num(s.discount) ?? 0)
  );
}

export const realStones = (it: ItemRow) => it.stones.filter((s) => !blankStone(s));

const kindOf = (s: StoneRow) => (s.type === "D" ? "diamond" : "colour stone");

/**
 * The first thing stopping these items being priced, or null.
 *
 * First, not all: a person fixes one field and presses save again, and a list
 * of six complaints about a form they have not finished is noise. The order
 * follows the screen top to bottom, so the message always points forward.
 */
export function itemProblem(
  items: ItemRow[],
  lists: ValidationLists,
  karatOf: (it: ItemRow) => number,
  rateCheck: (karat: number) => RateCheck,
  karatsText: string,
): string | null {
  const priced = items.filter((it) => (num(it.weight) ?? 0) > 0 || realStones(it).length > 0);
  if (!priced.length) return "Add a gold weight or a diamond to an item.";

  for (const [i, it] of items.entries()) {
    if (!priced.includes(it)) continue;
    const n = items.length > 1 ? `Item ${i + 1}` : "This item";
    const weight = num(it.weight) ?? 0;

    if (!it.itemType) return `${n}: pick the item type.`;
    if (weight > 0 && !karatOf(it)) return `${n}: pick the metal (${karatsText}).`;
    if (weight > 0 && !num(it.manualRate)) {
      // A quote freezes the gold rate it was priced at. It must not freeze a
      // built-in default or a rate that has gone out of date while looking
      // like today's: with either, the person confirms today's by typing it.
      const a = rateCheck(karatOf(it));
      if (a.fallback || a.stale) {
        return `${n}: the ${karatOf(it)}K gold rate is not today's — type today's rate in the Gold row.`;
      }
    }

    const rows = realStones(it);
    for (const [j, s] of rows.entries()) {
      // "Stone 3 of 4" rather than the row's own index: blank rows are dropped
      // before this, so an index into the raw list would point at the wrong
      // line on screen.
      const where = rows.length > 1 ? `${n}, stone ${j + 1} of ${rows.length}` : n;
      const list = s.type === "D" ? lists.diamonds : lists.stones;

      if (!s.code.trim()) {
        return `${where}: this ${kindOf(s)} row has figures but no code — pick one, or clear the row to drop it.`;
      }
      if (list.length && !list.some((m) => m.code === s.code.trim())) {
        return `${where}: "${s.code}" is not a ${kindOf(s)} code — pick one from the list.`;
      }
      if (!((num(s.carats) ?? 0) > 0)) return `${where}: ${s.code} needs its carats.`;
      // `num`, never `pct`: pct() clamps to 0..100, so comparing a clamped
      // value against 100 can never be true and all three of these guards
      // would be dead code. The raw typed value is what is being judged.
      if ((num(s.discount) ?? 0) > 100) return `${where}: ${s.code} has a discount over 100%.`;
    }

    if ((num(it.metalDiscount) ?? 0) > 100) return `${n}: the gold discount cannot be over 100%.`;
    if ((num(it.makingDiscount) ?? 0) > 100) return `${n}: the making discount cannot be over 100%.`;
    if (sizeText(it).length > 30) return `${n}: the size is too long.`;
  }
  return null;
}
