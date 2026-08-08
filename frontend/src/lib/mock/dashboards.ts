/**
 * Mock data for Module 3 — Departmental Dashboards & Collaboration.
 * Store-scoped + role-aware seed data; Phase 2 replaces with API hooks.
 */
import type { Role } from "@/lib/types";

export interface Kpi {
  id: string;
  label: string;
  value: number;
  /** Pre-formatted display when value is non-monetary (e.g. counts). */
  format: "inr" | "number";
  /** Percentage change vs. prior period. `null` = no comparison (hide the pill). */
  delta: number | null;
  /** Lower-is-better metrics invert delta colouring (e.g. pending orders). */
  invertDelta?: boolean;
  /** Roles that should see this KPI; empty = everyone. */
  roles?: Role[];
}

/** Per-store KPI snapshots, keyed by store id (plus "all" aggregate). */
export const STORE_KPIS: Record<string, Kpi[]> = {
  "surat-main": [
    { id: "sales", label: "Sales Today", value: 1840000, format: "inr", delta: 12.4 },
    { id: "footfall", label: "Footfall", value: 86, format: "number", delta: 8.1 },
    { id: "pending", label: "Pending Orders", value: 14, format: "number", delta: -5.2, invertDelta: true },
    { id: "collections", label: "Collections Due", value: 620000, format: "inr", delta: -3.4, invertDelta: true, roles: ["store_manager", "area_manager", "head_office"] },
    { id: "conversion", label: "Conversion", value: 31, format: "number", delta: 2.6, roles: ["store_manager", "area_manager", "head_office"] },
    { id: "my-sales", label: "My Sales Today", value: 410000, format: "inr", delta: 18.0, roles: ["salesperson"] },
  ],
  "mumbai-bandra": [
    { id: "sales", label: "Sales Today", value: 2960000, format: "inr", delta: 6.8 },
    { id: "footfall", label: "Footfall", value: 124, format: "number", delta: -2.3 },
    { id: "pending", label: "Pending Orders", value: 22, format: "number", delta: 9.5, invertDelta: true },
    { id: "collections", label: "Collections Due", value: 1180000, format: "inr", delta: 4.1, invertDelta: true, roles: ["store_manager", "area_manager", "head_office"] },
    { id: "conversion", label: "Conversion", value: 27, format: "number", delta: -1.2, roles: ["store_manager", "area_manager", "head_office"] },
    { id: "my-sales", label: "My Sales Today", value: 540000, format: "inr", delta: 7.4, roles: ["salesperson"] },
  ],
  "ahmedabad-cg": [
    { id: "sales", label: "Sales Today", value: 1520000, format: "inr", delta: -4.5 },
    { id: "footfall", label: "Footfall", value: 71, format: "number", delta: 3.0 },
    { id: "pending", label: "Pending Orders", value: 9, format: "number", delta: -12.0, invertDelta: true },
    { id: "collections", label: "Collections Due", value: 430000, format: "inr", delta: -8.0, invertDelta: true, roles: ["store_manager", "area_manager", "head_office"] },
    { id: "conversion", label: "Conversion", value: 34, format: "number", delta: 5.5, roles: ["store_manager", "area_manager", "head_office"] },
    { id: "my-sales", label: "My Sales Today", value: 295000, format: "inr", delta: -2.1, roles: ["salesperson"] },
  ],
  all: [
    { id: "sales", label: "Sales Today", value: 6320000, format: "inr", delta: 7.2 },
    { id: "footfall", label: "Footfall", value: 281, format: "number", delta: 3.6 },
    { id: "pending", label: "Pending Orders", value: 45, format: "number", delta: 1.1, invertDelta: true },
    { id: "collections", label: "Collections Due", value: 2230000, format: "inr", delta: -1.8, invertDelta: true, roles: ["area_manager", "head_office"] },
    { id: "conversion", label: "Conversion", value: 30, format: "number", delta: 1.9, roles: ["area_manager", "head_office"] },
  ],
};

/** 7-day sales trend (₹) for the line chart. */
export interface TrendPoint {
  day: string;
  sales: number;
  target: number;
}

export const SALES_TREND: Record<string, TrendPoint[]> = {
  "surat-main": [
    { day: "Wed", sales: 1520000, target: 1600000 },
    { day: "Thu", sales: 1680000, target: 1600000 },
    { day: "Fri", sales: 1740000, target: 1600000 },
    { day: "Sat", sales: 2310000, target: 2000000 },
    { day: "Sun", sales: 2480000, target: 2000000 },
    { day: "Mon", sales: 1610000, target: 1600000 },
    { day: "Tue", sales: 1840000, target: 1600000 },
  ],
  all: [
    { day: "Wed", sales: 5410000, target: 5800000 },
    { day: "Thu", sales: 5760000, target: 5800000 },
    { day: "Fri", sales: 6020000, target: 5800000 },
    { day: "Sat", sales: 8240000, target: 7500000 },
    { day: "Sun", sales: 8910000, target: 7500000 },
    { day: "Mon", sales: 5680000, target: 5800000 },
    { day: "Tue", sales: 6320000, target: 5800000 },
  ],
};

/** Store comparison bars (today's revenue, ₹). */
export interface StoreCompare {
  store: string;
  revenue: number;
  target: number;
}

export const STORE_COMPARISON: StoreCompare[] = [
  { store: "Surat", revenue: 1840000, target: 1600000 },
  { store: "Mumbai", revenue: 2960000, target: 3000000 },
  { store: "Ahmedabad", revenue: 1520000, target: 1700000 },
];

/** Consolidated calendar / to-do panel. */
export interface AgendaItem {
  id: string;
  title: string;
  time: string;
  type: "meeting" | "deadline" | "event" | "task";
  done?: boolean;
}

export const AGENDA: AgendaItem[] = [
  { id: "a1", title: "Bridal collection launch review", time: "10:30 AM", type: "meeting" },
  { id: "a2", title: "Submit Q2 vendor GST reconciliation", time: "01:00 PM", type: "deadline" },
  { id: "a3", title: "Akshaya Tritiya window display setup", time: "03:00 PM", type: "event" },
  { id: "a4", title: "Approve 3 custom-design quotes", time: "04:30 PM", type: "task" },
  { id: "a5", title: "Weekly area-manager sync", time: "06:00 PM", type: "meeting", done: true },
];

/** Cross-department task hand-offs with escalation flags. */
export interface Handoff {
  id: string;
  title: string;
  from: string;
  to: string;
  customer: string;
  due: string;
  status: "open" | "in_progress" | "blocked" | "done";
  escalated: boolean;
}

export const HANDOFFS: Handoff[] = [
  { id: "h1", title: "Custom necklace CAD approval", from: "Sales", to: "Design", customer: "Sharma wedding", due: "Today", status: "blocked", escalated: true },
  { id: "h2", title: "Old-gold purity assay", from: "Sales", to: "Production", customer: "R. Iyer", due: "Tomorrow", status: "in_progress", escalated: false },
  { id: "h3", title: "Polki set resize", from: "Store", to: "Workshop", customer: "Mehta family", due: "2 days", status: "open", escalated: false },
  { id: "h4", title: "Hallmark certificate reissue", from: "Back-office", to: "Compliance", customer: "Walk-in #4821", due: "Overdue", status: "blocked", escalated: true },
  { id: "h5", title: "Diamond ring stone replacement", from: "Sales", to: "Production", customer: "A. Kapoor", due: "3 days", status: "in_progress", escalated: false },
];
