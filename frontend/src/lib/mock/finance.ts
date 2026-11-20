/**
 * Mock data for Module 4 — Finance & Fund Planning.
 * Store/region-scoped seed data; Phase 2 replaces with API hooks.
 */

export interface MisCard {
  id: string;
  label: string;
  value: number;
  delta: number;
  /** Lower-is-better metrics (expenses) invert delta colouring. */
  invertDelta?: boolean;
}

/** P&L / MIS summary (month-to-date, ₹). */
export const MIS_SUMMARY: MisCard[] = [
  { id: "revenue", label: "Revenue (MTD)", value: 142600000, delta: 9.3 },
  { id: "gross", label: "Gross Margin", value: 31200000, delta: 4.1 },
  { id: "opex", label: "Operating Expense", value: 18400000, delta: 6.8, invertDelta: true },
  { id: "ebitda", label: "EBITDA", value: 12800000, delta: 11.5 },
];

/** General-ledger style AP/AR entries. */
export interface LedgerEntry {
  /** Unique row key from the API (human ref `id` can repeat across stores). */
  key?: string;
  id: string;
  date: string;
  account: string;
  party: string;
  store: string;
  type: "AR" | "AP";
  debit: number;
  credit: number;
  status: "open" | "partial" | "cleared" | "overdue";
}

export const LEDGER: LedgerEntry[] = [
  { id: "L-2041", date: "17 Jun", account: "Sales — Bridal", party: "Sharma & Sons", store: "Surat", type: "AR", debit: 0, credit: 2450000, status: "partial" },
  { id: "L-2042", date: "17 Jun", account: "Bullion Purchase", party: "MMTC-PAMP", store: "HO", type: "AP", debit: 8800000, credit: 0, status: "open" },
  { id: "L-2043", date: "16 Jun", account: "Sales — Diamond", party: "A. Kapoor", store: "Mumbai", type: "AR", debit: 0, credit: 1840000, status: "cleared" },
  { id: "L-2044", date: "16 Jun", account: "Rent — Bandra", party: "Oberoi Estates", store: "Mumbai", type: "AP", debit: 1250000, credit: 0, status: "overdue" },
  { id: "L-2045", date: "15 Jun", account: "Sales — Gold Coin", party: "Walk-in #5102", store: "Ahmedabad", type: "AR", debit: 0, credit: 620000, status: "cleared" },
  { id: "L-2046", date: "15 Jun", account: "Karigar Wages", party: "Workshop — Surat", store: "Surat", type: "AP", debit: 940000, credit: 0, status: "partial" },
  { id: "L-2047", date: "14 Jun", account: "Sales — Polki", party: "Mehta Family", store: "Surat", type: "AR", debit: 0, credit: 3120000, status: "open" },
  { id: "L-2048", date: "14 Jun", account: "Utilities", party: "Torrent Power", store: "Ahmedabad", type: "AP", debit: 186000, credit: 0, status: "cleared" },
];

/** Budget vs actual variance per store (₹, MTD). */
export interface BudgetActual {
  store: string;
  budget: number;
  actual: number;
}

export const BUDGET_VS_ACTUAL: BudgetActual[] = [
  { store: "Surat", budget: 52000000, actual: 56400000 },
  { store: "Mumbai", budget: 68000000, actual: 64200000 },
  { store: "Ahmedabad", budget: 41000000, actual: 39800000 },
  { store: "Rajkot (new)", budget: 12000000, actual: 8900000 },
];

/** Cash-flow forecast — 6-month outflow vs inflow (₹). */
export interface CashFlowPoint {
  month: string;
  inflow: number;
  rentals: number;
  salaries: number;
  newStore: number;
}

export const CASH_FLOW: CashFlowPoint[] = [
  { month: "Jun", inflow: 142000000, rentals: 4200000, salaries: 9800000, newStore: 6500000 },
  { month: "Jul", inflow: 128000000, rentals: 4200000, salaries: 9800000, newStore: 11000000 },
  { month: "Aug", inflow: 156000000, rentals: 4400000, salaries: 10200000, newStore: 14500000 },
  { month: "Sep", inflow: 168000000, rentals: 4400000, salaries: 10200000, newStore: 9000000 },
  { month: "Oct", inflow: 214000000, rentals: 4600000, salaries: 11800000, newStore: 4000000 },
  { month: "Nov", inflow: 198000000, rentals: 4600000, salaries: 11800000, newStore: 2000000 },
];

/** Expansion-pipeline cost cards. */
export interface ExpansionProject {
  id: string;
  city: string;
  stage: "scouting" | "fit_out" | "hiring" | "launch";
  setupCost: number;
  monthlyOpex: number;
  startDate: string;
  progress: number;
}

export const EXPANSION_PIPELINE: ExpansionProject[] = [
  { id: "e1", city: "Rajkot", stage: "fit_out", setupCost: 28000000, monthlyOpex: 3200000, startDate: "Aug 2026", progress: 62 },
  { id: "e2", city: "Pune — Koregaon", stage: "scouting", setupCost: 41000000, monthlyOpex: 4800000, startDate: "Nov 2026", progress: 18 },
  { id: "e3", city: "Vadodara", stage: "hiring", setupCost: 24000000, monthlyOpex: 2900000, startDate: "Sep 2026", progress: 45 },
];
