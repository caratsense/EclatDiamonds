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

/**
 * `half_day` is written when a staffer attended but worked less than the shift's
 * full-day threshold; `week_off` and `holiday` are written by the end-of-day
 * close so a non-working day is explicitly recorded rather than looking like an
 * absence. Use `ATTENDANCE_STATUS_LABELS` for display and `NON_WORKING_STATUSES`
 * to exclude them from attendance percentages.
 */
export type AttendanceStatus =
  | "present"
  | "late"
  | "half_day"
  | "on_leave"
  | "absent"
  | "week_off"
  | "holiday";

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Present",
  late: "Late",
  half_day: "Half day",
  on_leave: "On leave",
  absent: "Absent",
  week_off: "Week off",
  holiday: "Holiday",
};

/** Statuses that are NOT a working day — never counted as an absence. */
export const NON_WORKING_STATUSES: AttendanceStatus[] = [
  "week_off",
  "holiday",
  "on_leave",
];

/** How an attendance row came to exist. */
export type AttendanceSource = "self" | "manager" | "regularization" | "auto";

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
  /** The store's display name — populated for the multi-store aggregate view. */
  storeName?: string | null;
  staffId: string;
  /** YYYY-MM-DD, the store-local business date this punch belongs to. */
  date?: string;
  name: string;
  initials: string;
  /** The staffer's real role label, resolved from their user record. */
  role: string;
  /** The assigned shift's label, or "Unassigned"/"—" when not applicable. */
  shift: string;
  /** HH:mm in the STORE's timezone, null while still to check in. */
  checkIn: string | null;
  checkOut: string | null;
  status: AttendanceStatus;
  /** Where the check-in ping landed; null components when no fix was captured. */
  ping: { lat: number | null; lng: number | null };
  /** Metres from the store centre at check-in; null when the store has no fence. */
  distanceM: number | null;
  /** Derived: ping within the store geofence radius. */
  withinFence: boolean;
  /** Shift/batch this check-in was measured against (Module 6). */
  shiftId?: string | null;
  /**
   * Derived server-side: check-in landed later than the assigned shift's
   * startTime + bufferMins, measured in the STORE's timezone. A 2nd-batch person
   * is NOT late for a morning shift's start — lateness is always relative to
   * their own shift, and night shifts crossing midnight are handled.
   */
  isLate?: boolean;
  /** Minutes past (shift start + buffer) at check-in; 0/undefined when on time. */
  lateMinutes?: number;
  workedMins?: number | null;
  /** Minutes worked beyond the shift's scheduled length. */
  overtimeMins?: number | null;
  /** Minutes the staffer left before the shift's scheduled end. */
  earlyOutMinutes?: number | null;
  /** Payroll credit for the day: 1 = full, 0.5 = half, 0 = none. */
  dayFraction?: number | null;
  /** Device reported a mock/spoofed GPS provider at punch time. */
  isMockLocation?: boolean;
  /** Justification supplied for an out-of-fence punch. */
  checkInNote?: string | null;
  checkOutNote?: string | null;
  source?: AttendanceSource;
  /** The day-close job closed a dangling punch at the shift's end. */
  autoClosed?: boolean;
  /** Server-flagged: off-site punch, spoofed GPS, or an auto-closed day. */
  needsReview?: boolean;
  /**
   * Where to ASK for the photo taken at the punch — an API route, not the
   * object's own URL, and only served to this staffer or a manager who covers
   * their branch. Null when no photo was taken.
   *
   * It is EVIDENCE, not identification: nothing compares it to an enrolled
   * face, and the identity on the record comes from the session that punched.
   * The fields sat unread on the server for the whole of the feature's life
   * because these four interfaces did not declare them, so a component that
   * tried to render one got a compile error.
   */
  checkInPhotoUrl?: string | null;
  checkOutPhotoUrl?: string | null;
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

/**
 * Canonical leave-type keys — match the backend Prisma enum, the apply-leave
 * body and the LeaveBalance rows. `festival` is unpaid (no allocation / cap).
 */
export type LeaveType = "casual" | "sick" | "earned" | "festival";

/** Display labels for the lowercase leave-type keys (tiles + selects). */
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  casual: "Casual",
  sick: "Sick",
  earned: "Earned",
  festival: "Festival",
};

