/**
 * Mock seed data for Module 14 — Returns & Exchange Management.
 * Replace with react-query hooks against the NestJS API in a later phase.
 * All amounts in ₹, weights in grams (gold), purity in karat.
 */

export type ReturnType = "return" | "exchange" | "repair" | "old_gold";

export type ReturnStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "settled";

/**
 * What the customer opted for at the counter (Module 14 client rule):
 * - `exchange` → value is adjusted against a new purchase bill.
 * - `buyback`  → value is paid out as cash (diamond credited at 80%).
 */
export type ChosenOption = "exchange" | "buyback";

/** A single photo captured at intake (mocked as a labelled placeholder). */
export interface IntakePhoto {
  id: string;
  /** What the photo documents. */
  label: string;
  /** Tailwind gradient classes for the mock thumbnail tile. */
  swatch: string;
}

export interface ReturnRecord {
  id: string;
  /** Human reference printed on the credit note. */
  ref: string;
  storeId: string;
  customer: string;
  phone: string;
  type: ReturnType;
  /** Original sale item / description. */
  item: string;
  /** Original invoice value of the item. */
  originalValue: number;
  /** Old-gold gross weight in grams (old_gold / exchange only). */
  oldGoldGrams?: number;
  /** Old-gold purity in karat. */
  oldGoldKarat?: number;
  /** Rate per gram applied at intake (₹/g). */
  ratePerGram?: number;
  /** Deductions: melting loss, wastage, hallmark, etc. (₹). */
  deductions?: number;
  /** Net credit / refund value (₹). */
  creditValue: number;
  /** credit_note → store credit, refund → money back, exchange → applied to new buy. */
  settlement: "credit_note" | "refund" | "exchange";

  // --- Module 14: original-bill inputs (entered manually at the counter) ---
  /** Original gold weight in grams. */
  goldWtG?: number;
  /** Gold rate at purchase (₹/g). */
  goldRateAtPurchase?: number;
  /** Original diamond weight in carats. */
  diaCarat?: number;
  /** Diamond specification / internal code (matches a rate-table row). */
  diaSpec?: string;
  /** Diamond rate at purchase (₹/ct). */
  diaRateAtPurchase?: number;
  /** Making charge at purchase (₹) — never returned. */
  making?: number;
  /** Today's exchange value: gold 100% + diamond 100%. Server-computed. */
  exchangeValue?: number;
  /** Today's buyback value: gold 100% + diamond 80%. Server-computed. */
  buybackValue?: number;
  /** What the customer chose at the counter. */
  chosenOption?: ChosenOption;

  status: ReturnStatus;
  reason: string;
  createdAt: string;
  raisedBy: string;
  /** Role/designation of whoever raised the return (e.g. "store_manager"). */
  raisedByRole?: string;
  photos: IntakePhoto[];
  /** Optional note the approver left on approve/reject — shown to the requester. */
  decisionNote?: string | null;
}

export const RETURN_TYPE_LABELS: Record<ReturnType, string> = {
  return: "Return",
  exchange: "Exchange",
  repair: "Repair",
  old_gold: "Old-Gold Buyback",
};

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  settled: "Settled",
};

export const CHOSEN_OPTION_LABELS: Record<ChosenOption, string> = {
  exchange: "Exchange",
  buyback: "Buyback (cash)",
};

/** Live gold rate per gram used by the exchange-value calculator. */
export const GOLD_RATE_PER_GRAM: Record<number, number> = {
  24: 7180,
  22: 6580,
  18: 5390,
};

/** Photo intake slots the terminal prompts staff to capture. */
export const INTAKE_PHOTO_SLOTS: { key: string; label: string; swatch: string }[] =
  [
    { key: "front", label: "Front view", swatch: "from-amber-200 to-yellow-400" },
    { key: "back", label: "Back / hallmark", swatch: "from-yellow-200 to-amber-300" },
    {
      key: "damage",
      label: "Damage / wear",
      swatch: "from-rose-200 to-orange-300",
    },
    {
      key: "weighing",
      label: "On weighing scale",
      swatch: "from-stone-200 to-amber-200",
    },
  ];

