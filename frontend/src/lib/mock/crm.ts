/**
 * Mock CRM / lead data — Module 1.
 * Realistic Indian jewelry-retail leads across channels and stores.
 * Replace with react-query hooks against the NestJS backend in Phase 2.
 */

export type LeadStage = "inquiry" | "quotation" | "order_placed";

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
  /**
   * @deprecated Price/amount was removed from CRM per the client (Module 1).
   * Kept optional only for legacy seed data; never displayed.
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
    value: 285000,
    source: "walk_in",
    stage: "inquiry",
    assignedRep: "Aarav Mehta",
    storeId: "surat-main",
    interest: "Bridal — 22K gold necklace set",
    createdAt: "2026-06-14",
    lastActivity: "2026-06-16",
    notes: [
      {
        id: "n1",
        at: "2026-06-14",
        author: "Aarav Mehta",
        text: "Wedding in November. Prefers antique temple-jewellery design.",
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
    value: 64000,
    source: "whatsapp",
    stage: "inquiry",
    assignedRep: "Isha Patel",
    storeId: "surat-main",
    interest: "Diamond solitaire ring (0.50 ct)",
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
    value: 152000,
    source: "instagram",
    stage: "quotation",
    assignedRep: "Aarav Mehta",
    storeId: "surat-main",
    interest: "18K rose-gold bangles pair",
    createdAt: "2026-06-10",
    lastActivity: "2026-06-15",
    notes: [
      {
        id: "n2",
        at: "2026-06-12",
        author: "Aarav Mehta",
        text: "Shared quote QT-1042. Negotiating making charges.",
      },
    ],
    reminders: [],
  },
  {
    id: "ld-2044",
    ref: "LD-2044",
    customer: "Aditya Nair",
    phone: "+91 90042 78901",
    value: 410000,
    source: "referral",
    stage: "quotation",
    assignedRep: "Isha Patel",
    storeId: "surat-main",
    interest: "Custom bridal set — kundan + polki",
    createdAt: "2026-06-08",
    lastActivity: "2026-06-14",
    notes: [
      {
        id: "n3",
        at: "2026-06-11",
        author: "Isha Patel",
        text: "Referred by Mr. Joshi. Awaiting design approval from production.",
      },
    ],
    reminders: [{ id: "r3", occasion: "Anniversary", date: "2026-06-28" }],
  },
  {
    id: "ld-2045",
    ref: "LD-2045",
    customer: "Sneha Kulkarni",
    phone: "+91 98765 22110",
    value: 98000,
    source: "website",
    stage: "order_placed",
    assignedRep: "Aarav Mehta",
    storeId: "surat-main",
    interest: "Diamond pendant + earrings",
    createdAt: "2026-06-02",
    lastActivity: "2026-06-13",
    notes: [
      {
        id: "n4",
        at: "2026-06-13",
        author: "Aarav Mehta",
        text: "Order confirmed, 50% advance received. Delivery 28 Jun.",
      },
    ],
    reminders: [],
  },
  {
    id: "ld-2046",
    ref: "LD-2046",
    customer: "Vikram Joshi",
    phone: "+91 99876 44556",
    value: 220000,
    source: "phone",
    stage: "order_placed",
    assignedRep: "Isha Patel",
    storeId: "surat-main",
    interest: "Gents 22K gold kada (45 g)",
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
    value: 175000,
    source: "walk_in",
    stage: "inquiry",
    assignedRep: "Karan Malhotra",
    storeId: "mumbai-bandra",
    interest: "Polki choker — engagement",
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
    value: 340000,
    source: "instagram",
    stage: "quotation",
    assignedRep: "Karan Malhotra",
    storeId: "mumbai-bandra",
    interest: "Diamond tennis bracelet (2.1 ct)",
    createdAt: "2026-06-09",
    lastActivity: "2026-06-15",
    notes: [
      {
        id: "n5",
        at: "2026-06-13",
        author: "Karan Malhotra",
        text: "Wants VVS clarity. Quoted with 3% festive discount.",
      },
    ],
    reminders: [],
  },
  {
    id: "ld-3012",
    ref: "LD-3012",
    customer: "Arjun Reddy",
    phone: "+91 98202 77889",
    value: 125000,
    source: "referral",
    stage: "order_placed",
    assignedRep: "Divya Shah",
    storeId: "mumbai-bandra",
    interest: "22K gold chain (28 g)",
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
    value: 88000,
    source: "whatsapp",
    stage: "inquiry",
    assignedRep: "Rina Trivedi",
    storeId: "ahmedabad-cg",
    interest: "Light-weight daily-wear earrings",
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
    value: 510000,
    source: "walk_in",
    stage: "quotation",
    assignedRep: "Rina Trivedi",
    storeId: "ahmedabad-cg",
    interest: "Full bridal set — Navratna",
    createdAt: "2026-06-07",
    lastActivity: "2026-06-14",
    notes: [
      {
        id: "n6",
        at: "2026-06-10",
        author: "Rina Trivedi",
        text: "Daughter's wedding in Dec. Comparing with competitor.",
      },
    ],
    reminders: [{ id: "r5", occasion: "Anniversary", date: "2026-12-05" }],
  },
];
