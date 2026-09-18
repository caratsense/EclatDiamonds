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
export type LeaveType =
  | "casual"
  | "sick"
  | "earned"
  | "festival"
  /** EzAttendance "K": one weekly off taken as leave (staff with no fixed off day). */
  | "week_off_leave";

/** Display labels for the lowercase leave-type keys (tiles + selects). */
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  casual: "Casual",
  sick: "Sick",
  earned: "Earned",
  festival: "Festival",
  week_off_leave: "Week-off leave",
};

/** Fixed display order for the balance tiles / type select. */
export const LEAVE_TYPE_ORDER: LeaveType[] = [
  "casual",
  "sick",
  "earned",
  "week_off_leave",
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
  /** Row id — needed by head office to correct a balance (PATCH /hrms/leave/balances/:id). */
  id?: string;
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
  /** No fixed start: lateness / early-out are never computed ("F" shift). */
  isFlexible?: boolean;
  /** Short code punch sources and the import refer to ("S", "G", "F", "6HR"). */
  code?: string | null;
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
/* Weekly roster / shifts                                              */
/* ------------------------------------------------------------------ */

export const ROSTER_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const SHIFT_LABELS: Record<ShiftAssignment["shift"], string> = {
  M: "Morning",
  E: "Evening",
  O: "Off",
  L: "Leave",
};
