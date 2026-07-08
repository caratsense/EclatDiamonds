/**
 * Mock seed data for Module 13 — Ticketing & Issue Management.
 * Internal helpdesk with auto-routing + recurring-pattern detection.
 * Replace with API hooks in Phase 2. Dates ISO.
 */

export type TicketCategory = "it" | "hr" | "maintenance" | "logistics";

export interface CategoryMeta {
  key: TicketCategory;
  label: string;
  /** Auto-routing target — category maps to a resolver team. */
  resolverTeam: string;
}

/** Auto-routing table: category -> resolver team. */
export const CATEGORIES: CategoryMeta[] = [
  { key: "it", label: "IT", resolverTeam: "IT Helpdesk" },
  { key: "hr", label: "HR", resolverTeam: "People Ops" },
  { key: "maintenance", label: "Maintenance", resolverTeam: "Facilities" },
  { key: "logistics", label: "Logistics", resolverTeam: "Supply Chain" },
];

export function resolverFor(category?: TicketCategory | null): string {
  return (
    CATEGORIES.find((c) => c.key === category)?.resolverTeam ?? "Back office"
  );
}

/** Human label for a ticket category, with the back-office fallback. */
export function categoryLabel(category?: TicketCategory | null): string {
  return CATEGORIES.find((c) => c.key === category)?.label ?? "Back office";
}

export type TicketPriority = "low" | "medium" | "high" | "urgent";
export type TicketStatus =
  | "open"
  | "routed"
  | "in_progress"
  | "resolved"
  | "closed";

export interface TicketMessage {
  id: string;
  author: string;
  /** Whether the author is system/auto-routing vs a person. */
  system?: boolean;
  at: string;
  body: string;
}

export interface Ticket {
  id: string;
  /** Human reference, e.g. TKT-2048. */
  ref: string;
  subject: string;
  store: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignee: string;
  reporter: string;
  createdAt: string;
  updatedAt: string;
  /** Tag used to cluster recurring/structural issues. */
  patternTag?: string;
  thread: TicketMessage[];
}

