/**
 * Mock data for Module 6 — HRMS & Geo-Tagged Attendance.
 * Indian jewelry-retail staff: salespersons, floor managers, cashiers, runners.
 * Replace with react-query hooks against the NestJS HR endpoints in the API phase.
 *
 * All entities are store-scoped via `storeId` (see CLAUDE.md). The UI filters
 * by the active store from useSession, or shows all rows for the aggregate.
 */

export type StaffRole =
  | "Sales Executive"
  | "Senior Sales Executive"
  | "Floor Manager"
  | "Cashier"
  | "Runner"
  | "Store Manager";

export type AttendanceStatus = "present" | "late" | "on_leave" | "absent";

/** A coordinate pair for the store geofence + a check-in ping. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Store geofence: centre coordinates + allowed radius (metres). */
export interface StoreGeofence {
  storeId: string;
  label: string;
  centre: GeoPoint;
  radiusM: number;
}

export interface AttendanceRecord {
  id: string;
  storeId: string;
  staffId: string;
  name: string;
  initials: string;
  role: StaffRole;
  shift: string;
  /** HH:mm, null while still to check in. */
  checkIn: string | null;
  checkOut: string | null;
  status: AttendanceStatus;
  /** Where the check-in ping landed. */
  ping: GeoPoint;
  /** Metres from the store centre at check-in. */
  distanceM: number;
  /** Derived: ping within the store geofence radius. */
  withinFence: boolean;
  /** Shift/batch this check-in was measured against (Module 6). */
  shiftId?: string | null;
  /**
   * Derived server-side: check-in landed later than the assigned shift's
   * startTime + bufferMins. A 2nd-batch person is NOT late for a morning
   * shift's start — lateness is always relative to their own shift.
   */
  isLate?: boolean;
  /** Minutes past (shift start + buffer) at check-in; 0/undefined when on time. */
  lateMinutes?: number;
}

export interface ShiftAssignment {
  /** mon..sun */
  day: string;
  /** "M" morning, "E" evening, "O" off, "L" leave. */
  shift: "M" | "E" | "O" | "L";
}

export interface RosterRow {
  staffId: string;
  name: string;
  role: StaffRole;
  storeId: string;
  week: ShiftAssignment[];
}

export type LeaveType = "Casual" | "Sick" | "Earned" | "Festival";
export type LeaveStatus = "pending" | "approved" | "rejected";

export interface LeaveRequest {
  id: string;
  storeId: string;
  staffId: string;
  name: string;
  initials: string;
  type: LeaveType;
  from: string;
  to: string;
  days: number;
  reason: string;
  status: LeaveStatus;
}

export interface LeaderboardRow {
  staffId: string;
  name: string;
  initials: string;
  role: StaffRole;
  storeId: string;
  /** Customers attended (footfall handled). */
  footfall: number;
  quotes: number;
  /** Sales closed (count of bills). */
  closed: number;
  /** Revenue from closed sales, ₹. */
  revenue: number;
}

export interface CommissionRow {
  staffId: string;
  name: string;
  initials: string;
  role: StaffRole;
  storeId: string;
  /** Net sales value attributed to this staffer, ₹. */
  salesValue: number;
  /** Incentive rate applied, fraction (e.g. 0.012 = 1.2%). */
  rate: number;
  /** salesValue * rate, ₹. */
  incentive: number;
  /** Monthly target, ₹. */
  target: number;
}

/* ------------------------------------------------------------------ */
/* Shifts / batches, holidays, week-off, late flags (Module 6)         */
/* ------------------------------------------------------------------ */

/**
 * A store shift / batch. Mall stores run 2 shifts (morning ~10:00, night till
 * ~22:00). Lateness is measured against *this* shift's `startTime + bufferMins`
 * — so a night / 2nd-batch person checking in for their afternoon shift is
 * never flagged late against a morning shift's start.
 */
export interface Shift {
  id: string;
  storeId: string;
  name: string;
  /** HH:MM, 24-hour. */
  startTime: string;
  /** HH:MM, 24-hour. */
  endTime: string;
  /** Grace window (minutes) after startTime before a check-in counts as late. */
  bufferMins: number;
  /** Night / 2nd batch — surfaced with a distinct chip; never late for AM start. */
  isNightBatch: boolean;
}

/** A store holiday. Configured per store by HO/head office. */
export interface Holiday {
  id: string;
  storeId: string;
  /** yyyy-mm-dd */
  date: string;
  label: string;
}

/**
 * Monthly late-flag roll-up. 3× late in a month → `flagged`.
 * NOTE: flag ONLY — no salary / half-day-cut automation yet (deferred).
 */
