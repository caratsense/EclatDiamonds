import { formatINR } from "@/lib/format";

/**
 * Mock data for Module 10 — Reporting & DSR (Daily Sales Report).
 * Store-scoped seed data; Phase 2 replaces with API hooks.
 */

export interface DsrHeadline {
  id: string;
  label: string;
  value: number;
  format: "inr" | "number";
  /** % change vs yesterday; `null` = no prior-day base (tile shows no pill). */
  delta: number | null;
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
  storeId?: string;
  store: string;
  walkins: number;
  bills: number;
  revenue: number;
  goldGrams: number;
  /** Beside revenue, never netted off it. */
  cancelled?: { count: number; amount: number };
  returns?: { count: number; amount: number };
  leads?: number;
  quotes?: number;
  /** Visits today whose customer was billed today, of all visits today. */
  visitToSale?: { numerator: number; denominator: number; value: number | null };
}

/** What the DSR figures were measured against, sent with them. */
export interface DsrBasis {
  date: string;
  timezone: string;
  zonesInScope: string[];
  currency: string;
  definitions: Record<string, string>;
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

/* -------------------------------------------------------------------------- */
/* Daily Report (DSR) — the manual store-close report the manager used to type */
/* on WhatsApp, now filed on the website. Contract:                           */
/*   POST /reporting/daily · GET /reporting/daily · POST /reporting/daily/:id/send
/* -------------------------------------------------------------------------- */

/**
 * The store-close figures a manager enters — the store's own sheet, field for
 * field: the traffic funnel, TABLE A (counter sale) with its payment split,
 * TABLE B (customised sale) with its own, and the customised-order book.
 *
 * The two payment splits are deliberately not merged. The store reconciles
 * each table against its own till, and a combined total matches neither.
 */
export interface DailyReportInput {
  storeId: string;
  /** yyyy-mm-dd (the business day the report covers). */
  reportDate: string;
  /** HH:mm (24h) — store-close time; optional. */
  reportTime?: string;

  // Traffic funnel — each row is a subset of the one above it.
  walkIns: number;
  seriousEnquiries: number;
  conversions: number;

  // TABLE A — counter sale.
  deliveredBilled: number;
  cash: number;
  card: number;
  upi: number;
  /** Old gold taken as payment at the counter — optional. */
  oldGoldWtG?: number;
  oldGoldValue?: number;

  // TABLE B — customised sale.
  bookingsNew: number;
  advanceReceived: number;
  customCash: number;
  customCard: number;
  customUpi: number;
  /** Old gold taken against a customised order — optional. */
  customGoldWtG?: number;
  customGoldValue?: number;
  /** Table B only: collected by bank transfer. */
  customBankTransfer?: number;

  // The customised-order book. Closing is derived, never entered.
  bookingsOpen: number;
  bookingsClosed: number;

