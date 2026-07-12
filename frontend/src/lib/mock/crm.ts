/**
 * Mock CRM / lead data — Module 1.
 * Realistic Indian jewelry-retail leads across channels and stores.
 * Replace with react-query hooks against the NestJS backend in Phase 2.
 */

export type LeadStage = "inquiry" | "quotation" | "order_placed";

/**
 * Terminal state of a lead, orthogonal to `stage`.
 * `won` is auto-set when the stage moves to order_placed; `lost` requires
 * a reason. Default listing shows only `open` leads.
 */
export type LeadOutcome = "open" | "won" | "lost";

/** Buying-intent temperature (Zoho-style lead scoring, server-computed). */
export type LeadTemperature = "hot" | "warm" | "cold";

/** What kind of interaction an activity entry records. */
export type ActivityKind = "note" | "call" | "visit" | "whatsapp";

export type LeadSource =
  | "walk_in"
  | "phone"
  | "whatsapp"
  | "website"
  | "instagram"
  | "referral";

export interface LeadNote {
  id: string;
  at: string; // ISO date
  author: string;
  text: string;
  /** Interaction type — drives the timeline label (call / visit / …). */
  kind: ActivityKind;
  /** Full ISO timestamp; preferred over `at` for timeline ordering. */
  createdAt: string;
}

export interface OccasionReminder {
  id: string;
  /** e.g. "Anniversary", "Birthday" */
  occasion: string;
  /** ISO date of the next occurrence. */
  date: string;
}

/**
 * SOP follow-up on a lead. Two are auto-created per lead
 * (created +7 days and +30 days); the store manager can edit either date.
 * `seq` is 1 or 2. Backend view shape (GET /leads includes `followUps`).
 */
export interface FollowUp {
  id: string;
  /** 1 = the +7-day follow-up, 2 = the +30-day follow-up. */
  seq: number;
  /** Due date, yyyy-mm-dd. */
  dueDate: string;
  done: boolean;
  /** ISO timestamp when marked done (null while pending). */
  doneAt?: string | null;
  /** Optional remark captured on completion / edit. */
  note?: string | null;
}

export interface Lead {
  id: string;
  /** Human-friendly reference, e.g. LD-2041. */
  ref: string;
  customer: string;
  phone: string;
  /** Postal address (Round-2 — captured on the entry form, echoed by the API). */
  address: string;
  /** Birthday as yyyy-mm-dd, or null when not captured. */
  birthday: string | null;
  /** Anniversary as yyyy-mm-dd, or null when not captured. */
  anniversary: string | null;
  /**
   * @deprecated Price/amount was removed from CRM per the client (Module 1).
   * Kept optional only for legacy seed data; surfaced only as the DSR chip.
   */
  value?: number;
  source: LeadSource;
  stage: LeadStage;
  /** Sales rep who owns the lead. */
  assignedRep: string;
  /** Store the lead belongs to (matches MOCK_STORES ids). */
  storeId: string;
  /** What the customer is interested in. */
  interest: string;
  /** Free-text remark (replaces the removed price field). */
  remark?: string;
  /** Open / won / lost. Won is auto-set on order_placed. */
  outcome: LeadOutcome;
  /** Required when outcome = lost; null otherwise. */
  lostReason: string | null;
  /** ISO timestamp when the lead was closed (won/lost); null while open. */
  closedAt: string | null;
  /** Server-computed buying-intent temperature. */
  temperature: LeadTemperature;
  createdAt: string;
  lastActivity: string;
  notes: LeadNote[];
  reminders: OccasionReminder[];
  /** The two SOP follow-ups (+7d / +30d). Present on the API lead view. */
  followUps?: FollowUp[];
}

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  walk_in: "Walk-in",
  phone: "Phone",
  whatsapp: "WhatsApp",
  website: "Website",
  instagram: "Instagram",
  referral: "Referral",
};

/** Ordered options for the (required) lead-source select on the entry form. */
export const LEAD_SOURCE_OPTIONS: { value: LeadSource; label: string }[] = [
  { value: "walk_in", label: "Walk-in" },
  { value: "phone", label: "Phone" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "website", label: "Website" },
  { value: "instagram", label: "Instagram" },
  { value: "referral", label: "Referral" },
];

export const TEMPERATURE_LABELS: Record<LeadTemperature, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  note: "Note",
  call: "Call",
  visit: "Store visit",
  whatsapp: "WhatsApp",
};

export const LEAD_STAGES: { id: LeadStage; label: string }[] = [
  { id: "inquiry", label: "Inquiry" },
  { id: "quotation", label: "Quotation" },
  { id: "order_placed", label: "Order Placed" },
];