export interface LateFlag {
  staffId: string;
  staffName: string;
  storeId: string;
  lateCount: number;
  flagged: boolean;
}

/** Weekday labels indexed 0 (Sun) – 6 (Sat), matching the week-off API. */
export const WEEK_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Short weekday labels (Sun–Sat) for compact selectors. */
export const WEEK_DAYS_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/* ------------------------------------------------------------------ */
/* Store geofences (mock store coordinates)                            */
/* ------------------------------------------------------------------ */

export const STORE_GEOFENCES: Record<string, StoreGeofence> = {
  "surat-main": {
    storeId: "surat-main",
    label: "Surat — Main, Ghod Dod Road",
    centre: { lat: 21.1859, lng: 72.8081 },
    radiusM: 75,
  },
  "mumbai-bandra": {
    storeId: "mumbai-bandra",
    label: "Mumbai — Bandra, Linking Road",
    centre: { lat: 19.0606, lng: 72.8362 },
    radiusM: 60,
  },
  "ahmedabad-cg": {
    storeId: "ahmedabad-cg",
    label: "Ahmedabad — C.G. Road",
    centre: { lat: 23.0298, lng: 72.5616 },
    radiusM: 80,
  },
};

/* ------------------------------------------------------------------ */
/* Today's attendance                                                  */
/* ------------------------------------------------------------------ */

export const ATTENDANCE_TODAY: AttendanceRecord[] = [
  {
    id: "att-01",
    storeId: "surat-main",
    staffId: "s-101",
    name: "Priya Sharma",
    initials: "PS",
    role: "Senior Sales Executive",
    shift: "Morning · 10:00–19:00",
    checkIn: "09:52",
    checkOut: null,
    status: "present",
    ping: { lat: 21.1858, lng: 72.8082 },
    distanceM: 14,
    withinFence: true,
  },
  {
    id: "att-02",
    storeId: "surat-main",
    staffId: "s-102",
    name: "Rohan Desai",
    initials: "RD",
    role: "Sales Executive",
    shift: "Morning · 10:00–19:00",
    checkIn: "10:18",
    checkOut: null,
    status: "late",
    ping: { lat: 21.186, lng: 72.808 },
    distanceM: 22,
    withinFence: true,
  },
  {
    id: "att-03",
    storeId: "surat-main",
    staffId: "s-103",
    name: "Anjali Patel",
    initials: "AP",
    role: "Cashier",
    shift: "Morning · 10:00–19:00",
    checkIn: "09:46",
    checkOut: null,
    status: "present",
    ping: { lat: 21.1857, lng: 72.8083 },
    distanceM: 31,
    withinFence: true,
  },
  {
    id: "att-04",
    storeId: "surat-main",
    staffId: "s-104",
    name: "Vikram Joshi",
    initials: "VJ",
    role: "Floor Manager",
    shift: "Full · 10:00–21:00",
    checkIn: "09:38",
    checkOut: null,
    status: "present",
    ping: { lat: 21.186, lng: 72.8079 },
    distanceM: 28,
    withinFence: true,
  },
  {
    id: "att-05",
    storeId: "surat-main",
    staffId: "s-105",
    name: "Karan Mehta",
    initials: "KM",
    role: "Runner",
    shift: "Morning · 10:00–19:00",
    checkIn: "10:41",
    checkOut: null,
    // Geofence breach: pinged 180m away (still en route / off-site).
    status: "late",
    ping: { lat: 21.1872, lng: 72.8094 },
    distanceM: 184,
    withinFence: false,
  },
  {
    id: "att-06",
    storeId: "surat-main",
    staffId: "s-106",
    name: "Sneha Iyer",
    initials: "SI",
    role: "Sales Executive",
    shift: "—",
    checkIn: null,
    checkOut: null,
    status: "on_leave",
    ping: { lat: 0, lng: 0 },
    distanceM: 0,
    withinFence: false,
  },
  {
    id: "att-07",
    storeId: "mumbai-bandra",
    staffId: "s-201",
    name: "Aditya Nair",
    initials: "AN",
    role: "Senior Sales Executive",
    shift: "Morning · 11:00–20:00",
    checkIn: "10:55",
    checkOut: null,
    status: "present",
    ping: { lat: 19.0607, lng: 72.8361 },
    distanceM: 16,
    withinFence: true,
  },
  {
    id: "att-08",
    storeId: "mumbai-bandra",
    staffId: "s-202",
    name: "Fatima Shaikh",
    initials: "FS",
    role: "Sales Executive",
    shift: "Morning · 11:00–20:00",
    checkIn: "11:09",
    checkOut: null,
    status: "late",
    ping: { lat: 19.0605, lng: 72.8363 },
    distanceM: 24,
    withinFence: true,
  },
  {
    id: "att-09",
    storeId: "mumbai-bandra",
    staffId: "s-203",
    name: "Deepak Rao",
    initials: "DR",
    role: "Cashier",
    shift: "—",
    checkIn: null,
    checkOut: null,
    status: "absent",
    ping: { lat: 0, lng: 0 },
    distanceM: 0,
    withinFence: false,
  },
  {
    id: "att-10",
    storeId: "ahmedabad-cg",
    staffId: "s-301",
    name: "Meera Trivedi",
    initials: "MT",
    role: "Floor Manager",
    shift: "Full · 10:30–21:00",
    checkIn: "10:12",
    checkOut: null,
    status: "present",
    ping: { lat: 23.0299, lng: 72.5617 },
    distanceM: 18,
    withinFence: true,
  },
  {
    id: "att-11",
    storeId: "ahmedabad-cg",
    staffId: "s-302",
    name: "Harsh Solanki",
    initials: "HS",
    role: "Sales Executive",
    shift: "Morning · 10:30–19:30",
    checkIn: "10:25",
    checkOut: null,
    status: "present",
    ping: { lat: 23.0297, lng: 72.5615 },
    distanceM: 26,
    withinFence: true,
  },
];

