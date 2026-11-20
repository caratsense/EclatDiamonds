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

import {
  blankStone,
  customerProblems,
  hasUnsavedEntries,
  itemProblem,
  realStones,
  type DraftFields,
} from "./quote-validation";
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

/**
 * Who the quote is for, judged ONE way.
 *
 * The New-quote modal and the customer edit on a saved quote both ask this, so
 * a name or number the one accepts can never be refused by the other — which is
 * how a customer ends up half-corrected on a quote that has already gone out.
 * The rules are the backend's own (`IsRealName`, `IsCustomerPhone`); they are
 * checked here only so the complaint lands next to the box instead of arriving
 * as a 400.
 */
describe("what the customer block will accept", () => {
  it("passes a plain name with a plain Indian mobile", () => {
    expect(customerProblems({ name: "Meera Iyer", phone: "9812370042" })).toEqual({});
  });

  it("passes an international number, because the business quotes overseas", () => {
    expect(customerProblems({ name: "Sophie Laurent", phone: "+442079460958" })).toEqual({});
  });

  it("names the field that is empty, one message each", () => {
    expect(customerProblems({ name: "", phone: "" })).toEqual({
      customer: "Customer name is required.",
      phone: "Phone number is required.",
    });
  });

  it("treats whitespace as empty — it is not a name anyone typed on purpose", () => {
    expect(customerProblems({ name: "   ", phone: "  " }).customer).toBe(
      "Customer name is required.",
    );
  });

  it("refuses a name that is only digits, the way the server does", () => {
    // The "46466" lead: a reference number mis-keyed into the name box.
    expect(customerProblems({ name: "46466", phone: "9812370042" }).customer).toBe(
      "Enter a valid name (letters, not just numbers).",
    );
    expect(customerProblems({ name: "- / .", phone: "9812370042" }).customer).toBeTruthy();
  });

  it("accepts a name that merely contains digits", () => {
    expect(customerProblems({ name: "Flat 2 Mehta", phone: "9812370042" }).customer).toBeUndefined();
  });

  it("refuses a number that is short, long or not a number at all", () => {
    const bad = "Enter a 10-digit mobile, or an international number starting with +.";
    for (const phone of ["12345", "call me later", "1234567890123456", "9812370042x"]) {
      expect(customerProblems({ name: "Meera", phone }).phone).toBe(bad);
    }
  });

  it("refuses a bare foreign number with no + to say it is one", () => {
    // Without the +, 442079460958 reads as an Indian mobile and is not one.
    expect(customerProblems({ name: "Sophie", phone: "442079460958" }).phone).toBeTruthy();
  });
});

/**
 * The New-quote dialog asks before closing over typed entries, and ONLY then —
 * a confirm on an untouched form would train everyone to click through it.
 */
describe("the dialog's close guard", () => {
  const blank: DraftFields = {
    customer: "", phone: "", address: "", grossWeight: "", repairDetails: "",
    remarks: "", repairMaking: "", makingDiscount: "", additionalDiscount: "",
    refCount: 0,
  };
  // The builder opens with one empty item already in the list.
  const untouched = (): ItemRow => ({
    id: 1, itemType: "", styleNumber: "", metalCode: "", weight: "",
    manualRate: "", size: "", sizeUnit: "", makingRate: "", makingDiscount: "",
    metalDiscount: "", remark: "", stones: [],
  });

  it("lets an untouched form close without a word", () => {
    expect(hasUnsavedEntries(blank, [untouched()])).toBe(false);
  });

  it("guards every typed field, shared, sale and repair alike", () => {
    for (const patch of [
      { customer: "Meera" }, { phone: "+9715512345" }, { address: "14 Ring Road" },
      { grossWeight: "12.5" }, { repairDetails: "re-tip prongs" }, { remarks: "scratched" },
      { repairMaking: "500" }, { makingDiscount: "5" }, { additionalDiscount: "100" },
    ] as Partial<DraftFields>[]) {
      expect(hasUnsavedEntries({ ...blank, ...patch }, [untouched()])).toBe(true);
    }
  });

  it("guards a picked reference photo", () => {
    expect(hasUnsavedEntries({ ...blank, refCount: 1 }, [untouched()])).toBe(true);
  });

  it("guards an item somebody started filling in — or added a stone row to", () => {
    expect(hasUnsavedEntries(blank, [{ ...untouched(), weight: "3.2" }])).toBe(true);
    expect(hasUnsavedEntries(blank, [{ ...untouched(), stones: [stone()] }])).toBe(true);
  });

  it("ignores whitespace, which is not an entry anyone would miss", () => {
    expect(hasUnsavedEntries({ ...blank, customer: "   " }, [untouched()])).toBe(false);
  });
});
