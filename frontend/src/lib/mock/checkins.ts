/**
 * Mock data for Module 7 — Customer Check-ins & Footfall.
 * Manual / tablet check-ins only (CCTV analytics is DROPPED — see CLAUDE.md).
 * Captures the rep <-> customer relationship: which sales executive attended
 * which walk-in. Store-scoped via `storeId`.
 *
 * Replace with react-query hooks against the NestJS footfall endpoints later.
 */

export type VisitPurpose =
  | "Browsing"
  | "Bridal"
  | "Gold Coin / Investment"
  | "Repair / Service"
  | "Gold Scheme"
  | "Exchange"
  | "Quote Follow-up";

export type VisitOutcome =
  | "in_store"
  | "quote_given"
  | "sale_closed"
  | "browsing_left"
  | "follow_up";

export interface CheckIn {
  id: string;
  storeId: string;
  customer: string;
  /** New walk-in vs returning CRM customer. */
  returning: boolean;
  /**
   * The linked customer record, when the phone resolved to one. Null is a real
   * answer — no phone was given, or it matched nobody — and the UI must not
   * offer customer actions that would have nothing to act on.
   */
  partyId?: string | null;
  phone: string;
  partySize: number;
  purpose: VisitPurpose;
  /** Sales executive attending — the rep<->customer relationship. */
  repId: string;
  repName: string;
  repInitials: string;
  /** HH:mm, at the BRANCH's own clock — not the browser's and not UTC. */
  timeIn: string;
  /**
   * The arrival as a real instant. `timeIn` above has no date in it, so this is
   * the only field that can answer "was this today"; the tiles that read as
   * today's footfall were counting the whole log before it existed.
   */
  timeInAt?: string | null;
  /** HH:mm, null while customer is still in store. */
  timeOut: string | null;
  /** Minutes spent in store; null while in-store. */
  durationMin: number | null;
  outcome: VisitOutcome;
}

export interface HourlyFootfall {
  /** e.g. "11a", "12p". */
  hour: string;
  /** Aggregated walk-ins across the active scope. */
  visitors: number;
}

export interface StoreFootfall {
  storeId: string;
  store: string;
  today: number;
  week: number;
  /** Visits that ended in a closed sale today. */
  converted: number;
}

/* ------------------------------------------------------------------ */
/* Today's check-in log                                                */
/* ------------------------------------------------------------------ */