/* ------------------------------------------------------------------ */
/* Weekly roster / shifts                                              */
/* ------------------------------------------------------------------ */

export const ROSTER_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const ROSTER: RosterRow[] = [
  {
    staffId: "s-101",
    name: "Priya Sharma",
    role: "Senior Sales Executive",
    storeId: "surat-main",
    week: [
      { day: "Mon", shift: "M" },
      { day: "Tue", shift: "M" },
      { day: "Wed", shift: "O" },
      { day: "Thu", shift: "M" },
      { day: "Fri", shift: "M" },
      { day: "Sat", shift: "E" },
      { day: "Sun", shift: "E" },
    ],
  },
  {
    staffId: "s-102",
    name: "Rohan Desai",
    role: "Sales Executive",
    storeId: "surat-main",
    week: [
      { day: "Mon", shift: "E" },
      { day: "Tue", shift: "E" },
      { day: "Wed", shift: "M" },
      { day: "Thu", shift: "O" },
      { day: "Fri", shift: "E" },
      { day: "Sat", shift: "M" },
      { day: "Sun", shift: "M" },
    ],
  },
  {
    staffId: "s-103",
    name: "Anjali Patel",
    role: "Cashier",
    storeId: "surat-main",
    week: [
      { day: "Mon", shift: "M" },
      { day: "Tue", shift: "M" },
      { day: "Wed", shift: "M" },
      { day: "Thu", shift: "M" },
      { day: "Fri", shift: "O" },
      { day: "Sat", shift: "M" },
      { day: "Sun", shift: "L" },
    ],
  },
  {
    staffId: "s-104",
    name: "Vikram Joshi",
    role: "Floor Manager",
    storeId: "surat-main",
    week: [
      { day: "Mon", shift: "M" },
      { day: "Tue", shift: "E" },
      { day: "Wed", shift: "M" },
      { day: "Thu", shift: "E" },
      { day: "Fri", shift: "M" },
      { day: "Sat", shift: "M" },
      { day: "Sun", shift: "O" },
    ],
  },
  {
    staffId: "s-105",
    name: "Karan Mehta",
    role: "Runner",
    storeId: "surat-main",
    week: [
      { day: "Mon", shift: "M" },
      { day: "Tue", shift: "M" },
      { day: "Wed", shift: "E" },
      { day: "Thu", shift: "M" },
      { day: "Fri", shift: "E" },
      { day: "Sat", shift: "E" },
      { day: "Sun", shift: "O" },
    ],
  },
  {
    staffId: "s-201",
    name: "Aditya Nair",
    role: "Senior Sales Executive",
    storeId: "mumbai-bandra",
    week: [
      { day: "Mon", shift: "M" },
      { day: "Tue", shift: "O" },
      { day: "Wed", shift: "M" },
      { day: "Thu", shift: "M" },
      { day: "Fri", shift: "E" },
      { day: "Sat", shift: "E" },
      { day: "Sun", shift: "E" },
    ],
  },
  {
    staffId: "s-202",
    name: "Fatima Shaikh",
    role: "Sales Executive",
    storeId: "mumbai-bandra",
    week: [
      { day: "Mon", shift: "E" },
      { day: "Tue", shift: "M" },
      { day: "Wed", shift: "L" },
      { day: "Thu", shift: "L" },
      { day: "Fri", shift: "M" },
      { day: "Sat", shift: "M" },
      { day: "Sun", shift: "O" },
    ],
  },
  {
    staffId: "s-301",
    name: "Meera Trivedi",
    role: "Floor Manager",
    storeId: "ahmedabad-cg",
    week: [
      { day: "Mon", shift: "M" },
      { day: "Tue", shift: "M" },
      { day: "Wed", shift: "E" },
      { day: "Thu", shift: "M" },
      { day: "Fri", shift: "M" },
      { day: "Sat", shift: "E" },
      { day: "Sun", shift: "O" },
    ],
  },
];

