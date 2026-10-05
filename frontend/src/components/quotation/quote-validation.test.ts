/**
 * What a person is told when a quote cannot be saved.
 *
 * These rules used to live inside the builder, so checking a message meant
 * driving the whole screen — which nobody did, and a message that could not be
 * acted on reached production: "Item 1: a diamond has no code", on a quote
 * with four stone rows and nothing on the page to say which row was meant.
 *
 * Two things are asserted throughout: that the right problem is reported, and
 * that the message NAMES THE ROW it is about.
 */
import { describe, expect, it } from "vitest";

import { blankStone, itemProblem, realStones } from "./quote-validation";
import type { ItemRow, StoneRow } from "./quote-item-editor";

const stone = (patch: Partial<StoneRow> = {}): StoneRow => ({
  id: 1, type: "D", code: "", size: "", pieces: "", carats: "",
  rate: "", rateAuto: true, discount: "", ...patch,
});

const item = (patch: Partial<ItemRow> = {}): ItemRow => ({
  id: 1, itemType: "ALR", styleNumber: "", metalCode: "G14YG", weight: "3.000",
  manualRate: "5500", size: "", sizeUnit: "", makingRate: "", makingDiscount: "",
  metalDiscount: "", remark: "", stones: [], ...patch,
});

const LISTS = {
  metals: [{ code: "G14YG", karat: 14 }],
  diamonds: [{ code: "LG-RND-VVS-E-F" }, { code: "D-RND-BK" }],
  stones: [{ code: "LG-RB-OVL" }],
};
const karatOf = (it: ItemRow) => (it.metalCode === "G14YG" ? 14 : 0);
const freshRate = () => ({ fallback: false, stale: false });
const check = (items: ItemRow[], rate = freshRate) =>
  itemProblem(items, LISTS, karatOf, rate, "9/12/14/18K");

const GOOD = stone({ code: "LG-RND-VVS-E-F", carats: "2.00", rate: "30000" });

describe("a quote with nothing wrong", () => {
  it("reports no problem", () => {
    expect(check([item({ stones: [GOOD] })])).toBeNull();
  });

  it("is still fine with gold only and no stones", () => {
    expect(check([item({ stones: [] })])).toBeNull();
  });
});

describe("the untouched row that blocked a real quote", () => {
  it("is ignored, so a complete quote saves", () => {
    // Exactly the production case: three filled stones and one blank.
    const items = [item({ stones: [GOOD, { ...GOOD, id: 2 }, { ...GOOD, id: 3 }, stone({ id: 4 })] })];
    expect(check(items)).toBeNull();
  });

  it("is dropped from what gets priced and saved", () => {
    expect(realStones(item({ stones: [GOOD, stone({ id: 2 })] }))).toHaveLength(1);
  });

  it("counts a row as blank even when its numbers default to zero", () => {
    expect(blankStone(stone({ pieces: "0", carats: "0", rate: "0", discount: "0" }))).toBe(true);
  });

  it("never drops a row that carries a figure", () => {
    for (const p of [{ carats: "2.00" }, { pieces: "4" }, { rate: "30000" }, { discount: "5" }, { size: "5.5-6" }]) {
      expect(blankStone(stone(p))).toBe(false);
    }
  });
});

describe("a missing field names the row it is in", () => {
  it("tells you WHICH stone has figures but no code", () => {
    const items = [item({ stones: [GOOD, stone({ id: 2, carats: "1.00" })] })];
    const msg = check(items)!;
    expect(msg).toContain("stone 2 of 2");
    expect(msg).toMatch(/no code/);
    // And says what to do about it, both ways.
    expect(msg).toMatch(/clear the row/);
  });

  it("names a code that is not in the master", () => {
    const items = [item({ stones: [stone({ code: "NOT-A-CODE", carats: "1.00" })] })];
    expect(check(items)).toContain('"NOT-A-CODE" is not a diamond code');
  });

  it("calls a colour stone a colour stone, not a diamond", () => {
    const items = [item({ stones: [stone({ type: "C", code: "NOPE", carats: "1" })] })];
    expect(check(items)).toContain("colour stone code");
  });

  it("asks for carats on the stone that lacks them", () => {
    const items = [item({ stones: [GOOD, { ...GOOD, id: 2, carats: "" }] })];
    const msg = check(items)!;
    expect(msg).toContain("stone 2 of 2");
    expect(msg).toContain("needs its carats");
  });

  it("names the item when there is more than one", () => {
    const items = [item({ stones: [GOOD] }), item({ id: 2, itemType: "", stones: [GOOD] })];
    expect(check(items)).toContain("Item 2");
  });

  it("does not say 'Item 1' when there is only one item", () => {
    // Nothing to disambiguate, so the number is noise.
    expect(check([item({ itemType: "", stones: [GOOD] })])).toContain("This item");
  });
});

describe("the other things that stop a save", () => {
  it("refuses an empty quote", () => {
    expect(check([item({ weight: "", stones: [] })])).toContain("Add a gold weight or a diamond");
  });

  it("asks for the item type", () => {
    expect(check([item({ itemType: "", stones: [GOOD] })])).toContain("pick the item type");
  });

  it("asks for the metal when there is gold weight", () => {
    expect(check([item({ metalCode: "", stones: [GOOD] })])).toContain("pick the metal");
  });

  it("refuses to freeze a gold rate that is not today's", () => {
    const items = [item({ manualRate: "", stones: [GOOD] })];
    const msg = check(items, () => ({ fallback: false, stale: true }))!;
    expect(msg).toContain("not today's");
    // Points at the row to type it into.
    expect(msg).toContain("Gold row");
  });

  it("catches a discount over 100% on a stone, the gold and the making", () => {
    expect(check([item({ stones: [{ ...GOOD, discount: "120" }] })])).toContain("discount over 100%");
    expect(check([item({ metalDiscount: "150", stones: [GOOD] })])).toContain("gold discount cannot be over 100%");
    expect(check([item({ makingDiscount: "150", stones: [GOOD] })])).toContain("making discount cannot be over 100%");
  });

  it("catches a size that is too long", () => {
    expect(check([item({ size: "x".repeat(40), stones: [GOOD] })])).toContain("size is too long");
  });
});
