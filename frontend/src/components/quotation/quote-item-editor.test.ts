import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { matchOptions } from "@/components/ui/search-select";
import type { MaterialMaster, MaterialOption, StyleBom } from "@/lib/queries/materials";

import {
  MaterialDatalists,
  QUOTE_KARATS,
  QUOTE_KARATS_TEXT,
  QuoteItemEditor,
  emptyItem,
  masterLists,
  readStyle,
  withMetal,
} from "./quote-item-editor";

/**
 * A new quote is built in 9, 12, 14 or 18K only: the shop's own list (1 Oct
 * 2026). Gati's item master also has 10K, 22K and 24K gold, and the server
 * still takes 22 and 24 for the older quotes that have them, so the builder's
 * `masterLists` is the one place that decides what is offered.
 */

const gold = (karat: number, tone: string): MaterialOption => ({
  code: `G${String(karat).padStart(2, "0")}${tone}`,
  name: `GOLD${karat}${tone}`,
  kind: "metal",
  groupCode: "G",
  groupName: "GOLD",
  karat,
  tone,
  shape: null,
  quality: null,
  saleRates: null,
});

const masterWith = (metals: MaterialOption[]): MaterialMaster => ({
  itemTypes: [],
  metals,
  diamonds: [],
  stones: [],
  sizes: [],
});

const karatsOffered = (master: MaterialMaster | undefined) => [
  ...new Set(masterLists(master).metals.map((m) => m.karat)),
];

describe("the karats a quote is built in", () => {
  it("are the shop's four, and staff are told the same four", () => {
    expect(QUOTE_KARATS).toEqual([9, 12, 14, 18]);
    expect(QUOTE_KARATS_TEXT).toBe("9/12/14/18K");
  });

  it("leave out the 10K, 22K and 24K gold the item master also has", () => {
    const master = masterWith([gold(10, "YG"), gold(14, "YG"), gold(18, "WG"), gold(22, "YG"), gold(24, "YG")]);
    expect(karatsOffered(master)).toEqual([9, 12, 14, 18]);
    expect(masterLists(master).metals.map((m) => m.code)).not.toContain("G22YG");
  });

  it("are all offered before the item master has loaded", () => {
    expect(karatsOffered(undefined)).toEqual([9, 12, 14, 18]);
  });
});

describe("an item's type and metal", () => {
  /*
   * The editor is rendered once on the server, with a type and a metal already
   * chosen, to read the two boxes the way the screen and the browser tests do.
   * What typing and picking in them do is the search box's own, tested with it.
   */
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(QuoteItemEditor, {
        index: 0,
        item: { ...emptyItem(), itemType: "ALR", metalCode: "G14YG" },
        lists: masterLists(undefined),
        master: undefined,
        autoRate: (karat: number) => ({ rate: 0, stale: false, fallback: true, note: `${karat}K` }),
        onChange: () => {},
        onFocus: () => {},
      }),
    ),
  );
  const box = (name: string) => html.match(new RegExp(`<input[^>]*aria-label="${name}"[^>]*>`))?.[0] ?? "";
  const metalsFound = (master: MaterialMaster | undefined, text: string) =>
    matchOptions(masterLists(master).metals, text).map((m) => m.code);

  it("are search boxes still named 'Item N type' and 'Item N metal'", () => {
    expect(box("Item 1 type")).toContain('role="combobox"');
    expect(box("Item 1 metal")).toContain('role="combobox"');
  });

  it("show what is chosen as its code and name", () => {
    expect(box("Item 1 type")).toContain('value="ALR LADIES RING"');
    expect(box("Item 1 metal")).toContain('value="G14YG GOLD14YG"');
  });

  it("take no list from the browser, which a test cannot drive", () => {
    expect(box("Item 1 metal")).not.toMatch(/\slist=/);
    const datalists = renderToStaticMarkup(createElement(MaterialDatalists, { lists: masterLists(undefined) }));
    expect(datalists).not.toContain("qb-metals");
    // The diamond and colour-stone codes keep theirs.
    expect(datalists).toContain("qb-codes-D");
    expect(datalists).toContain("qb-codes-C");
  });

  it("find a metal by its karat and colour as the screen writes them", () => {
    // "18K · today's rate" and "pick the metal (9/12/14/18K)" sit beside the box.
    expect(metalsFound(undefined, "18K")).toEqual(["G18PG", "G18WG", "G18YG"]);
    expect(metalsFound(undefined, "14k wg")).toEqual(["G14WG"]);
    // The master's own metals too, whose tone can be two colours.
    const master = masterWith([gold(14, "YG"), gold(18, "W/YG"), gold(18, "YG"), gold(22, "YG")]);
    expect(metalsFound(master, "18k")).toEqual(["G18W/YG", "G18YG"]);
    expect(metalsFound(master, "22K")).toEqual([]);
  });

  it("drop a gold rate typed by hand when the metal changes", () => {
    const item = { ...emptyItem(), metalCode: "G14YG", weight: "3.5", manualRate: "6000" };
    expect(withMetal(item, "G18WG")).toEqual({ ...item, metalCode: "G18WG", manualRate: "" });
  });
});

describe("a design's materials", () => {
  const diamond: MaterialOption = {
    ...gold(0, ""),
    code: "LG-RND-VVS-E-F",
    name: "LAB GROWN ROUND",
    kind: "diamond",
    karat: null,
    tone: null,
  };
  const master: MaterialMaster = {
    ...masterWith([gold(10, "YG"), gold(14, "YG"), gold(22, "YG")]),
    diamonds: [diamond],
  };
  const lists = masterLists(master);
  const style = (...lines: StyleBom["lines"]): StyleBom => ({
    styleCode: "10778RG",
    itemType: "ALR",
    itemSize: "12",
    lines,
  });

  it("bring its gold with the weight, and each stone", () => {
    const read = readStyle(
      style({ code: "G14YG", weight: 3.6 }, { code: "LG-RND-VVS-E-F", pieces: 12, weight: 0.096 }),
      lists,
      master,
    );
    expect(read.metalLine).toEqual({ code: "G14YG", weight: 3.6 });
    expect(read.stones.map((s) => [s.type, s.code, s.pieces, s.carats])).toEqual([
      ["D", "LG-RND-VVS-E-F", "12", "0.10"],
    ]);
    expect(read.note).toBe("1 stone line");
  });

  it("come without the gold when it is not one a quote is built in, and say what is left to do", () => {
    for (const code of ["G10YG", "G22YG"]) {
      const read = readStyle(style({ code, weight: 3.6 }), lists, master);
      expect(read.metalLine).toBeUndefined();
      // The gold is not a charge: nothing is said of "other lines left out".
      expect(read.note).toBe("0 stone lines · its gold is not 9/12/14/18K — pick the metal and type the weight");
    }
  });

  it("count a line that is neither its gold nor a stone as left out", () => {
    const read = readStyle(style({ code: "G14YG", weight: 3.6 }, { code: "HALLMARK", weight: 1 }), lists, master);
    expect(read.note).toBe("0 stone lines · 1 other line (charges) left out");
  });
});