/** Fixed display order for the balance tiles / type select. */
export const LEAVE_TYPE_ORDER: LeaveType[] = [
  "casual",
  "sick",
  "earned",
  "festival",
];

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequest {
  id: string;
  storeId: string;
  staffId: string;
  name: string;
  initials: string;
  /**
   * Display label from the backend leave view (e.g. "Casual"). The raw enum key
   * (LeaveType) is used only on the apply body + balance rows.
   */
  type: string;
  /** Raw enum key matching LeaveType. */
  typeCode?: LeaveType;
  from: string;
  to: string;
  /** YYYY-MM-DD forms of the same range, for date maths. */
  fromDate?: string;
  toDate?: string;
  days: number;
  /** Half-day request (counts as 0.5 day). */
  halfDay?: boolean;
  reason: string;
  status: LeaveStatus;
  /** Who decided it — required for any audit of an approval. */
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
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
  /** Commission row id — needed to PATCH the editable rate. */
  id: string;
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
/* Zoho-informed additions — self-service punch, balances, regularize  */
/* ------------------------------------------------------------------ */

/**
 * The current user's own attendance record (GET /hrms/attendance/me).
 * Geo-fencing is LENIENT: the punch is always recorded; `withinFence` +
 * `checkInDistanceM` merely flag whether it landed inside the store radius.
 * Lateness (`isLate`/`lateMinutes`) is measured against the assigned shift.
 */
export interface SelfAttendance {
  id: string;
  storeId: string;
  /** YYYY-MM-DD */
  date: string;
  status: AttendanceStatus;
  /** ISO datetime, or null before the punch lands. */
  checkInAt: string | null;
  checkOutAt: string | null;
  /**
   * HH:mm already rendered in the STORE's timezone. Prefer these over formatting
   * `checkInAt` on the device: a staffer whose phone is on another zone (or set
   * manually) would otherwise see a time their store never ran on.
   */
  checkInLocal?: string | null;
  checkOutLocal?: string | null;
  /** IANA timezone the punch times are expressed in. */
  timezone?: string;
  /** Metres from the store centre at check-in; null if the store has no coords. */
  checkInDistanceM: number | null;
  checkOutDistanceM?: number | null;
  withinFence: boolean;
  checkOutWithinFence?: boolean;
  /** Minutes worked once checked out; null while still checked in. */
  workedMins: number | null;
  /** Minutes beyond the shift's scheduled length. */
  overtimeMins?: number | null;
  /** Minutes short of the shift's scheduled end. */
  earlyOutMinutes?: number | null;
  /** Payroll credit for the day: 1 = full, 0.5 = half, 0 = none. */
  dayFraction?: number | null;
  isLate: boolean;
  lateMinutes: number | null;
  shiftId: string | null;
  /** Reason given for punching outside the store geofence. */
  checkInNote?: string | null;
  checkOutNote?: string | null;
  isMockLocation?: boolean;
  /** Closed by the end-of-day job because no check-out was recorded. */
  autoClosed?: boolean;
  source?: AttendanceSource;
  /** See AttendanceRecord.checkInPhotoUrl — an API route, not a storage URL. */
  checkInPhotoUrl?: string | null;
  checkOutPhotoUrl?: string | null;
}

/** A per-staff, per-type, per-year leave balance (GET /hrms/leave/balances). */
export interface LeaveBalance {
  /** Lowercase enum key — see LEAVE_TYPE_LABELS for the display label. */
  type: LeaveType;
  year: number;
  allocated: number;
  used: number;
  /** Days locked up in requests still awaiting a decision. */
  pending?: number;
  /** allocated − used. */
  balance: number;
  /**
   * What can actually still be applied for: `balance − pending`. Prefer this over
   * `balance` when showing a staffer what they may book — otherwise the number
   * double-counts days already committed to an undecided request.
   */
  available?: number;
  /** Display label for the type, e.g. "Casual". */
  label?: string;
  /** Financial-year display label, e.g. "2026–27". Present on newer rows. */
  financialYearLabel?: string;
}

/* ------------------------------------------------------------------ */
/* Attendance reports — date-range self report + manager team view     */
/* ------------------------------------------------------------------ */

/**
 * One day in an attendance report (GET /hrms/attendance/report). Geo-fencing is
 * LENIENT (the punch is always recorded); `withinFence`/`checkInDistanceM`
 * merely flag whether the check-in landed inside the store radius. Coordinates
 * are null when the store has no fence or the device couldn't capture a fix.
 */
export interface AttendanceReportRow {
  /** YYYY-MM-DD */
  date: string;
  status: AttendanceStatus;
  /** ISO datetime, or null. */
  checkInAt: string | null;
  checkOutAt: string | null;
  /** HH:mm pre-rendered in the store's timezone. */
  checkInLocal?: string | null;
  checkOutLocal?: string | null;
  /** Minutes worked once checked out; null while open / absent. */
  workedMins: number | null;
  overtimeMins?: number | null;
  earlyOutMinutes?: number | null;
  /** Payroll credit for the day: 1 / 0.5 / 0. */
  dayFraction?: number | null;
  isLate: boolean;
  lateMinutes: number | null;
  checkInLat: number | null;
  checkInLng: number | null;
  /** Metres from the store centre at check-in; null if no coords. */
  checkInDistanceM: number | null;
  withinFence: boolean;
  checkInNote?: string | null;
  isMockLocation?: boolean;
  autoClosed?: boolean;
  source?: AttendanceSource;
  shiftId: string | null;
  /** See AttendanceRecord.checkInPhotoUrl — an API route, not a storage URL. */
  checkInPhotoUrl?: string | null;
  checkOutPhotoUrl?: string | null;
}

/** Roll-up totals for a date-range attendance report. */
export interface AttendanceReportSummary {
  present: number;
  /** Days attended but short of the full-day threshold. */
  halfDay?: number;
  late: number;
  absent: number;
  onLeave: number;
  /** Week-offs + holidays. Excluded from the attendance percentage denominator. */
  nonWorking?: number;
  totalWorkedMins: number;
  totalOvertimeMins?: number;
  avgWorkedMins: number;
  /** Sum of day credits — the number payroll should consume. */
  payableDays?: number;
  /** Attended ÷ scheduled days, 0–100. */
  attendancePct?: number;
  /** On-time ÷ attended days, 0–100. */
  punctualityPct?: number;
}

/** A staffer's attendance over a date range, records newest-first. */
export interface AttendanceReport {
  /** YYYY-MM-DD */
  from: string;
  to: string;
  /** The staffer this report covers (self, or a managed team member). */
  staffId: string | null;
  records: AttendanceReportRow[];
  summary: AttendanceReportSummary;
}

/**
 * One staffer's punch for a single day (GET /hrms/attendance/team). The
 * manager's anti-buddy-punching view: everyone in scope for the chosen date,
 * with the geofence outcome surfaced prominently.
 */
export interface TeamPunch {
  staffId: string;
  staffName: string;
  storeId: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  /** HH:mm pre-rendered in the store's timezone. */
  checkInLocal?: string | null;
  checkOutLocal?: string | null;
  workedMins: number | null;
  overtimeMins?: number | null;
  isLate: boolean;
  lateMinutes: number | null;
  checkInLat: number | null;
  checkInLng: number | null;
  checkInDistanceM: number | null;
  withinFence: boolean;
  /** Reason the staffer gave for an out-of-fence punch. */
  checkInNote?: string | null;
  isMockLocation?: boolean;
  autoClosed?: boolean;
  /** Server-flagged: worth a manager's eyes (off-site, spoofed, or auto-closed). */
  needsReview?: boolean;
  /** See AttendanceRecord.checkInPhotoUrl — an API route, not a storage URL. */
  checkInPhotoUrl?: string | null;
  checkOutPhotoUrl?: string | null;
}

/**
 * An attendance-regularization request — a fix for a missed / wrong punch.
 * Reuses LeaveStatus (pending | approved | rejected).
 */
export interface Regularization {
  id: string;
  storeId: string;
  staffId: string;
  name: string;
  initials: string;
  /** YYYY-MM-DD — the day being corrected. */
  date: string;
  /** ISO datetime the staffer says they actually checked in / out. */
  requestedCheckIn: string | null;
  requestedCheckOut: string | null;
  reason: string | null;
  status: LeaveStatus;
  /** Who decided it — required for any audit of an approval. */
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
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
  /** Scheduled length in minutes, midnight-crossing aware. */
  scheduledMins?: number;
  /** Minutes that must be worked for a full day's payroll credit. */
  fullDayMins?: number;
  /** Minutes for a half day's credit; below this the day scores zero. */
  halfDayMins?: number;
  /** "Morning · 10:00–19:00" convenience label. */
  label?: string;
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
  /** Days actually attended in the month — the punctuality denominator. */
  attendedDays?: number;
  /** Share of attended days the staffer arrived on time, 0–100. */
  punctualityPct?: number;
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
    id: "cm-01",
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
    id: "cm-02",
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
    id: "cm-03",
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
    id: "cm-04",
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
    id: "cm-05",
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
// MOCK_WEEK_OFF removed: the weekly-off card now reads each store's own saved
// weekOffDay from the stores API rather than seeding from these constants.

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
