/**
 * Mock catalogue / product data — Module 5.
 * Unified product index across stores with in-stock vs lead-time availability.
 * Replace with react-query hooks against the NestJS backend in Phase 2.
 */

export type Availability = "in_stock" | "lead_time";

export type ProductCategory =
  | "necklace"
  | "ring"
  | "earrings"
  | "bangle"
  | "bracelet"
  | "pendant"
  | "chain"
  | "other";

export type Metal =
  | "gold_24k"
  | "gold_22k"
  | "gold_18k"
  | "rose_gold_18k"
  | "platinum"
  | "silver";

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: ProductCategory;
  metal: Metal;
  /** Gold purity in karat (0 for platinum). */
  karat: number;
  /** Gross weight in grams. */
  weightGrams: number;
  /** Diamond / gemstone weight in carats (0 if none). */
  caratWeight: number;
  /** Indicative retail price in ₹. */
  price: number;
  availability: Availability;
  /** Lead time in days when availability === "lead_time". */
  leadTimeDays?: number;
  /** Store id where the piece is held / made (matches MOCK_STORES). */
  storeId: string;
  description: string;
  /** Photo URL/path from the API (object storage). Card falls back to a gem glyph. */
  imageUrl?: string;
}

export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  necklace: "Necklace",
  ring: "Ring",
  earrings: "Earrings",
  bangle: "Bangle",
  bracelet: "Bracelet",
  pendant: "Pendant",
  chain: "Chain",
  other: "Jewellery",
};

export const METAL_LABELS: Record<Metal, string> = {
  gold_24k: "24K Gold",
  gold_22k: "22K Gold",
  gold_18k: "18K Gold",
  rose_gold_18k: "18K Rose Gold",
  platinum: "Platinum",
  silver: "Silver",
};

export const MOCK_PRODUCTS: Product[] = [
  {
    id: "p-001",
    sku: "NK-TEMPLE-22",
    name: "Lakshmi Temple Necklace Set",
    category: "necklace",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 62.4,
    caratWeight: 0,
    price: 498000,
    availability: "in_stock",
    storeId: "surat-main",
    description:
      "Antique-finish 22K temple jewellery set with Lakshmi motif and matching jhumkas.",
  },
  {
    id: "p-002",
    sku: "RG-SOL-18",
    name: "Aurora Solitaire Ring",
    category: "ring",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 4.2,
    caratWeight: 0.5,
    price: 142000,
    availability: "in_stock",
    storeId: "surat-main",
    description:
      "18K white-gold solitaire ring with a 0.50 ct VS-clarity round brilliant diamond.",
  },
  {
    id: "p-003",
    sku: "BN-ROSE-18",
    name: "Blush Rose-Gold Bangles (Pair)",
    category: "bangle",
    metal: "rose_gold_18k",
    karat: 18,
    weightGrams: 28.6,
    caratWeight: 1.2,
    price: 168000,
    availability: "lead_time",
    leadTimeDays: 14,
    storeId: "surat-main",
    description:
      "Pair of 18K rose-gold bangles with pavé diamond accents. Made to order.",
  },
  {
    id: "p-004",
    sku: "ER-CHAND-22",
    name: "Chandbali Jhumka Earrings",
    category: "earrings",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 18.9,
    caratWeight: 0,
    price: 151000,
    availability: "in_stock",
    storeId: "mumbai-bandra",
    description:
      "Traditional 22K chandbali jhumkas with intricate filigree and pearl drops.",
  },
  {
    id: "p-005",
    sku: "BR-TENNIS-18",
    name: "Eternity Tennis Bracelet",
    category: "bracelet",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 12.1,
    caratWeight: 2.1,
    price: 338000,
    availability: "lead_time",
    leadTimeDays: 21,
    storeId: "mumbai-bandra",
    description:
      "18K white-gold tennis bracelet set with 2.10 ct of VVS round diamonds.",
  },
  {
    id: "p-006",
    sku: "PD-MANGAL-22",
    name: "Classic Mangalsutra Pendant",
    category: "pendant",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 8.4,
    caratWeight: 0.18,
    price: 64000,
    availability: "in_stock",
    storeId: "ahmedabad-cg",
    description:
      "22K mangalsutra pendant with black beads and a diamond-studded centre.",
  },
  {
    id: "p-007",
    sku: "CH-ROPE-22",
    name: "Rope-Link Gold Chain (28 g)",
    category: "chain",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 28.0,
    caratWeight: 0,
    price: 198000,
    availability: "in_stock",
    storeId: "ahmedabad-cg",
    description: "Hand-finished 22K rope-link chain, gents 20-inch.",
  },
  {
    id: "p-008",
    sku: "NK-POLKI-PT",
    name: "Imperial Polki Choker",
    category: "necklace",
    metal: "platinum",
    karat: 0,
    weightGrams: 44.5,
    caratWeight: 3.4,
    price: 612000,
    availability: "lead_time",
    leadTimeDays: 30,
    storeId: "mumbai-bandra",
    description:
      "Bridal polki choker in platinum with uncut diamonds and emerald drops. Bespoke.",
  },
  {
    id: "p-009",
    sku: "RG-BAND-PT",
    name: "Infinity Eternity Band",
    category: "ring",
    metal: "platinum",
    karat: 0,
    weightGrams: 5.6,
    caratWeight: 0.75,
    price: 121000,
    availability: "in_stock",
    storeId: "surat-main",
    description:
      "Platinum eternity band with 0.75 ct of channel-set round diamonds.",
  },
  {
    id: "p-010",
    sku: "ER-STUD-18",
    name: "Daily-Wear Diamond Studs",
    category: "earrings",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 2.8,
    caratWeight: 0.3,
    price: 47000,
    availability: "in_stock",
    storeId: "ahmedabad-cg",
    description: "18K yellow-gold studs with a pair of 0.15 ct solitaires.",
  },
  {
    id: "p-011",
    sku: "BN-KADA-22",
    name: "Gents Heritage Kada (45 g)",
    category: "bangle",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 45.2,
    caratWeight: 0,
    price: 322000,
    availability: "in_stock",
    storeId: "surat-main",
    description: "Solid 22K gents kada with a matte-and-cut hand finish.",
  },
  {
    id: "p-012",
    sku: "PD-HALO-18",
    name: "Halo Diamond Pendant",
    category: "pendant",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 3.1,
    caratWeight: 0.45,
    price: 78000,
    availability: "lead_time",
    leadTimeDays: 10,
    storeId: "mumbai-bandra",
    description:
      "18K rose-gold halo pendant with a 0.30 ct centre and pavé halo.",
  },
];

/**
 * Mock AI image-search result — a similarity score against an uploaded image.
 * In Phase 2 this comes from the vision embedding service.
 */
export interface ImageSearchHit {
  product: Product;
  /** 0..1 cosine similarity. */
  similarity: number;
}

/** Deterministic mock "find similar" — ranks a curated subset by score. */
export const MOCK_IMAGE_SEARCH_HITS: ImageSearchHit[] = [
  { product: MOCK_PRODUCTS[0], similarity: 0.94 },
  { product: MOCK_PRODUCTS[3], similarity: 0.88 },
  { product: MOCK_PRODUCTS[7], similarity: 0.81 },
  { product: MOCK_PRODUCTS[5], similarity: 0.73 },
];
