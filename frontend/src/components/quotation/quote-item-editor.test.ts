import { describe, expect, it } from "vitest";

import type { MaterialMaster, MaterialOption } from "@/lib/queries/materials";

import { QUOTE_KARATS, QUOTE_KARATS_TEXT, masterLists } from "./quote-item-editor";

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
