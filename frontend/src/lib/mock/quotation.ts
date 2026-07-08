/**
 * Mock quotation / pricing data — Module 2.
 * Quotes are centralized + portable: raised at one store, retrievable at any.
 * Pricing breakdown: gold rate × weight + making + stones + GST.
 * Replace with react-query hooks against the NestJS backend in Phase 2.
 */

export type QuoteStatus = "draft" | "shared" | "accepted" | "expired";

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  shared: "Shared",
  accepted: "Accepted",
  expired: "Expired",
};

/**
 * A quote is either a SALE (gold + stones, GST on the full taxable value) or a
 * REPAIR (making-only: metal & stones are zero, GST is charged on labour). The
 * server recomputes totals per kind — the client preview mirrors that formula.
 */
export type QuoteKind = "sale" | "repair";

export const QUOTE_KIND_LABELS: Record<QuoteKind, string> = {
  sale: "Sale",
  repair: "Repair",
};

/** Live-ish gold rate feed (₹ per gram). Phase 2 wires a real feed. */
export const GOLD_RATE_PER_GRAM: Record<number, number> = {
  22: 7180,
  18: 5920,
};

/** GST on jewellery: 3% (1.5% CGST + 1.5% SGST). */
export const GST_RATE = 0.03;

export interface QuoteLine {
  id: string;
  description: string;
  /** Gold purity in karat for this line. */
  karat: number;
  /** Net gold weight in grams. */
  weightGrams: number;
  /** Applied gold rate ₹/g (snapshotted at quote time). */
  goldRatePerGram: number;
  /** Making charges in ₹ (absolute). */
  makingCharges: number;
  /** Stone / diamond value in ₹. */
  stoneCharges: number;
  /** Stone weight in carats (display only). */
  caratWeight: number;
}

/** A reference photo attached to a quote (uploaded after creation). */
export interface QuotePhoto {
  id: string;
  url: string;
  label: string;
  createdAt: string;
}

export interface Quote {
  id: string;
  /** Quote number, e.g. QT-1042. */
  ref: string;
  customer: string;
  phone: string;
  /** Store where the quote was raised (matches MOCK_STORES ids). */
  originStoreId: string;
  /**
   * Stores where this quote can be checked out. Demonstrates portability —
   * a quote raised at one store can be redeemed at another branch.
   */
  redeemableStoreIds: string[];
  status: QuoteStatus;
  /** Sale (gold + stones) vs repair (making-only). Defaults to "sale". */
  kind: QuoteKind;
  /** Free-text remarks — used to capture repair notes. */
  remarks: string;
  /** Gross intake weight in grams (repair); null for a sale quote. */
  grossWeightG: number | null;
  /** Reference photos attached after the quote is created. */
  photos: QuotePhoto[];
  createdAt: string;
  validUntil: string;
  assignedRep: string;
  lines: QuoteLine[];
}

/** Per-line gold metal value. */
export function lineMetalValue(line: QuoteLine): number {
  return line.weightGrams * line.goldRatePerGram;
}

/** Per-line subtotal before GST. */
export function lineSubtotal(line: QuoteLine): number {
  return lineMetalValue(line) + line.makingCharges + line.stoneCharges;
}

export interface QuoteTotals {
  metalValue: number;
  makingCharges: number;
  stoneCharges: number;
  taxable: number;
  gst: number;
  grandTotal: number;
}

/** Roll up all lines into a money breakdown. */
export function computeQuoteTotals(quote: Quote): QuoteTotals {
  const metalValue = quote.lines.reduce((s, l) => s + lineMetalValue(l), 0);
  const makingCharges = quote.lines.reduce((s, l) => s + l.makingCharges, 0);
  const stoneCharges = quote.lines.reduce((s, l) => s + l.stoneCharges, 0);
  const taxable = metalValue + makingCharges + stoneCharges;
  const gst = taxable * GST_RATE;
  return {
    metalValue,
    makingCharges,
    stoneCharges,
    taxable,
    gst,
    grandTotal: taxable + gst,
  };
}

