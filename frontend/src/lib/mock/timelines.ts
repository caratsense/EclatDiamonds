/**
 * Mock data for Module 8 — Timelines & Status Tracking.
 * Internal operations view (open point: customer-facing timeline deferred,
 * see docs/DECISIONS.md). Custom-order production tracker + factory→store
 * replenishment. Replace with API hooks in Phase 2.
 */

/** Production stages a custom order moves through, in order. */
export const ORDER_STAGES = [
  "Gold melting",
  "Designing",
  "Stone setting",
  "Polishing",
  "Ready for collection",
] as const;

export type OrderStage = (typeof ORDER_STAGES)[number];

/**
 * Module 2 — Order Booking. An order is either a bespoke piece for a customer
 * ("custom", ~70% of volume) or a replenishment piece made for store stock
 * ("stock"). Both run through the same production timeline above.
 */
export type OrderKind = "custom" | "stock";

export const ORDER_KIND_LABELS: Record<OrderKind, string> = {
  custom: "Custom order",
  stock: "Stock order",
};

/**
 * Back-office SLA for stock/replenishment orders: a fixed 21-day timeline so
 * the factory team stays systematic. The server auto-sets eta = bookedOn + 21
 * when a stock order is booked without an explicit ETA; the UI mirrors this.
 */
export const STOCK_ORDER_SLA_DAYS = 21;

/** Product category for an order — mirrors the catalogue category set. */
export type OrderCategory =
  | "necklace"
  | "ring"
  | "earrings"
  | "bangle"
  | "bracelet"
  | "pendant"
  | "chain"
  | "other";

export const ORDER_CATEGORY_LABELS: Record<OrderCategory, string> = {
  necklace: "Necklace",
  ring: "Ring",
  earrings: "Earrings",
  bangle: "Bangle",
  bracelet: "Bracelet",
  pendant: "Pendant",
  chain: "Chain",
  other: "Other",
};

/** Ordered options for the category select in the booking form. */
export const ORDER_CATEGORY_OPTIONS = (
  Object.keys(ORDER_CATEGORY_LABELS) as OrderCategory[]
).map((value) => ({ value, label: ORDER_CATEGORY_LABELS[value] }));

/**
 * Metal-colour presets offered in the order/quote builders. Anything outside
 * this set (platinum, silver, two-tone…) is captured as free text.
 */
export const METAL_COLOR_PRESETS = [
  "Yellow gold",
  "White gold",
  "Rose gold",
] as const;

/** How the advance was collected. Shared by the booking + convert flows. */
export type AdvanceMode = "cash" | "card" | "upi" | "bank";

export const ADVANCE_MODE_LABELS: Record<AdvanceMode, string> = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  bank: "Bank transfer",
};

/** Ordered options for the advance-mode select. */
export const ADVANCE_MODE_OPTIONS = (
  Object.keys(ADVANCE_MODE_LABELS) as AdvanceMode[]
).map((value) => ({ value, label: ADVANCE_MODE_LABELS[value] }));

/** Who is accountable at a given moment. "back boys" = runners/helpers. */
export type TimelineRole = "salesperson" | "back_office" | "runner" | "factory";

export const TIMELINE_ROLE_LABELS: Record<TimelineRole, string> = {
  salesperson: "Salesperson",
  back_office: "Back Office",
  runner: "Back Boy / Runner",
  factory: "Production Factory",
};