export const SHIFT_LABELS: Record<ShiftAssignment["shift"], string> = {
  M: "Morning",
  E: "Evening",
  O: "Off",
  L: "Leave",
};

/* ------------------------------------------------------------------ */
/* Leave requests                                                      */
/* ------------------------------------------------------------------ */

export const LEAVE_REQUESTS: LeaveRequest[] = [
  {
    id: "lv-01",
    storeId: "surat-main",
    staffId: "s-106",
    name: "Sneha Iyer",
    initials: "SI",
    type: "Sick",
    from: "17 Jun",
    to: "18 Jun",
    days: 2,
    reason: "Fever, doctor advised rest.",
    status: "approved",
  },
  {
    id: "lv-02",
    storeId: "surat-main",
    staffId: "s-103",
    name: "Anjali Patel",
    initials: "AP",
    type: "Festival",
    from: "22 Jun",
    to: "22 Jun",
    days: 1,
    reason: "Family pooja at home.",
    status: "pending",
  },
  {
    id: "lv-03",
    storeId: "mumbai-bandra",
    staffId: "s-202",
    name: "Fatima Shaikh",
    initials: "FS",
    type: "Casual",
    from: "19 Jun",
    to: "20 Jun",
    days: 2,
    reason: "Out-of-town wedding.",
    status: "pending",
  },
  {
    id: "lv-04",
    storeId: "mumbai-bandra",
    staffId: "s-203",
    name: "Deepak Rao",
    initials: "DR",
    type: "Earned",
    from: "25 Jun",
    to: "28 Jun",
    days: 4,
    reason: "Annual leave — hometown visit.",
    status: "pending",
  },
  {
    id: "lv-05",
    storeId: "ahmedabad-cg",
    staffId: "s-302",
    name: "Harsh Solanki",
    initials: "HS",
    type: "Casual",
    from: "21 Jun",
    to: "21 Jun",
    days: 1,
    reason: "Personal work.",
    status: "rejected",
  },
];

/* ------------------------------------------------------------------ */
/* Sales-staff leaderboard                                             */
/* ------------------------------------------------------------------ */

export const LEADERBOARD: LeaderboardRow[] = [
  {
    staffId: "s-101",
    name: "Priya Sharma",
    initials: "PS",
    role: "Senior Sales Executive",
    storeId: "surat-main",
    footfall: 64,
    quotes: 41,
    closed: 23,
    revenue: 4820000,
  },
  {
    staffId: "s-201",
    name: "Aditya Nair",
    initials: "AN",
    role: "Senior Sales Executive",
    storeId: "mumbai-bandra",
    footfall: 58,
    quotes: 37,
    closed: 21,
    revenue: 5310000,
  },
  {
    staffId: "s-102",
    name: "Rohan Desai",
    initials: "RD",
    role: "Sales Executive",
    storeId: "surat-main",
    footfall: 49,
    quotes: 28,
    closed: 14,
    revenue: 2640000,
  },
  {
    staffId: "s-302",
    name: "Harsh Solanki",
    initials: "HS",
    role: "Sales Executive",
    storeId: "ahmedabad-cg",
    footfall: 45,
    quotes: 24,
    closed: 12,
    revenue: 2180000,
  },
  {
    staffId: "s-202",
    name: "Fatima Shaikh",
    initials: "FS",
    role: "Sales Executive",
    storeId: "mumbai-bandra",
    footfall: 41,
    quotes: 22,
    closed: 11,
    revenue: 1970000,
  },
  {
    staffId: "s-106",
    name: "Sneha Iyer",
    initials: "SI",
    role: "Sales Executive",
    storeId: "surat-main",
    footfall: 33,
    quotes: 15,
    closed: 7,
    revenue: 1150000,
  },
];

