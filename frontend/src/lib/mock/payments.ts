/**
 * Mock data for Module 12 — Payment Collection Tracking.
 * Collections ledger, bank reconciliation, payment-mode breakdown.
 * Replace with API hooks in Phase 2.
 */

export type PaymentMode = "Cash" | "Card" | "UPI" | "Net Banking" | "Online";

export const PAYMENT_MODES: PaymentMode[] = [
  "Cash",
  "Card",
  "UPI",
  "Net Banking",
  "Online",
];

export interface Collection {
  id: string;
  /** ISO datetime of the receipt. */
  date: string;
  customer: string;
  /** Invoice / order reference. */
  ref: string;
  mode: PaymentMode;
  amount: number;
  storeId: string;
  storeName: string;
}

export const MOCK_COLLECTIONS: Collection[] = [
  {
    id: "pay-7001",
    date: "2026-06-17T10:14:00",
    customer: "Priya Sharma",
    ref: "INV-22841",
    mode: "UPI",
    amount: 125000,
    storeId: "surat-main",
    storeName: "Surat — Main",
  },
  {
    id: "pay-7002",
    date: "2026-06-17T11:02:00",
    customer: "Anand Patel",
    ref: "INV-22842",
    mode: "Card",
    amount: 348500,
    storeId: "surat-main",
    storeName: "Surat — Main",
  },
  {
    id: "pay-7003",
    date: "2026-06-17T12:30:00",
    customer: "Meera Iyer",
    ref: "INV-99120",
    mode: "Cash",
    amount: 60000,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
  },
  {
    id: "pay-7004",
    date: "2026-06-17T13:48:00",
    customer: "Karthik Reddy",
    ref: "INV-55012",
    mode: "Net Banking",
    amount: 712000,
    storeId: "ahmedabad-cg",
    storeName: "Ahmedabad — C.G. Road",
  },
  {
    id: "pay-7005",
    date: "2026-06-17T14:20:00",
    customer: "Fatima Khan",
    ref: "INV-99121",
    mode: "Online",
    amount: 94000,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
  },
  {
    id: "pay-7006",
    date: "2026-06-17T15:05:00",
    customer: "Vivek Nair",
    ref: "INV-55013",
    mode: "UPI",
    amount: 41800,
    storeId: "ahmedabad-cg",
    storeName: "Ahmedabad — C.G. Road",
  },
  {
    id: "pay-7007",
    date: "2026-06-17T16:11:00",
    customer: "Rohan Desai",
    ref: "INV-22843",
    mode: "Cash",
    amount: 22000,
    storeId: "surat-main",
    storeName: "Surat — Main",
  },
  {
    id: "pay-7008",
    date: "2026-06-17T17:40:00",
    customer: "Sneha Kulkarni",
    ref: "INV-99122",
    mode: "Card",
    amount: 268000,
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
  },
];

/** Payment-mode breakdown (sum of collections) for the chart. */
export interface ModeBreakdown {
  mode: PaymentMode;
  amount: number;
}

export const MOCK_MODE_BREAKDOWN: ModeBreakdown[] = PAYMENT_MODES.map(
  (mode) => ({
    mode,
    amount: MOCK_COLLECTIONS.filter((c) => c.mode === mode).reduce(
      (sum, c) => sum + c.amount,
      0,
    ),
  }),
);

/** Reconciliation: store-reported collections vs bank-statement settlement. */
export type ReconStatus = "Matched" | "Unmatched" | "Pending";

export interface ReconRow {
  id: string;
  date: string;
  mode: PaymentMode;
  storeName: string;
  /** What the store reported it collected. */
  storeReported: number;
  /** What actually landed per the bank statement (undefined = not yet settled). */
  bankStatement?: number;
  status: ReconStatus;
}

export const MOCK_RECONCILIATION: ReconRow[] = [
  {
    id: "rec-01",
    date: "2026-06-16",
    mode: "Card",
    storeName: "Surat — Main",
    storeReported: 348500,
    bankStatement: 348500,
    status: "Matched",
  },
  {
    id: "rec-02",
    date: "2026-06-16",
    mode: "UPI",
    storeName: "Surat — Main",
    storeReported: 166800,
    bankStatement: 166800,
    status: "Matched",
  },
  {
    id: "rec-03",
    date: "2026-06-16",
    mode: "Card",
    storeName: "Mumbai — Bandra",
    storeReported: 268000,
    bankStatement: 261560,
    status: "Unmatched",
  },
  {
    id: "rec-04",
    date: "2026-06-16",
    mode: "Net Banking",
    storeName: "Ahmedabad — C.G. Road",
    storeReported: 712000,
    status: "Pending",
  },
  {
    id: "rec-05",
    date: "2026-06-16",
    mode: "Cash",
    storeName: "Mumbai — Bandra",
    storeReported: 60000,
    bankStatement: 60000,
    status: "Matched",
  },
  {
    id: "rec-06",
    date: "2026-06-16",
    mode: "Online",
    storeName: "Mumbai — Bandra",
    storeReported: 94000,
    bankStatement: 94000,
    status: "Matched",
  },
];