export interface CustomOrder {
  id: string;
  /** Customer-facing order reference. */
  ref: string;
  customer: string;
  item: string;
  /**
   * Whether this is a bespoke customer order or a stock/replenishment order.
   * Defaults to "custom" for legacy rows the API has not backfilled.
   */
  kind: OrderKind;
  /** Product category, e.g. "ring". Optional on legacy rows. */
  category?: OrderCategory;
  /** Quantity ordered (defaults to 1). */
  qty?: number;
  /** Free-text change notes, e.g. "red stone → green, ring size 16". */
  details?: string;
  /** Reference-image URL/path from the API (object storage). */
  imageUrl?: string;
  /** Quoted / estimated total in ₹. */
  estimation?: number;
  /** Advance already collected in ₹. */
  advanceReceived?: number;
  /** Ring size (custom rings). Null when not applicable. */
  ringSize: string | null;
  /** Bangle size (custom bangles). Null when not applicable. */
  bangleSize: string | null;
  /** Metal colour, e.g. "White gold" or free text ("Platinum"). */
  metalColor: string | null;
  /** How the advance was collected (cash/card/upi/bank). */
  advanceMode: string | null;
  /** Uploaded advance-receipt image path, if captured. */
  advanceReceiptUrl: string | null;
  /** Promised delivery date, yyyy-mm-dd, or "" when unset. */
  deliveryDate: string;
  /** Approx gross weight in grams. */
  grams: number;
  storeId: string;
  storeName: string;
  /** Index into ORDER_STAGES of the stage currently in progress. */
  currentStageIndex: number;
  /** Whoever currently holds the order. */
  ownerRole: TimelineRole;
  ownerName: string;
  /** ISO date the order was booked. */
  bookedOn: string;
  /** ISO date the order is promised / ETA. */
  eta: string;
  /** True if ETA has passed and not yet ready. */
  delayed: boolean;
}

export const MOCK_CUSTOM_ORDERS: CustomOrder[] = [
  {
    id: "co-1041",
    ref: "ORD-1041",
    customer: "Priya Sharma",
    item: "22K Bridal Necklace Set",
    kind: "custom",
    category: "necklace",
    qty: 1,
    details: "Peacock motif, add matching maang-tikka. Antique finish.",
    estimation: 485000,
    advanceReceived: 100000,
    ringSize: null,
    bangleSize: null,
    metalColor: "Yellow gold",
    advanceMode: "upi",
    advanceReceiptUrl: null,
    deliveryDate: "2026-06-28",
    grams: 84.6,
    storeId: "surat-main",
    storeName: "Surat — Main",
    currentStageIndex: 0,
    ownerRole: "factory",
    ownerName: "Rajkot Casting Unit",
    bookedOn: "2026-06-12",
    eta: "2026-06-28",
    delayed: false,
  },
  {
    id: "co-1042",
    ref: "ORD-1042",
    customer: "Anand Patel",
    item: "18K Diamond Engagement Ring",
    kind: "custom",
    category: "ring",
    qty: 1,
    details: "Solitaire 1.71ct, ring size 16, white-gold band instead of yellow.",
    estimation: 265000,
    advanceReceived: 50000,
    ringSize: "16",
    bangleSize: null,
    metalColor: "White gold",
    advanceMode: "card",
    advanceReceiptUrl: null,
    deliveryDate: "2026-06-19",
    grams: 6.2,
    storeId: "surat-main",
    storeName: "Surat — Main",
    currentStageIndex: 2,
    ownerRole: "factory",
    ownerName: "Setting Bench 3",
    bookedOn: "2026-06-05",
    eta: "2026-06-19",
    delayed: false,
  },
  {
    id: "co-1039",
    ref: "ORD-1039",
    customer: "Meera Iyer",
    item: "22K Temple-Jewelry Bangles (pair)",
    kind: "custom",
    category: "bangle",
    qty: 2,
    details: "Lakshmi motif, size 2.6. Matching the customer's existing set.",
    estimation: 720000,
    advanceReceived: 200000,
    ringSize: null,
    bangleSize: "2.6",
    metalColor: "Yellow gold",
    advanceMode: "bank",
    advanceReceiptUrl: null,
    deliveryDate: "2026-06-15",
    grams: 142.0,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
    currentStageIndex: 1,
    ownerRole: "factory",
    ownerName: "Design Studio",
    bookedOn: "2026-06-08",
    eta: "2026-06-15",
    delayed: true,
  },
  {
    id: "co-1037",
    ref: "ORD-1037",
    customer: "Karthik Reddy",
    item: "Platinum Couple Bands",
    kind: "custom",
    category: "ring",
    qty: 2,
    details: "Engraving inside both bands, matte centre with polished edges.",
    estimation: 148000,
    advanceReceived: 148000,
    ringSize: null,
    bangleSize: null,
    metalColor: "Platinum",
    advanceMode: "cash",
    advanceReceiptUrl: null,
    deliveryDate: "2026-06-18",
    grams: 18.4,
    storeId: "ahmedabad-cg",
    storeName: "Ahmedabad — C.G. Road",
    currentStageIndex: 3,
    ownerRole: "runner",
    ownerName: "Suresh (runner)",
    bookedOn: "2026-06-02",
    eta: "2026-06-18",
    delayed: false,
  },
  {
    id: "co-1033",
    ref: "ORD-1033",
    customer: "Fatima Khan",
    item: "22K Antique Choker",
    kind: "custom",
    category: "necklace",
    qty: 1,
    details: "Kundan work, ruby drops. Ready for collection — call customer.",
    estimation: 395000,
    advanceReceived: 150000,
    ringSize: null,
    bangleSize: null,
    metalColor: "Yellow gold",
    advanceMode: "upi",
    advanceReceiptUrl: null,
    deliveryDate: "2026-06-16",
    grams: 67.9,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
    currentStageIndex: 4,
    ownerRole: "salesperson",
    ownerName: "Neha Joshi",
    bookedOn: "2026-05-28",
    eta: "2026-06-16",
    delayed: false,
  },
  {
    id: "co-1031",
    ref: "ORD-1031",
    customer: "Ratanlall — Store stock",
    item: "Men's Diamond Rings (stock)",
    kind: "stock",
    category: "ring",
    qty: 3,
    details: "Replenishment for showcase. Standard sizes 20/22/24, half-bezel.",
    estimation: 540000,
    advanceReceived: 0,
    ringSize: null,
    bangleSize: null,
    metalColor: null,
    advanceMode: null,
    advanceReceiptUrl: null,
    deliveryDate: "",
    grams: 22.1,
    storeId: "ahmedabad-cg",
    storeName: "Ahmedabad — C.G. Road",
    currentStageIndex: 2,
    ownerRole: "factory",
    ownerName: "Setting Bench 1",
    bookedOn: "2026-06-09",
    eta: "2026-06-24",
    delayed: false,
  },
];

