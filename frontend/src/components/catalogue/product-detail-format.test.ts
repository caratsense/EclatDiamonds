import { describe, expect, it } from "vitest";

import {
  bomColumns,
  countryName,
  groupCodes,
  groupConflicts,
  historyRows,
  priceOptions,
  sortSizes,
  specLines,
  variantName,
} from "./product-detail-format";

// Shapes taken from a real website design (10039RG-300) as the detail API sends it.
const variants = [
  { id: "v9", karat: 9, metalType: "Gold", diamondType: "Lab Grown", price: 133310 },
  { id: "v14", karat: 14, metalType: "Gold", diamondType: "Lab Grown", price: 143863 },
  { id: "v18", karat: 18, metalType: "Gold", diamondType: "Lab Grown", price: 154904 },
];

describe("groupConflicts", () => {
  it("shows a mismatch repeated once per option as one line with a count", () => {
    const summary = "Specification says 3 ct of diamond; the bill of material says 3.7.";
    const rows = groupConflicts([
      { id: "1", kind: "spec_mismatch", summary, status: "open" },
      { id: "2", kind: "gati_match_none", summary: "Website design 10039RG-300 matches no Gati design; kept as a website-only design.", status: "open" },
      { id: "3", kind: "spec_mismatch", summary, status: "open" },
      { id: "4", kind: "spec_mismatch", summary, status: "open" },
      { id: "5", kind: "unit_mismatch", summary: 'Specification states diamond weight in carats; 9 bill-of-material diamond line(s) say "gram".', status: "open" },
      { id: "6", kind: "unit_mismatch", summary: "already handled", status: "resolved" },
    ]);
    expect(rows.map((r) => [r.kind, r.count])).toEqual([
      ["spec_mismatch", 3],
      ["gati_match_none", 1],
      ["unit_mismatch", 1],
    ]);
    expect(rows[0].label).toBe("Description and materials list don't agree");
  });

  it("names a kind it does not know in sentence case", () => {
    expect(groupConflicts([{ id: "x", kind: "new_kind_here", summary: "s" }])[0].label).toBe("New kind here");
  });
});

describe("variantName", () => {
  it("reads as metal, then diamond", () => {
    expect(variantName(variants[0])).toBe("9K Gold · Lab Grown diamond");
    expect(variantName({ label: "18K · Rose Gold · Natural" })).toBe("18K · Rose Gold · Natural");
  });
});

describe("priceOptions", () => {
  it("lists each option and the natural-diamond price, and drops the repeat of the cheapest", () => {
    const rows = priceOptions({
      variants,
      prices: [
        { source: "website", kind: "min_variant", amount: 133310 },
        { source: "website", kind: "natural_diamond", amount: 2451790 },
        { source: "website", kind: "variant", variantId: "v9", amount: 133310 },
        { source: "website", kind: "variant_with_margin", variantId: "v9", amount: 133310 },
        { source: "website", kind: "variant", variantId: "v14", amount: 143863 },
        { source: "website", kind: "variant_with_margin", variantId: "v14", amount: 150000 },
        { source: "website", kind: "variant", variantId: "v18", amount: 154904 },
      ],
    });
    expect(rows.map((r) => [r.label, r.amount])).toEqual([
      ["9K Gold · Lab Grown diamond", 133310],
      ["14K Gold · Lab Grown diamond", 143863],
      ["14K Gold · Lab Grown diamond · with margin", 150000],
      ["18K Gold · Lab Grown diamond", 154904],
      ["With a natural diamond", 2451790],
    ]);
  });

  it("falls back to the options' own prices when no price rows came", () => {
    expect(priceOptions({ variants }).map((r) => r.amount)).toEqual([133310, 143863, 154904]);
  });
});

describe("sortSizes", () => {
  it("orders ring sizes by number, not as text, and drops repeats", () => {
    const sent = ["IND 6", "IND 7", "IND 8", "IND 9", "IND 10", "IND 11", "IND 13", "IND 12", "IND 14", "IND 15", "IND 16", "IND 18", "IND 17", "IND 7"];
    expect(sortSizes(sent)).toEqual(["IND 6", "IND 7", "IND 8", "IND 9", "IND 10", "IND 11", "IND 12", "IND 13", "IND 14", "IND 15", "IND 16", "IND 17", "IND 18"]);
  });
});

describe("specLines", () => {
  it("splits the website text into a heading and labelled items", () => {
    const text =
      "Product details as per 18Kt Gold and as per Size 13 (10039RG-300)\n* Gold Weight: Approx 3.00 gram\n* Centre * Diamond Weight: 3.00 ct\n* Estimated Delivery Timeline : 3 - 4 weeks\n* Hand finished";
    expect(specLines(text)).toEqual([
      { kind: "text", text: "Product details as per 18Kt Gold and as per Size 13 (10039RG-300)" },
      { kind: "item", key: "Gold Weight", value: "Approx 3.00 gram" },
      { kind: "item", key: "Centre Diamond Weight", value: "3.00 ct" },
      { kind: "item", key: "Estimated Delivery Timeline", value: "3 - 4 weeks" },
      { kind: "item", key: null, value: "Hand finished" },
    ]);
  });
});

describe("bomColumns", () => {
  it("drops the source's ids and nested blobs and puts material first", () => {
    const lines = [
      { rate: 5961, unit: "gram", extra: { _id: "69e3" }, weight: 2.32, quantity: 1, isDiamond: false, lineTotal: 13829.52, materialName: "Gold 9k", rawMaterialId: "69e30e" },
    ];
    expect(bomColumns(lines).map((c) => c.label)).toEqual(["Material", "Weight", "Unit", "Qty", "Rate", "Amount", "Diamond?"]);
  });
});

describe("groupCodes", () => {
  it("shows a code once with every name it goes by", () => {
    const rows = groupCodes(
      { styleNumber: "10039RG-300", sku: "10039RG-300", websiteCode: "10039RG-300", externalId: "69e319b1", hsn: null },
      (k) => ({ styleNumber: "Style no", sku: "SKU", websiteCode: "Website code", externalId: "Website ID" })[k] ?? k,
    );
    expect(rows).toEqual([
      { value: "10039RG-300", labels: ["Style no", "SKU", "Website code"] },
      { value: "69e319b1", labels: ["Website ID"] },
    ]);
  });
});

describe("historyRows", () => {
  it("tells the story oldest first and skips non-timestamps", () => {
    const rows = historyRows({
      updatedAt: "2026-10-04T03:02:00Z",
      createdAt: "2026-08-06T11:13:00Z",
      websiteSourceCreatedAt: "2026-04-18T11:12:00Z",
      importBatchId: "batch_1",
    });
    expect(rows.map((r) => r.label)).toEqual(["Created on the website", "Added to this catalogue", "Last changed in this catalogue"]);
  });
});

describe("countryName", () => {
  it("names country codes", () => {
    expect(countryName("IN")).toBe("India");
    expect(countryName("US")).toBe("United States");
  });
});
