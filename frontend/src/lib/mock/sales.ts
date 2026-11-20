/**
 * Types for the direct-sales format (client call § "Sales (Direct Sales)").
 *
 * A **Sale** is a simple direct-sale entry captured for reporting (the weekly
 * investor report), living alongside orders — there is no separate payments
 * module. It carries the advance vs total split (Module 12 — Payment
 * Collection, folded into Sales & Orders) plus the three counter photos:
 * quotation, invoice and payment receipt.
 *
 * The page renders live via `@/lib/queries/sales`; the seed below documents the
 * shape and gives Storybook/offline a realistic sample.
 */

/** Advance payment method captured on a direct sale (cash / card / UPI). */
export type SalePaymentMode = "cash" | "card" | "upi";

export interface SalePaymentModeOption {
  value: SalePaymentMode;
  label: string;
}

/** The three modes the client asked for on the entry form. */
export const SALE_PAYMENT_MODES: SalePaymentModeOption[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
];

/**
 * Human label for a payment mode. The backend may return extra modes
 * (net_banking, cheque, …) so we key on a lenient string and fall back to the
 * raw value.
 */
export const SALE_PAYMENT_MODE_LABELS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  net_banking: "Net Banking",
  online: "Online",
  cheque: "Cheque",
};

export function saleModeLabel(mode?: string | null): string {
  if (!mode) return "—";
  return SALE_PAYMENT_MODE_LABELS[mode.toLowerCase()] ?? mode;
}

export type SaleModeVariant = "secondary" | "default" | "outline" | "success";

/** Chip colour per mode — mirrors the collections ledger convention. */
export function saleModeVariant(mode?: string | null): SaleModeVariant {
  switch ((mode ?? "").toLowerCase()) {
    case "cash":
      return "secondary";
    case "card":
      return "default";
    case "upi":
      return "success";
    default:
      return "outline";
  }
}

/** The three counter documents attached to a sale. */
export type SaleDocType = "quotation" | "invoice" | "receipt";

export const SALE_DOC_META: { type: SaleDocType; label: string; hint: string }[] =
  [
    { type: "quotation", label: "Quotation", hint: "Quote given to the customer" },
    { type: "invoice", label: "Invoice", hint: "Actual tax invoice / bill" },
    { type: "receipt", label: "Payment receipt", hint: "Advance / payment proof" },
  ];

export interface Sale {
  id: string;
  /** System document number (e.g. SAL-2026-0001). */
  docNo: string;
  /** Actual bill / invoice number written on the physical invoice. */
  invoiceNo: string;
  customer: string;
  description?: string;
  /** Gross sales value before discount (₹). */
  salesValue: number;
  /** Value after discount — the amount actually billed (₹). */
  afterDiscountValue: number;
  /** Advance already collected (₹). */
  advanceReceived: number;
  /** Outstanding = afterDiscountValue − advanceReceived (₹). Server-computed. */
  balance: number;
  /** Discount amount applied (₹). Server-computed from the split. */
  discount?: number;
  /** Discount split percentages actually applied (gold is never discounted). */
  diamondDiscountPercent?: number;
  makingDiscountPercent?: number;
  /** Soft-void state (Store manager + head office cancel). */
  isCancelled?: boolean;
  cancelReason?: string | null;
  /** Advance payment method (cash / card / upi / …). */
  paymentMode?: string | null;
  /** Uploaded photo URLs (relative to the API base or absolute CDN). */
  quotationUrl?: string | null;
  invoiceUrl?: string | null;
  receiptUrl?: string | null;
  /** ISO date of the sale. */
  docDate: string;
}

/** Which stored URL backs a given doc type. */
export function saleDocUrl(sale: Sale, doc: SaleDocType): string | null | undefined {
  switch (doc) {
    case "quotation":
      return sale.quotationUrl;
    case "invoice":
      return sale.invoiceUrl;
    case "receipt":
      return sale.receiptUrl;
  }
}

export const MOCK_SALES: Sale[] = [
  {
    id: "sale-3001",
    docNo: "SAL-2026-0001",
    invoiceNo: "INV-22841",
    customer: "Priya Sharma",
    description: "22K bridal necklace set",
    salesValue: 480000,
    afterDiscountValue: 452000,
    advanceReceived: 125000,
    balance: 327000,
    paymentMode: "upi",
    quotationUrl: null,
    invoiceUrl: null,
    receiptUrl: null,
    docDate: "2026-07-05",
  },
  {
    id: "sale-3002",
    docNo: "SAL-2026-0002",
    invoiceNo: "INV-22842",
    customer: "Anand Patel",
    description: "18K diamond ring — solitaire",
    salesValue: 348500,
    afterDiscountValue: 348500,
    advanceReceived: 348500,
    balance: 0,
    paymentMode: "card",
    quotationUrl: null,
    invoiceUrl: null,
    receiptUrl: null,
    docDate: "2026-07-05",
  },
];