/** Replenishment: raw material / finished stock moving factory→store. */
export type ReplenishmentStatus =
  | "Requested"
  | "Dispatched"
  | "In transit"
  | "Received";

export interface Replenishment {
  id: string;
  /** What is being moved. */
  material: string;
  /** From factory / warehouse. */
  source: string;
  destStoreId: string;
  destStoreName: string;
  grams: number;
  status: ReplenishmentStatus;
  /** Carried by which runner, if dispatched. */
  carrier?: string;
  eta: string;
}

export const MOCK_REPLENISHMENTS: Replenishment[] = [
  {
    id: "rep-501",
    material: "22K finished light-weight chains (24 pcs)",
    source: "Rajkot Warehouse",
    destStoreId: "surat-main",
    destStoreName: "Surat — Main",
    grams: 312.5,
    status: "In transit",
    carrier: "Angadia — Mahalaxmi",
    eta: "2026-06-17",
  },
  {
    id: "rep-502",
    material: "Loose diamonds VVS (0.30–0.50 ct)",
    source: "Mumbai HO Vault",
    destStoreId: "mumbai-bandra",
    destStoreName: "Mumbai — Bandra",
    grams: 0,
    status: "Dispatched",
    carrier: "Suresh (runner)",
    eta: "2026-06-17",
  },
  {
    id: "rep-503",
    material: "24K casting grain (replenish stock)",
    source: "Rajkot Casting Unit",
    destStoreId: "ahmedabad-cg",
    destStoreName: "Ahmedabad — C.G. Road",
    grams: 500.0,
    status: "Requested",
    eta: "2026-06-20",
  },
  {
    id: "rep-504",
    material: "22K studded pendants (12 pcs)",
    source: "Rajkot Warehouse",
    destStoreId: "mumbai-bandra",
    destStoreName: "Mumbai — Bandra",
    grams: 188.2,
    status: "Received",
    carrier: "Angadia — Mahalaxmi",
    eta: "2026-06-14",
  },
];