export const MOCK_LEADS: Lead[] = [
  {
    id: "ld-2041",
    ref: "LD-2041",
    customer: "Priya Sharma",
    phone: "+91 98250 11234",
    address: "12, Ghod Dod Road, Surat, Gujarat",
    birthday: null,
    anniversary: "2026-11-22",
    value: 285000,
    source: "walk_in",
    stage: "inquiry",
    assignedRep: "Aarav Mehta",
    storeId: "surat-main",
    interest: "Bridal — 22K gold necklace set",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "hot",
    createdAt: "2026-06-14",
    lastActivity: "2026-06-16",
    notes: [
      {
        id: "n1",
        at: "2026-06-14",
        author: "Aarav Mehta",
        text: "Wedding in November. Prefers antique temple-jewellery design.",
        kind: "note",
        createdAt: "2026-06-14T11:20:00.000Z",
      },
    ],
    reminders: [
      { id: "r1", occasion: "Anniversary", date: "2026-11-22" },
    ],
  },
  {
    id: "ld-2042",
    ref: "LD-2042",
    customer: "Rohan Desai",
    phone: "+91 99041 55678",
    address: "48, Adajan, Surat, Gujarat",
    birthday: "2026-07-03",
    anniversary: null,
    value: 64000,
    source: "whatsapp",
    stage: "inquiry",
    assignedRep: "Isha Patel",
    storeId: "surat-main",
    interest: "Diamond solitaire ring (0.50 ct)",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "warm",
    createdAt: "2026-06-15",
    lastActivity: "2026-06-16",
    notes: [],
    reminders: [{ id: "r2", occasion: "Birthday", date: "2026-07-03" }],
  },
  {
    id: "ld-2043",
    ref: "LD-2043",
    customer: "Meera Iyer",
    phone: "+91 98198 33445",
    address: "7, Vesu Main Road, Surat, Gujarat",
    birthday: null,
    anniversary: null,
    value: 152000,
    source: "instagram",
    stage: "quotation",
    assignedRep: "Aarav Mehta",
    storeId: "surat-main",
    interest: "18K rose-gold bangles pair",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "hot",
    createdAt: "2026-06-10",
    lastActivity: "2026-06-15",
    notes: [
      {
        id: "n2",
        at: "2026-06-12",
        author: "Aarav Mehta",
        text: "Shared quote QT-1042. Negotiating making charges.",
        kind: "whatsapp",
        createdAt: "2026-06-12T14:05:00.000Z",
      },
    ],
    reminders: [],
  },
  {
    id: "ld-2044",
    ref: "LD-2044",
    customer: "Aditya Nair",
    phone: "+91 90042 78901",
    address: "22, Piplod, Surat, Gujarat",
    birthday: null,
    anniversary: "2026-06-28",
    value: 410000,
    source: "referral",
    stage: "quotation",
    assignedRep: "Isha Patel",
    storeId: "surat-main",
    interest: "Custom bridal set — kundan + polki",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "warm",
    createdAt: "2026-06-08",
    lastActivity: "2026-06-14",
    notes: [
      {
        id: "n3",
        at: "2026-06-11",
        author: "Isha Patel",
        text: "Referred by Mr. Joshi. Awaiting design approval from production.",
        kind: "call",
        createdAt: "2026-06-11T09:40:00.000Z",
      },
    ],
    reminders: [{ id: "r3", occasion: "Anniversary", date: "2026-06-28" }],
  },
  {
    id: "ld-2045",
    ref: "LD-2045",
    customer: "Sneha Kulkarni",
    phone: "+91 98765 22110",
    address: "301, Citylight, Surat, Gujarat",
    birthday: null,
    anniversary: null,
    value: 98000,
    source: "website",
    stage: "order_placed",
    assignedRep: "Aarav Mehta",
    storeId: "surat-main",
    interest: "Diamond pendant + earrings",
    outcome: "won",
    lostReason: null,
    closedAt: "2026-06-13T12:00:00.000Z",
    temperature: "hot",
    createdAt: "2026-06-02",
    lastActivity: "2026-06-13",
    notes: [
      {
        id: "n4",
        at: "2026-06-13",
        author: "Aarav Mehta",
        text: "Order confirmed, 50% advance received. Delivery 28 Jun.",
        kind: "visit",
        createdAt: "2026-06-13T11:15:00.000Z",
      },
    ],
    reminders: [],
  },
  {
    id: "ld-2046",
    ref: "LD-2046",
    customer: "Vikram Joshi",
    phone: "+91 99876 44556",
    address: "9, Athwa Lines, Surat, Gujarat",
    birthday: null,
    anniversary: null,
    value: 220000,
    source: "phone",
    stage: "order_placed",
    assignedRep: "Isha Patel",
    storeId: "surat-main",
    interest: "Gents 22K gold kada (45 g)",
    outcome: "won",
    lostReason: null,
    closedAt: "2026-06-12T10:30:00.000Z",
    temperature: "warm",
    createdAt: "2026-05-30",
    lastActivity: "2026-06-12",
    notes: [],
    reminders: [],
  },
  // --- Mumbai — Bandra ---
  {
    id: "ld-3010",
    ref: "LD-3010",
    customer: "Fatima Shaikh",
    phone: "+91 98200 90011",
    address: "14, Hill Road, Bandra West, Mumbai",
    birthday: "2026-08-19",
    anniversary: null,
    value: 175000,
    source: "walk_in",
    stage: "inquiry",
    assignedRep: "Karan Malhotra",
    storeId: "mumbai-bandra",
    interest: "Polki choker — engagement",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "warm",
    createdAt: "2026-06-15",
    lastActivity: "2026-06-16",
    notes: [],
    reminders: [{ id: "r4", occasion: "Birthday", date: "2026-08-19" }],
  },
  {
    id: "ld-3011",
    ref: "LD-3011",
    customer: "Neha Kapoor",
    phone: "+91 98201 33221",
    address: "88, Carter Road, Bandra West, Mumbai",
    birthday: null,
    anniversary: null,
    value: 340000,
    source: "instagram",
    stage: "quotation",
    assignedRep: "Karan Malhotra",
    storeId: "mumbai-bandra",
    interest: "Diamond tennis bracelet (2.1 ct)",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "hot",
    createdAt: "2026-06-09",
    lastActivity: "2026-06-15",
    notes: [
      {
        id: "n5",
        at: "2026-06-13",
        author: "Karan Malhotra",
        text: "Wants VVS clarity. Quoted with 3% festive discount.",
        kind: "call",
        createdAt: "2026-06-13T16:45:00.000Z",
      },
    ],
    reminders: [],
  },
  {
    id: "ld-3012",
    ref: "LD-3012",
    customer: "Arjun Reddy",
    phone: "+91 98202 77889",
    address: "5, Pali Naka, Bandra West, Mumbai",
    birthday: null,
    anniversary: null,
    value: 125000,
    source: "referral",
    stage: "order_placed",
    assignedRep: "Divya Shah",
    storeId: "mumbai-bandra",
    interest: "22K gold chain (28 g)",
    outcome: "won",
    lostReason: null,
    closedAt: "2026-06-11T13:20:00.000Z",
    temperature: "warm",
    createdAt: "2026-06-01",
    lastActivity: "2026-06-11",
    notes: [],
    reminders: [],
  },
  // --- Ahmedabad — C.G. Road ---
  {
    id: "ld-4007",
    ref: "LD-4007",
    customer: "Hetal Patel",
    phone: "+91 99099 12345",
    address: "26, C.G. Road, Ahmedabad, Gujarat",
    birthday: null,
    anniversary: null,
    value: 88000,
    source: "whatsapp",
    stage: "inquiry",
    assignedRep: "Rina Trivedi",
    storeId: "ahmedabad-cg",
    interest: "Light-weight daily-wear earrings",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "cold",
    createdAt: "2026-06-16",
    lastActivity: "2026-06-16",
    notes: [],
    reminders: [],
  },
  {
    id: "ld-4008",
    ref: "LD-4008",
    customer: "Sanjay Mehta",
    phone: "+91 99098 65432",
    address: "3, Navrangpura, Ahmedabad, Gujarat",
    birthday: null,
    anniversary: "2026-12-05",
    value: 510000,
    source: "walk_in",
    stage: "quotation",
    assignedRep: "Rina Trivedi",
    storeId: "ahmedabad-cg",
    interest: "Full bridal set — Navratna",
    outcome: "open",
    lostReason: null,
    closedAt: null,
    temperature: "warm",
    createdAt: "2026-06-07",
    lastActivity: "2026-06-14",
    notes: [
      {
        id: "n6",
        at: "2026-06-10",
        author: "Rina Trivedi",
        text: "Daughter's wedding in Dec. Comparing with competitor.",
        kind: "visit",
        createdAt: "2026-06-10T12:10:00.000Z",
      },
    ],
    reminders: [{ id: "r5", occasion: "Anniversary", date: "2026-12-05" }],
  },
];