export const MOCK_QUOTES: Quote[] = [
  {
    id: "qt-1042",
    ref: "QT-1042",
    customer: "Meera Iyer",
    phone: "+91 98198 33445",
    originStoreId: "surat-main",
    redeemableStoreIds: ["surat-main", "mumbai-bandra", "ahmedabad-cg"],
    status: "shared",
    createdAt: "2026-06-12",
    validUntil: "2026-06-26",
    assignedRep: "Aarav Mehta",
    kind: "sale",
    remarks: "",
    grossWeightG: null,
    photos: [],
    lines: [
      {
        id: "l1",
        description: "18K rose-gold bangles (pair)",
        karat: 18,
        weightGrams: 26.4,
        goldRatePerGram: 5920,
        makingCharges: 18480,
        stoneCharges: 9500,
        caratWeight: 1.2,
      },
    ],
  },
  {
    id: "qt-1043",
    ref: "QT-1043",
    customer: "Aditya Nair",
    phone: "+91 90042 78901",
    originStoreId: "surat-main",
    redeemableStoreIds: ["surat-main", "ahmedabad-cg"],
    status: "draft",
    createdAt: "2026-06-11",
    validUntil: "2026-06-25",
    assignedRep: "Isha Patel",
    kind: "sale",
    remarks: "",
    grossWeightG: null,
    photos: [],
    lines: [
      {
        id: "l1",
        description: "Kundan choker — 22K base",
        karat: 22,
        weightGrams: 48.0,
        goldRatePerGram: 7180,
        makingCharges: 64500,
        stoneCharges: 82000,
        caratWeight: 0,
      },
      {
        id: "l2",
        description: "Matching jhumkas — 22K",
        karat: 22,
        weightGrams: 16.5,
        goldRatePerGram: 7180,
        makingCharges: 21000,
        stoneCharges: 14000,
        caratWeight: 0,
      },
    ],
  },
  {
    id: "qt-1051",
    ref: "QT-1051",
    customer: "Neha Kapoor",
    phone: "+91 98201 33221",
    originStoreId: "mumbai-bandra",
    redeemableStoreIds: ["mumbai-bandra", "surat-main"],
    status: "shared",
    createdAt: "2026-06-13",
    validUntil: "2026-06-27",
    assignedRep: "Karan Malhotra",
    kind: "sale",
    remarks: "",
    grossWeightG: null,
    photos: [],
    lines: [
      {
        id: "l1",
        description: "18K tennis bracelet (2.1 ct)",
        karat: 18,
        weightGrams: 12.1,
        goldRatePerGram: 5920,
        makingCharges: 24200,
        stoneCharges: 232000,
        caratWeight: 2.1,
      },
    ],
  },
  {
    id: "qt-1055",
    ref: "QT-1055",
    customer: "Sanjay Mehta",
    phone: "+91 99098 65432",
    originStoreId: "ahmedabad-cg",
    redeemableStoreIds: ["ahmedabad-cg", "surat-main", "mumbai-bandra"],
    status: "accepted",
    createdAt: "2026-06-10",
    validUntil: "2026-06-24",
    assignedRep: "Rina Trivedi",
    kind: "sale",
    remarks: "",
    grossWeightG: null,
    photos: [],
    lines: [
      {
        id: "l1",
        description: "Navratna bridal set — 22K",
        karat: 22,
        weightGrams: 86.0,
        goldRatePerGram: 7180,
        makingCharges: 128000,
        stoneCharges: 96000,
        caratWeight: 0,
      },
    ],
  },
  {
    id: "qt-1060",
    ref: "QT-1060",
    customer: "Rohan Desai",
    phone: "+91 99041 55678",
    originStoreId: "surat-main",
    redeemableStoreIds: ["surat-main"],
    status: "expired",
    createdAt: "2026-05-20",
    validUntil: "2026-06-03",
    assignedRep: "Isha Patel",
    kind: "sale",
    remarks: "",
    grossWeightG: null,
    photos: [],
    lines: [
      {
        id: "l1",
        description: "Diamond solitaire ring (0.50 ct)",
        karat: 18,
        weightGrams: 4.2,
        goldRatePerGram: 5920,
        makingCharges: 9800,
        stoneCharges: 102000,
        caratWeight: 0.5,
      },
    ],
  },
];
