import type { Availability, Metal, ProductCategory, ProductSource } from "@/lib/mock/catalogue";
import type { ImageCoverage, ProductListParams } from "@/lib/queries/products";

/** The params behind "More filters": counted on the button so none hides silently. */
const ADVANCED = ["subCategory", "size", "karat", "colour", "metal", "priceMin", "priceMax", "source", "imageCoverage"] as const;

/** A non-negative number typed into a box, or nothing: "-5", "abc" and "" filter nothing. */
function amount(v: string): number | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The catalogue's URL as GET /products params. Only what really narrows the
 * list is sent:
 * - "All stores" goes as `storeId: "all"`, so the store in the top bar (sent as
 *   a header on every request) cannot quietly narrow it to one branch;
 * - a store PICKED in the filter also sends `storeOnly`, so the grid keeps only
 *   that store's designs; the session's own store, used when none is picked,
 *   only says where "here" is;
 * - an unreadable number ("-5", "18K") is dropped, not turned into a 400;
 * - the jewellery filters are not sent while the tenant hides the metal field,
 *   since their controls are hidden too.
 */
export function catalogueListParams(
  get: (key: string) => string,
  opts: { store: string; showsMetalFilters: boolean; page: number; pageSize: number },
): ProductListParams {
  const jewellery = opts.showsMetalFilters;
  const text = (k: string) => get(k).trim() || undefined;
  const karat = amount(get("karat"));
  const picked = get("store");
  return {
    page: opts.page,
    pageSize: opts.pageSize,
    q: text("q"),
    category: jewellery ? (text("category") as ProductCategory | undefined) : undefined,
    metal: jewellery ? (text("metal") as Metal | undefined) : undefined,
    availability: text("availability") as Availability | undefined,
    storeId: opts.store,
    storeOnly: picked && picked !== "all" ? true : undefined,
    subCategory: text("subCategory"),
    size: text("size"),
    karat: jewellery && karat != null && Number.isInteger(karat) ? karat : undefined,
    colour: jewellery ? text("colour") : undefined,
    priceMin: amount(get("priceMin")),
    priceMax: amount(get("priceMax")),
    source: text("source") as ProductSource | undefined,
    imageCoverage: text("coverage") as ImageCoverage | undefined,
  };
}

/** How many of the "More filters" are actually applied. */
export function advancedFilterCount(params: ProductListParams): number {
  return ADVANCED.filter((k) => params[k] != null).length;
}
