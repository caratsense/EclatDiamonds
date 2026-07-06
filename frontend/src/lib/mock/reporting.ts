/**
 * Mock data for Module 10 — Reporting & DSR (Daily Sales Report).
 * Store-scoped seed data; Phase 2 replaces with API hooks.
 */

export interface DsrHeadline {
  id: string;
  label: string;
  value: number;
  format: "inr" | "number";
  delta: number;
}

export const DSR_HEADLINE: DsrHeadline[] = [
  { id: "walkins", label: "Walk-ins", value: 281, format: "number", delta: 3.6 },
  { id: "bills", label: "Bills Generated", value: 84, format: "number", delta: 5.1 },
  { id: "sales", label: "Total Sales", value: 6320000, format: "inr", delta: 7.2 },
  { id: "atv", label: "Avg. Ticket Value", value: 75238, format: "inr", delta: 1.4 },
];

/** Payment-source breakdown for the pie chart. */
export interface PaymentSource {
  source: string;
  amount: number;
}

export const PAYMENT_SOURCES: PaymentSource[] = [
  { source: "Cash", amount: 1580000 },
  { source: "Card", amount: 2210000 },
  { source: "UPI", amount: 1840000 },
  { source: "Net Banking", amount: 690000 },
];

/** Store-wise revenue table. */
export interface StoreRevenue {
  store: string;
  walkins: number;
  bills: number;
  revenue: number;
  goldGrams: number;
}

export const STORE_REVENUE: StoreRevenue[] = [
  { store: "Surat — Main", walkins: 86, bills: 28, revenue: 1840000, goldGrams: 1860 },
  { store: "Mumbai — Bandra", walkins: 124, bills: 36, revenue: 2960000, goldGrams: 2140 },
  { store: "Ahmedabad — C.G. Road", walkins: 71, bills: 20, revenue: 1520000, goldGrams: 1420 },
];

/** Trend analysis — slow vs fast movers. */
export interface MoverRow {
  category: string;
  unitsSold: number;
  daysOfStock: number;
  trend: "fast" | "slow";
}

export const MOVERS: MoverRow[] = [
  { category: "22K Plain Gold Chains", unitsSold: 142, daysOfStock: 9, trend: "fast" },
  { category: "Diamond Solitaire Rings", unitsSold: 38, daysOfStock: 14, trend: "fast" },
  { category: "Bridal Polki Sets", unitsSold: 11, daysOfStock: 21, trend: "fast" },
  { category: "Antique Temple Jewellery", unitsSold: 4, daysOfStock: 96, trend: "slow" },
  { category: "Men's Heavy Kadas", unitsSold: 3, daysOfStock: 118, trend: "slow" },
  { category: "Platinum Bands", unitsSold: 2, daysOfStock: 134, trend: "slow" },
];

/** Evening DSR summary preview (the auto-push payload). */
export const DSR_SUMMARY = {
  date: "17 June 2026",
  highlights: [
    "Pan-India sales ₹63.2L, up 7.2% vs yesterday.",
    "Mumbai — Bandra led with ₹29.6L across 36 bills.",
    "UPI + Card now 64% of collections; cash share down to 25%.",
    "Fast movers: 22K plain chains (142 units), diamond solitaires (38).",
    "Watch: 3 SKUs aging >120 days in antique temple jewellery.",
  ],
};

/**
 * Period rollup summary — daily figures rolled up into weekly + monthly
 * reports (Module 10). Shape mirrors the backend contract:
 *   GET /reporting/summary?period=daily|weekly|monthly&date=YYYY-MM-DD
 */
export type ReportPeriod = "daily" | "weekly" | "monthly";

/** Delivery channel for a composed report (owner's choice). */
export type ReportChannel = "whatsapp" | "email";

export interface ReportSummary {
  period: ReportPeriod;
  /** Range start, YYYY-MM-DD (inclusive). */
  from: string;
  /** Range end, YYYY-MM-DD (inclusive). */
  to: string;
  sales: { count: number; gross: number; discount: number; net: number };
  orders: { count: number; advance: number; estimation: number };
  /** Total collected + a breakdown keyed by tender mode (cash/card/upi/...). */
  payments: { count: number; total: number; byMode: Record<string, number> };
}

/** Period selector options, in display order. */
export const REPORT_PERIODS: { key: ReportPeriod; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

/** Human label for a tender-mode key (upi -> UPI, cash -> Cash). */
export function formatPaymentMode(mode: string): string {
  const m = mode.toLowerCase();
  if (["upi", "neft", "rtgs", "imps", "emi"].includes(m)) return m.toUpperCase();
  return m.charAt(0).toUpperCase() + m.slice(1);
}