export const MOCK_RETURNS: ReturnRecord[] = [
  {
    id: "rtn-1001",
    ref: "RTN-2026-1001",
    storeId: "surat-main",
    customer: "Priya Sharma",
    phone: "+91 98250 11223",
    type: "old_gold",
    item: "Old 22K bangles (2 pcs)",
    originalValue: 0,
    oldGoldGrams: 38.42,
    oldGoldKarat: 22,
    ratePerGram: 6580,
    deductions: 4100,
    creditValue: 38.42 * 6580 - 4100,
    settlement: "exchange",
    status: "approved",
    reason: "Trade-in towards new bridal set",
    createdAt: "2026-06-16T10:24:00+05:30",
    raisedBy: "Aarav Mehta",
    photos: [
      { id: "p1", label: "Front view", swatch: "from-amber-200 to-yellow-400" },
      { id: "p2", label: "On weighing scale", swatch: "from-stone-200 to-amber-200" },
    ],
  },
  {
    id: "rtn-1002",
    ref: "RTN-2026-1002",
    storeId: "surat-main",
    customer: "Rahul Desai",
    phone: "+91 99099 44556",
    type: "return",
    item: "18K Diamond pendant — DP-4471",
    originalValue: 84500,
    creditValue: 84500,
    deductions: 0,
    settlement: "refund",
    status: "pending_approval",
    reason: "Size/clasp defect reported within 7 days",
    createdAt: "2026-06-16T15:02:00+05:30",
    raisedBy: "Neha Kulkarni",
    photos: [
      { id: "p3", label: "Front view", swatch: "from-amber-200 to-yellow-400" },
      { id: "p4", label: "Damage / wear", swatch: "from-rose-200 to-orange-300" },
    ],
  },
  {
    id: "rtn-1003",
    ref: "RTN-2026-1003",
    storeId: "mumbai-bandra",
    customer: "Fatima Khan",
    phone: "+91 98191 77889",
    type: "exchange",
    item: "22K Gold chain — upgrade to heavier piece",
    originalValue: 156000,
    oldGoldGrams: 21.10,
    oldGoldKarat: 22,
    ratePerGram: 6580,
    deductions: 2200,
    creditValue: 21.1 * 6580 - 2200,
    settlement: "exchange",
    status: "settled",
    reason: "Design upgrade",
    createdAt: "2026-06-14T12:40:00+05:30",
    raisedBy: "Imran Shaikh",
    photos: [
      { id: "p5", label: "Front view", swatch: "from-amber-200 to-yellow-400" },
      { id: "p6", label: "Back / hallmark", swatch: "from-yellow-200 to-amber-300" },
    ],
  },
  {
    id: "rtn-1004",
    ref: "RTN-2026-1004",
    storeId: "ahmedabad-cg",
    customer: "Sneha Patel",
    phone: "+91 97250 33445",
    type: "repair",
    item: "22K Jhumka — broken hook",
    originalValue: 28900,
    creditValue: 0,
    deductions: 850,
    settlement: "credit_note",
    status: "draft",
    reason: "Repair estimate; awaiting customer approval",
    createdAt: "2026-06-17T09:10:00+05:30",
    raisedBy: "Aarav Mehta",
    photos: [
      { id: "p7", label: "Damage / wear", swatch: "from-rose-200 to-orange-300" },
    ],
  },
  {
    id: "rtn-1005",
    ref: "RTN-2026-1005",
    storeId: "surat-main",
    customer: "Vikram Joshi",
    phone: "+91 98980 22110",
    type: "return",
    item: "Silver gift article — SG-220",
    originalValue: 6400,
    creditValue: 6400,
    deductions: 0,
    settlement: "refund",
    status: "rejected",
    reason: "Returned after 30-day window — declined",
    createdAt: "2026-06-12T17:55:00+05:30",
    raisedBy: "Neha Kulkarni",
    photos: [],
  },
];
