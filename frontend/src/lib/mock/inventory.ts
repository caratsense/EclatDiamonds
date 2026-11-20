/**
 * Mock data for Module 9 — Inventory, Stock & Merchandising.
 * Stock table, dead-stock/aging, rotation suggestions, melting & scrap,
 * auto-reorder alerts. Replace with API hooks in Phase 2.
 */

export type StockStatus = "In stock" | "Aging" | "Dead stock" | "Reserved";

export interface StockItem {
  id: string;
  /** SKU / tag number. */
  sku: string;
  name: string;
  category: string;
  /** Gold purity in karat. */
  karat: number;
  storeId: string;
  storeName: string;
  grossGrams: number;
  /** Days since the item entered stock / last moved. */
  ageDays: number;
  status: StockStatus;
  /** Indicative tag price. */
  tagPrice: number;
}

export const MOCK_STOCK: StockItem[] = [
  {
    id: "stk-9001",
    sku: "RNG-22-0451",
    name: "22K Plain Gold Ring",
    category: "Rings",
    karat: 22,
    storeId: "surat-main",
    storeName: "Surat — Main",
    grossGrams: 4.85,
    ageDays: 18,
    status: "In stock",
    tagPrice: 41200,
  },
  {
    id: "stk-9002",
    sku: "NCK-22-1188",
    name: "22K Kundan Necklace",
    category: "Necklaces",
    karat: 22,
    storeId: "surat-main",
    storeName: "Surat — Main",
    grossGrams: 96.4,
    ageDays: 214,
    status: "Dead stock",
    tagPrice: 842000,
  },
  {
    id: "stk-9003",
    sku: "BNG-22-0623",
    name: "22K Antique Bangle (pair)",
    category: "Bangles",
    karat: 22,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
    grossGrams: 58.2,
    ageDays: 132,
    status: "Aging",
    tagPrice: 512000,
  },
  {
    id: "stk-9004",
    sku: "ERG-18-0204",
    name: "18K Diamond Studs",
    category: "Earrings",
    karat: 18,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
    grossGrams: 3.1,
    ageDays: 9,
    status: "In stock",
    tagPrice: 68500,
  },
  {
    id: "stk-9005",
    sku: "CHN-22-2290",
    name: "22K Rope Chain",
    category: "Chains",
    karat: 22,
    storeId: "ahmedabad-cg",
    storeName: "Ahmedabad — C.G. Road",
    grossGrams: 14.7,
    ageDays: 167,
    status: "Aging",
    tagPrice: 124000,
  },
  {
    id: "stk-9006",
    sku: "PND-18-0712",
    name: "18K Solitaire Pendant",
    category: "Pendants",
    karat: 18,
    storeId: "ahmedabad-cg",
    storeName: "Ahmedabad — C.G. Road",
    grossGrams: 2.4,
    ageDays: 256,
    status: "Dead stock",
    tagPrice: 156000,
  },
  {
    id: "stk-9007",
    sku: "MNG-22-0339",
    name: "22K Mangalsutra",
    category: "Necklaces",
    karat: 22,
    storeId: "surat-main",
    storeName: "Surat — Main",
    grossGrams: 21.6,
    ageDays: 42,
    status: "Reserved",
    tagPrice: 184000,
  },
  {
    id: "stk-9008",
    sku: "BRC-22-0590",
    name: "22K Ladies Bracelet",
    category: "Bracelets",
    karat: 22,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
    grossGrams: 12.3,
    ageDays: 88,
    status: "In stock",
    tagPrice: 104000,
  },
];

/** Buckets for the aging-distribution chart. */
export interface AgingBucket {
  bucket: string;
  items: number;
  /** Stock value (₹) in the bucket — the summary endpoint populates this. */
  value?: number;
}

export const MOCK_AGING_DISTRIBUTION: AgingBucket[] = [
  { bucket: "0–30d", items: 124 },
  { bucket: "31–90d", items: 86 },
  { bucket: "91–180d", items: 47 },
  { bucket: "181–365d", items: 23 },
  { bucket: "365d+", items: 9 },
];

/** Move slow stock from a high-age store to a higher-demand store. */
export interface RotationSuggestion {
  id: string;
  sku: string;
  name: string;
  fromStore: string;
  toStore: string;
  ageDays: number;
  /** Why the move is recommended. */
  reason: string;
}

export const MOCK_ROTATION_SUGGESTIONS: RotationSuggestion[] = [
  {
    id: "rot-01",
    sku: "NCK-22-1188",
    name: "22K Kundan Necklace",
    fromStore: "Surat — Main",
    toStore: "Mumbai — Bandra",
    ageDays: 214,
    reason: "Strong bridal demand in Bandra; idle 7 months in Surat.",
  },
  {
    id: "rot-02",
    sku: "CHN-22-2290",
    name: "22K Rope Chain",
    fromStore: "Ahmedabad — C.G. Road",
    toStore: "Surat — Main",
    ageDays: 167,
    reason: "Chains sell 2.3x faster at Surat counter.",
  },
  {
    id: "rot-03",
    sku: "PND-18-0712",
    name: "18K Solitaire Pendant",
    fromStore: "Ahmedabad — C.G. Road",
    toStore: "Mumbai — Bandra",
    ageDays: 256,
    reason: "Diamond pendants move better in Mumbai; consider melt if unsold 30d.",
  },
];

/** Items routed into the melting & scrap workflow. */
// The melting workflow and reorder alerts previously lived here as fabricated
// rows rendered straight onto the Inventory screen. Melting now reads the real
// stock ledger (status "melted"); reorder alerts have no reorder-point data to
// read, so that panel says so instead of inventing quantities.

/** Default dead-stock threshold (days) used to highlight aging rows. */
export const DEAD_STOCK_THRESHOLD_DAYS = 180;
