import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SearchSelect, matchOptions, resolveOption } from "./search-select";

/**
 * A quote's item type and metal are picked by typing, the way the shop's ERP
 * does it. What the list narrows to, and what counts as an option typed in
 * full, are decided by two pure functions, so they are tested as such. The box
 * itself is rendered once, closed, for what the screen and the browser tests
 * read from it; a server render needs no DOM for that.
 */

/** The shop's item types, in the order the server sends them: by code. */
const TYPES = [
  ["AANK", "ANKLET"], ["ABG", "BANGLE"], ["ABR", "BRACELET"], ["ACH", "CHAIN"], ["AER", "EARRING"],
  ["AGR", "GENTS RINGS"], ["ALR", "LADIES RING"], ["ANK", "NECKLACE"], ["ANP", "NOSEPIN"], ["APD", "PENDANT"],
].map(([code, name]) => ({ code, name }));

/** Gold as the ERP codes it: G<karat><tone>. */
const METALS = [9, 12, 14, 18].flatMap((karat) =>
  ["PG", "WG", "YG"].map((tone) => ({
    code: `G${String(karat).padStart(2, "0")}${tone}`,
    name: `GOLD${karat}${tone}`,
  })),
);

const codes = (options: typeof TYPES, text: string) => matchOptions(options, text).map((o) => o.code);

describe("narrowing the list", () => {
  it("offers everything until something is typed", () => {
    expect(matchOptions(TYPES, "")).toEqual(TYPES);
    expect(matchOptions(TYPES, "  ")).toEqual(TYPES);
  });

  it("narrows by a part of the name, in any case", () => {
    expect(codes(TYPES, "ring")).toEqual(["AER", "AGR", "ALR"]);
    expect(codes(TYPES, "Pend")).toEqual(["APD"]);
  });

  it("narrows by a part of the code", () => {
    expect(codes(TYPES, "ALR")).toEqual(["ALR"]);
    expect(codes(TYPES, "ab")).toEqual(["ABG", "ABR"]);
    expect(codes(METALS, "14")).toEqual(["G14PG", "G14WG", "G14YG"]);
    expect(codes(METALS, "wg")).toEqual(["G09WG", "G12WG", "G14WG", "G18WG"]);
  });

  it("puts a code typed in full first, so Enter takes it", () => {
    // ANK is the necklace. The anklet has the same letters and sorts above it.
    expect(codes(TYPES, "ank")).toEqual(["ANK", "AANK"]);
  });

  it("offers nothing for what is in no code or name", () => {
    expect(codes(TYPES, "watch")).toEqual([]);
    expect(codes(METALS, "22")).toEqual([]);
  });
});

describe("an option typed in full", () => {
  it("is its code, in any case and with spaces around it", () => {
    expect(resolveOption(METALS, "G14YG")?.code).toBe("G14YG");
    expect(resolveOption(TYPES, " alr ")?.code).toBe("ALR");
  });

  it("is also its name, or its code and name as the box shows them", () => {
    expect(resolveOption(TYPES, "pendant")?.code).toBe("APD");
    expect(resolveOption(TYPES, "ALR LADIES RING")?.code).toBe("ALR");
  });

  it("is never a part of one, however few options it leaves", () => {
    expect(resolveOption(TYPES, "pend")).toBeUndefined();
    expect(resolveOption(METALS, "G22YG")).toBeUndefined();
    expect(resolveOption(TYPES, "")).toBeUndefined();
  });
});

describe("the box", () => {
  /** The box's own <input>, as the server renders it for a given value. */
  const box = (value: string) =>
    renderToStaticMarkup(
      createElement(SearchSelect, { options: TYPES, value, onChange: () => {}, "aria-label": "Item 1 type" }),
    ).match(/<input[^>]*>/)?.[0] ?? "";

  it("shows the chosen option as its code and name", () => {
    expect(box("ALR")).toContain('value="ALR LADIES RING"');
    expect(box("ALR")).toContain('aria-invalid="false"');
  });

  it("keeps a value that is not an option in view, marked invalid", () => {
    expect(box("WATCH")).toContain('value="WATCH"');
    expect(box("WATCH")).toContain('aria-invalid="true"');
  });

  it("is not invalid for being empty", () => {
    expect(box("")).toContain('value=""');
    expect(box("")).toContain('aria-invalid="false"');
  });

  it("is found by the name it is given, as a combobox", () => {
    expect(box("")).toContain('aria-label="Item 1 type"');
    expect(box("")).toContain('role="combobox"');
  });
});