export const CHECKINS_TODAY: CheckIn[] = [
  {
    id: "ci-01",
    storeId: "surat-main",
    customer: "Rajesh & Kavita Agarwal",
    returning: true,
    phone: "+91 98250 11234",
    partySize: 2,
    purpose: "Bridal",
    repId: "s-101",
    repName: "Priya Sharma",
    repInitials: "PS",
    timeIn: "10:05",
    timeOut: null,
    durationMin: null,
    outcome: "in_store",
  },
  {
    id: "ci-02",
    storeId: "surat-main",
    customer: "Nilesh Bhatt",
    returning: false,
    phone: "+91 99090 44521",
    partySize: 1,
    purpose: "Gold Coin / Investment",
    repId: "s-102",
    repName: "Rohan Desai",
    repInitials: "RD",
    timeIn: "10:22",
    timeOut: "10:51",
    durationMin: 29,
    outcome: "sale_closed",
  },
  {
    id: "ci-03",
    storeId: "surat-main",
    customer: "Hetal Shah",
    returning: true,
    phone: "+91 98795 33210",
    partySize: 3,
    purpose: "Quote Follow-up",
    repId: "s-101",
    repName: "Priya Sharma",
    repInitials: "PS",
    timeIn: "10:40",
    timeOut: null,
    durationMin: null,
    outcome: "in_store",
  },
  {
    id: "ci-04",
    storeId: "surat-main",
    customer: "Imran Vohra",
    returning: false,
    phone: "+91 97250 88123",
    partySize: 1,
    purpose: "Repair / Service",
    repId: "s-105",
    repName: "Karan Mehta",
    repInitials: "KM",
    timeIn: "11:02",
    timeOut: "11:14",
    durationMin: 12,
    outcome: "browsing_left",
  },
  {
    id: "ci-05",
    storeId: "surat-main",
    customer: "Bina Patel",
    returning: true,
    phone: "+91 98240 67788",
    partySize: 2,
    purpose: "Gold Scheme",
    repId: "s-102",
    repName: "Rohan Desai",
    repInitials: "RD",
    timeIn: "11:18",
    timeOut: "11:46",
    durationMin: 28,
    outcome: "quote_given",
  },
  {
    id: "ci-06",
    storeId: "surat-main",
    customer: "Suresh Modi",
    returning: false,
    phone: "+91 99780 12009",
    partySize: 4,
    purpose: "Bridal",
    repId: "s-101",
    repName: "Priya Sharma",
    repInitials: "PS",
    timeIn: "11:35",
    timeOut: null,
    durationMin: null,
    outcome: "in_store",
  },
  {
    id: "ci-07",
    storeId: "surat-main",
    customer: "Dharmesh Gandhi",
    returning: true,
    phone: "+91 98251 90876",
    partySize: 1,
    purpose: "Exchange",
    repId: "s-104",
    repName: "Vikram Joshi",
    repInitials: "VJ",
    timeIn: "12:08",
    timeOut: "12:39",
    durationMin: 31,
    outcome: "sale_closed",
  },
  {
    id: "ci-08",
    storeId: "mumbai-bandra",
    customer: "Aisha & Sameer Khan",
    returning: false,
    phone: "+91 98201 55667",
    partySize: 2,
    purpose: "Bridal",
    repId: "s-201",
    repName: "Aditya Nair",
    repInitials: "AN",
    timeIn: "11:15",
    timeOut: null,
    durationMin: null,
    outcome: "in_store",
  },
  {
    id: "ci-09",
    storeId: "mumbai-bandra",
    customer: "Pooja Reddy",
    returning: true,
    phone: "+91 99300 22118",
    partySize: 1,
    purpose: "Browsing",
    repId: "s-202",
    repName: "Fatima Shaikh",
    repInitials: "FS",
    timeIn: "11:40",
    timeOut: "12:02",
    durationMin: 22,
    outcome: "follow_up",
  },
  {
    id: "ci-10",
    storeId: "mumbai-bandra",
    customer: "Gautam Malhotra",
    returning: false,
    phone: "+91 98330 71245",
    partySize: 1,
    purpose: "Gold Coin / Investment",
    repId: "s-201",
    repName: "Aditya Nair",
    repInitials: "AN",
    timeIn: "12:20",
    timeOut: "12:48",
    durationMin: 28,
    outcome: "sale_closed",
  },
  {
    id: "ci-11",
    storeId: "ahmedabad-cg",
    customer: "Ramesh Thakkar",
    returning: true,
    phone: "+91 98980 33421",
    partySize: 3,
    purpose: "Bridal",
    repId: "s-302",
    repName: "Harsh Solanki",
    repInitials: "HS",
    timeIn: "10:55",
    timeOut: null,
    durationMin: null,
    outcome: "in_store",
  },
  {
    id: "ci-12",
    storeId: "ahmedabad-cg",
    customer: "Krina Doshi",
    returning: false,
    phone: "+91 99240 88190",
    partySize: 2,
    purpose: "Gold Scheme",
    repId: "s-302",
    repName: "Harsh Solanki",
    repInitials: "HS",
    timeIn: "11:30",
    timeOut: "11:58",
    durationMin: 28,
    outcome: "quote_given",
  },
];

/* ------------------------------------------------------------------ */
/* Footfall by hour (active-store demo shape)                          */
/* ------------------------------------------------------------------ */

export const FOOTFALL_BY_HOUR: HourlyFootfall[] = [
  { hour: "10a", visitors: 6 },
  { hour: "11a", visitors: 11 },
  { hour: "12p", visitors: 14 },
  { hour: "1p", visitors: 9 },
  { hour: "2p", visitors: 7 },
  { hour: "3p", visitors: 8 },
  { hour: "4p", visitors: 12 },
  { hour: "5p", visitors: 16 },
  { hour: "6p", visitors: 19 },
  { hour: "7p", visitors: 15 },
  { hour: "8p", visitors: 10 },
];

/* ------------------------------------------------------------------ */
/* Footfall by store (aggregate view)                                  */
/* ------------------------------------------------------------------ */

export const FOOTFALL_BY_STORE: StoreFootfall[] = [
  {
    storeId: "surat-main",
    store: "Surat — Main",
    today: 127,
    week: 812,
    converted: 34,
  },
  {
    storeId: "mumbai-bandra",
    store: "Mumbai — Bandra",
    today: 98,
    week: 689,
    converted: 27,
  },
  {
    storeId: "ahmedabad-cg",
    store: "Ahmedabad — C.G. Road",
    today: 84,
    week: 571,
    converted: 22,
  },
];

export const VISIT_OUTCOME_LABELS: Record<VisitOutcome, string> = {
  in_store: "In store",
  quote_given: "Quote given",
  sale_closed: "Sale closed",
  browsing_left: "Browsed, left",
  follow_up: "Follow-up",
};
