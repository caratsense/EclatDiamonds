/**
 * The untouched stone row.
 *
 * "+ Diamond" appends an empty row. Until this, that row made the whole quote
 * unsaveable — validation reported "Item 1: a diamond has no code" about a
 * line the person had never typed into, with nothing on screen to say which
 * row it meant. Reproduced from a real quote on production: three filled
 * stones, one blank, and a blocked save.
 *
 * The other half matters just as much: a row with ANY figure in it must still
 * name its stone, or a half-filled line would be dropped silently and the
 * quote would go out short.
 */
import { describe, expect, it } from "vitest";

import { blankStone } from "./quote-builder";
import type { StoneRow } from "./quote-item-editor";

const row = (patch: Partial<StoneRow> = {}): StoneRow => ({
  id: 1,
  type: "D",
  code: "",
  size: "",
  pieces: "",
  carats: "",
  rate: "",
  rateAuto: true,
  discount: "",
  ...patch,
});

describe("a stone row nobody filled in", () => {
  it("is blank when it is wholly untouched", () => {
    expect(blankStone(row())).toBe(true);
  });

  it("is blank when the defaults are zeros rather than empty strings", () => {
    expect(blankStone(row({ pieces: "0", carats: "0", rate: "0", discount: "0" }))).toBe(true);
  });

  it("is NOT blank once it names a stone", () => {
    expect(blankStone(row({ code: "LG-RND-VVS-E-F" }))).toBe(false);
  });

  it("is NOT blank when it carries a figure but no code", () => {
    // The dangerous case: dropping this would lose a line somebody typed.
    for (const patch of [{ carats: "2.00" }, { pieces: "4" }, { rate: "30000" }, { discount: "5" }]) {
      expect(blankStone(row(patch))).toBe(false);
    }
  });

  it("is NOT blank when it carries only a size", () => {
    expect(blankStone(row({ size: "5.5-6" }))).toBe(false);
  });
});