  /** The sheet's Remark row. */
  remark?: string;
  submittedBy?: string;
}

/**
 * Where the book stands at close: open + booked today − completed today.
 * The one figure on the sheet nobody types, because typing it is how it stops
 * agreeing with the three that produce it.
 */
export function closingBooking(r: {
  bookingsOpen: number;
  bookingsNew: number;
  bookingsClosed: number;
}): number {
  return r.bookingsOpen + r.bookingsNew - r.bookingsClosed;
}

/** A persisted daily report — the input plus server-composed WhatsApp text. */
export interface DailyReport extends DailyReportInput {
  id: string;
  /** Derived server-side from open + new − closed; never stored. */
  bookingsClosing?: number;
  /** Resolved store label for display (backend joins the store). */
  storeName?: string;
  /** The composed WhatsApp-format report text (source of truth for sends). */
  text: string;
  /** ISO timestamp the report was filed. */
  createdAt?: string;
  /** How it was filed: "web" (the app) or "whatsapp" (the bot). */
  source?: string | null;
}

/** yyyy-mm-dd -> dd/MM/yyyy (the owner's WhatsApp date format). */
function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** HH:mm (24h) -> h:mm AM/PM (the owner's WhatsApp time format). */
function clock12(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Compose the WhatsApp-format DSR text — the exact layout the owner types by
 * hand. Used for the live preview and as an offline fallback when the backend
 * `text` field is absent. Money uses consistent ₹ Indian grouping.
 */
export function composeDailyReportText(
  r: DailyReportInput,
  storeName: string,
): string {
  const inr = (n: number) => formatINR(n);
  /**
   * The headline figures go out ungrouped, the payment split grouped.
   *
   * That is the owner's own convention, not a slip, and the server composes
   * the text it actually sends the same way (reporting.service.ts rupeeRaw).
   * This box is captioned "exactly what gets sent", so it has to match —
   * grouping them here made the preview a near-miss of the real message.
   */
  const raw = (n: number) => `₹${Math.round(n)}`;
  const header =
    `STORE: ${storeName}   DATE: ${ddmmyyyy(r.reportDate)}` +
    (r.reportTime ? `   TIME: ${clock12(r.reportTime)}` : "");

  /** A gold leg reads as dashes on a day no gold changed hands. */
  const gold = (wt?: number, val?: number) =>
    `${wt != null ? `${wt} gm` : "— gm"} / ${val != null ? inr(val) : "₹—"}`;
  // Bank transfer is a Table B mode only, as in the server's text.
  const split = (cash: number, card: number, upi: number, wt?: number, val?: number, bank?: number) =>
    `          → Cash ${inr(cash)}   → Card ${inr(card)}   → UPI ${inr(
      upi,
    )}   → Gold (wt/val): ${gold(wt, val)}` +
    (bank === undefined ? "" : `   → Bank transfer ${inr(bank)}`);

  return [
    header,
    `TRAFFIC   Walk-ins: ${r.walkIns}   Serious enquiries: ${r.seriousEnquiries}   Converted: ${r.conversions}`,
    `COUNTER   Sale value: ${raw(r.deliveredBilled)}`,
    split(r.cash, r.card, r.upi, r.oldGoldWtG, r.oldGoldValue),
    `CUSTOM    Booked today: ${raw(r.bookingsNew)}   Received: ${raw(
      r.advanceReceived,
    )}`,
    split(
      r.customCash,
      r.customCard,
      r.customUpi,
      r.customGoldWtG,
      r.customGoldValue,
      r.customBankTransfer ?? 0,
    ),
    `BOOK      Opening: ${raw(r.bookingsOpen)}   Closed: ${raw(
      r.bookingsClosed,
    )}   Closing: ${raw(closingBooking(r))}`,
    ...(r.remark?.trim() ? [`Remark: ${r.remark.trim()}`] : []),
    `Submitted by: ${r.submittedBy?.trim() || "—"}`,
  ].join("\n");
}

/** Seed daily reports (offline realism; live data comes from the API). */
export const DAILY_REPORTS: DailyReport[] = [
  {
    id: "dsr-0001",
    storeId: "surat-main",
    storeName: "Surat — Main",
    reportDate: "2026-07-05",
    reportTime: "20:00",
    walkIns: 12,
    seriousEnquiries: 4,
    conversions: 2,
    // Table A: 90,000 + 1,33,000 + 62,000 of old gold = the 2,85,000 sale.
    deliveredBilled: 285000,
    cash: 90000,
    card: 133000,
    upi: 0,
    oldGoldWtG: 8.42,
    oldGoldValue: 62000,
    // Table B: one advance, taken on UPI.
    bookingsNew: 120000,
    advanceReceived: 40000,
    customCash: 0,
    customCard: 0,
    customUpi: 40000,
    bookingsOpen: 310000,
    bookingsClosed: 95000,
    submittedBy: "Aarav Mehta",
    text: "",
    createdAt: "2026-07-05T14:32:00.000Z",
  },
  {
    id: "dsr-0002",
    storeId: "mumbai-bandra",
    storeName: "Mumbai — Bandra",
    reportDate: "2026-07-05",
    reportTime: "21:30",
    walkIns: 21,
    seriousEnquiries: 7,
    conversions: 3,
    deliveredBilled: 540000,
    cash: 120000,
    card: 305000,
    upi: 115000,
    bookingsNew: 260000,
    advanceReceived: 85000,
    customCash: 0,
    customCard: 50000,
    customUpi: 35000,
    bookingsOpen: 480000,
    bookingsClosed: 160000,
    submittedBy: "Rhea Kapoor",
    text: "",
    createdAt: "2026-07-05T16:05:00.000Z",
  },
].map((r) => ({ ...r, text: composeDailyReportText(r, r.storeName ?? "") }));
