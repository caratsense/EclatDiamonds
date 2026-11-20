import { describe, expect, it } from "vitest";

import { advancedFilterCount, catalogueListParams } from "./catalogue-filters";

const url = (qs: string) => {
  const sp = new URLSearchParams(qs);
  return (k: string) => sp.get(k) ?? "";
};
const base = { store: "all", showsMetalFilters: true, page: 1, pageSize: 100 };

describe("catalogueListParams", () => {
  it('sends "All stores" as storeId "all", so the top-bar store cannot narrow it', () => {
    expect(catalogueListParams(url(""), base).storeId).toBe("all");
    expect(catalogueListParams(url(""), { ...base, store: "s_bandra" }).storeId).toBe("s_bandra");
  });

  it("keeps only a store's designs when that store is picked, not for the session's own store", () => {
    expect(catalogueListParams(url("store=s_bandra"), { ...base, store: "s_bandra" })).toMatchObject({
      storeId: "s_bandra",
      storeOnly: true,
    });
    // Nothing picked: the session's store only says where "here" is.
    expect(catalogueListParams(url(""), { ...base, store: "s_bandra" }).storeOnly).toBeUndefined();
    expect(catalogueListParams(url("store=all"), base).storeOnly).toBeUndefined();
  });

  it("sends every filter the URL holds, under the API's names", () => {
    const p = catalogueListParams(
      url("q=SK-1&category=ring&metal=gold_14k&availability=in_stock&subCategory=engagement&size=12&karat=14&colour=rose&priceMin=1000&priceMax=200000.5&source=website&coverage=no_cad"),
      base,
    );
    // availability=in_stock is in the URL (an old link) but is no longer a filter.
    expect(p).toEqual({
      page: 1, pageSize: 100, storeId: "all",
      q: "SK-1", category: "ring", metal: "gold_14k", subCategory: "engagement", size: "12",
      karat: 14, colour: "rose", priceMin: 1000, priceMax: 200000.5, source: "website", imageCoverage: "no_cad",
    });
    expect(advancedFilterCount(p)).toBe(9);
  });

  it("drops a number nobody could mean, and does not count it", () => {
    const p = catalogueListParams(url("priceMin=-5&priceMax=abc&karat=18K"), base);
    expect([p.priceMin, p.priceMax, p.karat]).toEqual([undefined, undefined, undefined]);
    expect(advancedFilterCount(p)).toBe(0);
    expect(catalogueListParams(url("karat=14.5"), base).karat).toBeUndefined();
    expect(catalogueListParams(url("priceMin=0"), base).priceMin).toBe(0);
  });

  it("does not send the jewellery filters while their controls are hidden", () => {
    const p = catalogueListParams(url("category=ring&metal=gold_18k&karat=18&colour=rose&size=12"), { ...base, showsMetalFilters: false });
    expect([p.category, p.metal, p.karat, p.colour]).toEqual([undefined, undefined, undefined, undefined]);
    expect(p.size).toBe("12");
  });
});