/* ------------------------------------------------------------------ */
/* Commission engine                                                   */
/* ------------------------------------------------------------------ */

export const COMMISSIONS: CommissionRow[] = [
  {
    staffId: "s-101",
    name: "Priya Sharma",
    initials: "PS",
    role: "Senior Sales Executive",
    storeId: "surat-main",
    salesValue: 4820000,
    rate: 0.012,
    incentive: 57840,
    target: 4000000,
  },
  {
    staffId: "s-201",
    name: "Aditya Nair",
    initials: "AN",
    role: "Senior Sales Executive",
    storeId: "mumbai-bandra",
    salesValue: 5310000,
    rate: 0.012,
    incentive: 63720,
    target: 5000000,
  },
  {
    staffId: "s-102",
    name: "Rohan Desai",
    initials: "RD",
    role: "Sales Executive",
    storeId: "surat-main",
    salesValue: 2640000,
    rate: 0.01,
    incentive: 26400,
    target: 3000000,
  },
  {
    staffId: "s-302",
    name: "Harsh Solanki",
    initials: "HS",
    role: "Sales Executive",
    storeId: "ahmedabad-cg",
    salesValue: 2180000,
    rate: 0.01,
    incentive: 21800,
    target: 2500000,
  },
  {
    staffId: "s-202",
    name: "Fatima Shaikh",
    initials: "FS",
    role: "Sales Executive",
    storeId: "mumbai-bandra",
    salesValue: 1970000,
    rate: 0.01,
    incentive: 19700,
    target: 2500000,
  },
];

/* ------------------------------------------------------------------ */
/* Shifts / batches (seed — live data comes from GET /hrms/shifts)     */
/* ------------------------------------------------------------------ */

export const SHIFTS: Shift[] = [
  {
    id: "sh-01",
    storeId: "surat-main",
    name: "Morning",
    startTime: "10:00",
    endTime: "19:00",
    bufferMins: 15,
    isNightBatch: false,
  },
  {
    id: "sh-02",
    storeId: "mumbai-bandra",
    name: "First batch",
    startTime: "11:00",
    endTime: "20:00",
    bufferMins: 15,
    isNightBatch: false,
  },
  {
    id: "sh-03",
    storeId: "mumbai-bandra",
    name: "Second batch (night)",
    startTime: "14:00",
    endTime: "22:00",
    bufferMins: 15,
    isNightBatch: true,
  },
  {
    id: "sh-04",
    storeId: "ahmedabad-cg",
    name: "Morning",
    startTime: "10:30",
    endTime: "19:30",
    bufferMins: 10,
    isNightBatch: false,
  },
];

/* ------------------------------------------------------------------ */
/* Week-off + holidays (seed). No GET for week-off — PATCH only.       */
/* ------------------------------------------------------------------ */

/** Current weekly-off day per store, indexed 0 (Sun) – 6 (Sat). */
export const MOCK_WEEK_OFF: Record<string, number> = {
  "surat-main": 2, // Tuesday
  "mumbai-bandra": 1, // Monday
  "ahmedabad-cg": 3, // Wednesday
};

export const HOLIDAYS: Holiday[] = [
  { id: "hol-01", storeId: "surat-main", date: "2026-08-15", label: "Independence Day" },
  { id: "hol-02", storeId: "surat-main", date: "2026-08-28", label: "Ganesh Chaturthi" },
  { id: "hol-03", storeId: "mumbai-bandra", date: "2026-08-15", label: "Independence Day" },
  { id: "hol-04", storeId: "ahmedabad-cg", date: "2026-10-20", label: "Diwali" },
];

/* ------------------------------------------------------------------ */
/* Late flags — monthly roll-up (seed). 3× late → flag ONLY.           */
/* ------------------------------------------------------------------ */

export const LATE_FLAGS: LateFlag[] = [
  { staffId: "s-102", staffName: "Rohan Desai", storeId: "surat-main", lateCount: 4, flagged: true },
  { staffId: "s-105", staffName: "Karan Mehta", storeId: "surat-main", lateCount: 3, flagged: true },
  { staffId: "s-101", staffName: "Priya Sharma", storeId: "surat-main", lateCount: 1, flagged: false },
  { staffId: "s-202", staffName: "Fatima Shaikh", storeId: "mumbai-bandra", lateCount: 2, flagged: false },
  { staffId: "s-201", staffName: "Aditya Nair", storeId: "mumbai-bandra", lateCount: 0, flagged: false },
  { staffId: "s-302", staffName: "Harsh Solanki", storeId: "ahmedabad-cg", lateCount: 3, flagged: true },
];