export const TICKETS: Ticket[] = [
  {
    id: "t-1",
    ref: "TKT-2061",
    subject: "POS terminal freezes during billing rush",
    store: "Surat — Main",
    category: "it",
    priority: "urgent",
    status: "in_progress",
    assignee: "Arjun Rao",
    reporter: "Neha (Cashier)",
    createdAt: "2026-06-16",
    updatedAt: "2026-06-17",
    patternTag: "pos-freeze",
    thread: [
      { id: "m1", author: "Neha (Cashier)", at: "2026-06-16", body: "Terminal 2 freezes for 30s during peak billing. Customers waiting." },
      { id: "m2", author: "System", system: true, at: "2026-06-16", body: "Auto-routed to IT Helpdesk based on category: IT." },
      { id: "m3", author: "Arjun Rao", at: "2026-06-17", body: "Reproduced — RAM spikes on print spooler. Pushing a config fix today." },
    ],
  },
  {
    id: "t-2",
    ref: "TKT-2060",
    subject: "Showcase spotlight flickering in bridal section",
    store: "Mumbai — Bandra",
    category: "maintenance",
    priority: "medium",
    status: "routed",
    assignee: "Facilities Desk",
    reporter: "Priya (Store Mgr)",
    createdAt: "2026-06-16",
    updatedAt: "2026-06-16",
    patternTag: "display-lighting",
    thread: [
      { id: "m1", author: "Priya (Store Mgr)", at: "2026-06-16", body: "Two spotlights over the bridal showcase flicker. Looks bad to walk-ins." },
      { id: "m2", author: "System", system: true, at: "2026-06-16", body: "Auto-routed to Facilities based on category: Maintenance." },
    ],
  },
  {
    id: "t-3",
    ref: "TKT-2058",
    subject: "Salary slip not generated for May",
    store: "Ahmedabad — C.G. Road",
    category: "hr",
    priority: "high",
    status: "open",
    assignee: "Unassigned",
    reporter: "Rakesh (Sales)",
    createdAt: "2026-06-15",
    updatedAt: "2026-06-15",
    thread: [
      { id: "m1", author: "Rakesh (Sales)", at: "2026-06-15", body: "My May payslip is missing in the portal." },
      { id: "m2", author: "System", system: true, at: "2026-06-15", body: "Auto-routed to People Ops based on category: HR." },
    ],
  },
  {
    id: "t-4",
    ref: "TKT-2055",
    subject: "Stock transfer from HO delayed 3 days",
    store: "Surat — Main",
    category: "logistics",
    priority: "high",
    status: "in_progress",
    assignee: "Vivek Nair",
    reporter: "Sameer (Store Mgr)",
    createdAt: "2026-06-14",
    updatedAt: "2026-06-16",
    thread: [
      { id: "m1", author: "Sameer (Store Mgr)", at: "2026-06-14", body: "Bridal transfer bag stuck — courier shows no movement." },
      { id: "m2", author: "System", system: true, at: "2026-06-14", body: "Auto-routed to Supply Chain based on category: Logistics." },
      { id: "m3", author: "Vivek Nair", at: "2026-06-16", body: "Escalated with courier, expected delivery tomorrow AM." },
    ],
  },
  {
    id: "t-5",
    ref: "TKT-2052",
    subject: "POS terminal freezes when applying discount",
    store: "Mumbai — Bandra",
    category: "it",
    priority: "high",
    status: "resolved",
    assignee: "Arjun Rao",
    reporter: "Imran (Cashier)",
    createdAt: "2026-06-11",
    updatedAt: "2026-06-13",
    patternTag: "pos-freeze",
    thread: [
      { id: "m1", author: "Imran (Cashier)", at: "2026-06-11", body: "App hangs when I apply a discount code at checkout." },
      { id: "m2", author: "System", system: true, at: "2026-06-11", body: "Auto-routed to IT Helpdesk based on category: IT." },
      { id: "m3", author: "Arjun Rao", at: "2026-06-13", body: "Patched discount module timeout. Marking resolved." },
    ],
  },
  {
    id: "t-6",
    ref: "TKT-2049",
    subject: "POS terminal freezes after software update",
    store: "Ahmedabad — C.G. Road",
    category: "it",
    priority: "medium",
    status: "closed",
    assignee: "Arjun Rao",
    reporter: "Deepa (Cashier)",
    createdAt: "2026-06-08",
    updatedAt: "2026-06-10",
    patternTag: "pos-freeze",
    thread: [
      { id: "m1", author: "Deepa (Cashier)", at: "2026-06-08", body: "After last night's update the terminal freezes on launch." },
      { id: "m2", author: "System", system: true, at: "2026-06-08", body: "Auto-routed to IT Helpdesk based on category: IT." },
      { id: "m3", author: "Arjun Rao", at: "2026-06-10", body: "Rolled back the print driver. Stable now." },
    ],
  },
  {
    id: "t-7",
    ref: "TKT-2047",
    subject: "AC not cooling in customer lounge",
    store: "Mumbai — Bandra",
    category: "maintenance",
    priority: "low",
    status: "resolved",
    assignee: "Facilities Desk",
    reporter: "Priya (Store Mgr)",
    createdAt: "2026-06-07",
    updatedAt: "2026-06-09",
    patternTag: "display-lighting",
    thread: [
      { id: "m1", author: "Priya (Store Mgr)", at: "2026-06-07", body: "Lounge AC weak, customers uncomfortable." },
      { id: "m2", author: "System", system: true, at: "2026-06-07", body: "Auto-routed to Facilities based on category: Maintenance." },
      { id: "m3", author: "Facilities Desk", at: "2026-06-09", body: "Gas refilled, filters cleaned." },
    ],
  },
];

export interface RecurringPattern {
  tag: string;
  label: string;
  category: TicketCategory;
  count: number;
  stores: string[];
  insight: string;
}

/** Detects clusters of >=2 tickets sharing a patternTag. */
export function detectPatterns(tickets: Ticket[]): RecurringPattern[] {
  const labels: Record<string, string> = {
    "pos-freeze": "POS terminal freezes",
    "display-lighting": "In-store environment faults",
  };
  const insights: Record<string, string> = {
    "pos-freeze":
      "Recurring across 3 stores — likely a structural print-spooler/driver issue, not isolated incidents. Consider a fleet-wide patch.",
    "display-lighting":
      "Repeated lounge/showcase environment faults at Bandra — review the fit-out vendor's electrical work.",
  };
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (!t.patternTag) continue;
    const arr = groups.get(t.patternTag) ?? [];
    arr.push(t);
    groups.set(t.patternTag, arr);
  }
  const out: RecurringPattern[] = [];
  for (const [tag, arr] of groups) {
    if (arr.length < 2) continue;
    out.push({
      tag,
      label: labels[tag] ?? tag,
      category: arr[0].category,
      count: arr.length,
      stores: Array.from(new Set(arr.map((t) => t.store))),
      insight: insights[tag] ?? "Recurring issue cluster.",
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
