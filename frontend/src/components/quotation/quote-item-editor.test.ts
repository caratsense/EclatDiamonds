import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MaterialMaster, MaterialOption } from "@/lib/queries/materials";

import {
  MaterialDatalists,
  QUOTE_KARATS,
  QUOTE_KARATS_TEXT,
  QuoteItemEditor,
  emptyItem,
  masterLists,
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
   * Nothing can be typed without a DOM, so what a change does is pinned on the
   * source instead.
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
  const source = readFileSync(fileURLToPath(new URL("./quote-item-editor.tsx", import.meta.url)), "utf8");

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

  it("drop a gold rate typed by hand when the metal changes", () => {
    expect(source).toContain('onChange={(code) => set({ metalCode: code, manualRate: "" })}');
  });
});
