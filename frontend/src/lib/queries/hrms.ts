"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  AttendanceRecord,
  AttendanceReport,
  AttendanceReportSummary,
  CommissionRow,
  Holiday,
  LateFlag,
  LeaderboardRow,
  LeaveBalance,
  LeaveRequest,
  LeaveStatus,
  LeaveType,
  Regularization,
  SelfAttendance,
  Shift,
  TeamPunch,
} from "@/lib/mock/hrms";

/**
 * Module 6 — HRMS & Geo-Tagged Attendance.
 * Live react-query hooks against the NestJS `/hrms/*` endpoints. Every list
 * query is keyed on the active store id (useStoreKey) so switching the store
 * in the topbar refetches automatically (store-switcher refetch).
 *
 * The backend already shapes rows into the frontend view models (see
 * hrms.service.ts) — `role` is synthesized ("Sales Executive"), `shift` is a
 * synthesized label, and `withinFence` derives from `geoVerified`. We type the
 * responses against the existing mock interfaces so the tab components consume
 * them unchanged.
 */

const HRMS_KEY = "hrms";

/** Attendance status options written by the mark-attendance action. */
export type AttendanceStatus =
  | "present"
  | "late"
  | "half_day"
  | "absent"
  | "on_leave";

export interface MarkAttendanceInput {
  /**
   * The staff member being marked — REQUIRED. Omitting it used to mint a
   * throwaway id that no report could attribute; the API now rejects that.
   */
  staffId: string;
  staffName?: string;
  status: AttendanceStatus;
  storeId: string;
  checkInAt?: string;
  /** Day being marked (YYYY-MM-DD, store-local). Defaults to the store's today. */
  date?: string;
  /**
   * Shift/batch to measure lateness against. Omitted → backend uses the
   * store's default shift. A 2nd-batch person's lateness is scored against
   * their own shift start, never the morning shift's.
   */
  shiftId?: string;
}

/** GET /hrms/attendance — today's geo-verified attendance, store-scoped. */
export function useAttendance() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "attendance", storeId],
    queryFn: async () => {
      const { data } = await api.get<AttendanceRecord[]>("/hrms/attendance");
      return data;
    },
  });
}

/** POST /hrms/attendance — mark a staff member's attendance for today. */
export function useMarkAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MarkAttendanceInput) => {
      const { data } = await api.post<AttendanceRecord>(
        "/hrms/attendance",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "attendance"] });
    },
  });
}

/** GET /hrms/leave — leave requests, store-scoped. */
export function useLeaveRequests() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "leave", storeId],
    queryFn: async () => {
      const { data } = await api.get<LeaveRequest[]>("/hrms/leave");
      return data;
    },
  });
}

/**
 * PATCH /hrms/leave/:id — approve/reject a leave request (manager+ only).
 *
 * The API refuses a decision on a request the caller raised themselves (403) and
 * refuses a second decision on one already settled (400) — surface those messages
 * rather than swallowing them.
 */
export function useDecideLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
      note,
    }: {
      id: string;
      status: LeaveStatus;
      /** Rationale recorded on the request and shown back to the applicant. */
      note?: string;
    }) => {
      const { data } = await api.patch<LeaveRequest>(`/hrms/leave/${id}`, {
        status,
        ...(note ? { note } : {}),
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "leave"] });
    },
  });
}

/**
 * PATCH /hrms/leave/:id/cancel — withdraw a request.
 *
 * The applicant may withdraw their own while it is pending; a manager+ may also
 * revoke one already approved, which releases the days back to the balance.
 */
export function useCancelLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const { data } = await api.patch<LeaveRequest>(
        `/hrms/leave/${id}/cancel`,
        reason ? { reason } : {},
      );
      return data;
    },
    onSuccess: () => {
      // Prefix invalidation covers the leave list and the balance rows.
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "leave"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* A. Self-service geo check-in / check-out (Module 6)                 */
/* ------------------------------------------------------------------ */

export interface PunchInput {
  /**
   * Coordinates at the moment of the punch. Leave BOTH undefined when the device
   * gave no fix — never send 0/0 as a stand-in. Null Island is a real place
   * ~8,200 km from Mumbai, so the server reads it as a punch from the far side of
   * the world and demands an explanation for a user who simply had no GPS.
   */
  lat?: number;
  lng?: number;
  /** Optional shift/batch to score lateness against (check-in only). */
  shiftId?: string;
  /**
   * Justification for punching from outside the store geofence. The API REJECTS
   * an out-of-fence punch without one (400) — the UI must collect it. The punch
   * itself is never blocked; it just has to be explained.
   */
  note?: string;
  /** The device reported a mock/spoofed location provider (check-in only). */
  isMockLocation?: boolean;
  /**
   * A `data:image/jpeg;base64,` frame from the device camera, taken at the
   * moment of the punch.
   *
   * Corroboration, not identification: nothing compares it to an enrolled face,
   * so the record it produces never claims WHO punched. Always optional — a
   * punch is never refused for the want of a working camera.
   */
  photo?: string;
}

/**
 * GET /hrms/attendance/me?month=YYYY-MM — the current user's own punches.
 * Returns today's state (or null) + this-month's records. Keyed on the active
 * store so switching stores refetches; the X-Store-Id header scopes it server-side.
 */
export function useMyAttendance(month: string) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "attendance", "me", storeId, month],
    queryFn: async () => {
      const { data } = await api.get<{
        today: SelfAttendance | null;
        records: SelfAttendance[];
        summary: AttendanceReportSummary;
      }>("/hrms/attendance/me", { params: { month } });
      return data;
    },
  });
}

/** POST /hrms/attendance/check-in — the current user punches in (lat/lng). */
export function useCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PunchInput) => {
      const { data } = await api.post<SelfAttendance>(
        "/hrms/attendance/check-in",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "attendance"] });
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "attendance", "me"] });
    },
  });
}

/** POST /hrms/attendance/check-out — the current user punches out (400 if not in). */
export function useCheckOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { lat: number; lng: number; note?: string; photo?: string }) => {
      const { data } = await api.post<SelfAttendance>(
        "/hrms/attendance/check-out",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "attendance"] });
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "attendance", "me"] });
    },
  });
}

/**
 * The resolved store's geofence for the caller. `latitude`/`longitude` are null
 * when the store has no coordinates set (`hasCoords === false`), in which case
 * automatic geo-detection is impossible and the UI must fall back to a manual
 * punch. `geofenceRadiusM` is the "within range" radius in metres.
 */
export interface Geofence {
  storeId: string;
  storeName: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
  hasCoords: boolean;
  /** IANA timezone the store's shifts and business days are resolved in. */
  timezone?: string;
  /**
   * When true (always, currently), an out-of-fence punch must carry a `note`.
   * The client should prompt for one rather than letting the API 400.
   */
  requiresReasonOutsideFence?: boolean;
}

/**
 * GET /hrms/geofence — the caller's resolved store centre + radius. Cached for
 * ~5 min (store coordinates rarely change) and keyed on the active store so a
 * store switch refetches. Drives the auto check-in geofence on the check-in screen.
 */
export function useGeofence() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "geofence", storeId],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await api.get<Geofence>("/hrms/geofence");
      return data;
    },
  });
}

/* ------------------------------------------------------------------ */
/* A2. Attendance reports — date-range self report + team day view     */
/* ------------------------------------------------------------------ */

export interface AttendanceReportParams {
  /** YYYY-MM-DD (inclusive). */
  from: string;
  /** YYYY-MM-DD (inclusive). */
  to: string;
  /**
   * Report for another staffer in scope (managers only). Omitted → the
   * current user's own report.
   */
  staffId?: string;
}

/**
 * GET /hrms/attendance/report?from&to&staffId? — a staffer's attendance over a
 * date range with summary totals. Records come newest-first. Disabled until
 * both dates are set. Keyed on the active store so switching stores refetches.
 */
export function useAttendanceReport({
  from,
  to,
  staffId,
}: Partial<AttendanceReportParams>) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [
      HRMS_KEY,
      "attendance",
      "report",
      storeId,
      from ?? "",
      to ?? "",
      staffId ?? "me",
    ],
    enabled: !!from && !!to,
    queryFn: async () => {
      const { data } = await api.get<AttendanceReport>(
        "/hrms/attendance/report",
        { params: { from, to, ...(staffId ? { staffId } : {}) } },
      );
      return data;
    },
  });
}

/**
 * GET /hrms/attendance/team?date=YYYY-MM-DD — everyone's punch for that day in
 * scope (store_manager+). The manager's anti-buddy-punching view. Keyed on the
 * active store; disabled until a date is chosen.
 */
export function useTeamAttendance(date: string) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "attendance", "team", storeId, date],
    enabled: !!date,
    queryFn: async () => {
      const { data } = await api.get<TeamPunch[]>("/hrms/attendance/team", {
        params: { date },
      });
      return data;
    },
  });
}

/* ------------------------------------------------------------------ */
/* B. Leave balances + apply (Module 6)                                */
/* ------------------------------------------------------------------ */

/**
 * GET /hrms/leave/balances?staffId? — leave balances (self by default; a
 * manager+ may pass a team member's staffId). Auto-seeds the year on first read.
 */
export function useLeaveBalances(staffId?: string) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "leave", "balances", storeId, staffId ?? "me"],
    queryFn: async () => {
      const { data } = await api.get<LeaveBalance[]>("/hrms/leave/balances", {
        params: staffId ? { staffId } : undefined,
      });
      return data;
    },
  });
}

export interface ApplyLeaveInput {
  type: LeaveType;
  /** YYYY-MM-DD (inclusive). */
  fromDate: string;
  /** YYYY-MM-DD (inclusive). */
  toDate: string;
  /** Explicit day count; auto-computed (working days) when omitted. */
  days?: number;
  halfDay?: boolean;
  reason?: string;
}

/** POST /hrms/leave — apply for leave (self). Invalidates leave + balances. */
export function useApplyLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApplyLeaveInput) => {
      const { data } = await api.post<LeaveRequest>("/hrms/leave", input);
      return data;
    },
    onSuccess: () => {
      // Prefix invalidation covers both the leave list and the balance rows.
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "leave"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* C. Attendance regularization (Module 6)                             */
/* ------------------------------------------------------------------ */

export interface CreateRegularizationInput {
  /** YYYY-MM-DD — the day being corrected. */
  date: string;
  /** ISO datetime the staffer actually checked in / out. */
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reason?: string;
}

/** GET /hrms/regularize — regularization requests (staff see only their own). */
export function useRegularizations() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "regularize", storeId],
    queryFn: async () => {
      const { data } = await api.get<Regularization[]>("/hrms/regularize");
      return data;
    },
  });
}

/** POST /hrms/regularize — request a fix for a missed/wrong punch (self). */
export function useCreateRegularization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRegularizationInput) => {
      const { data } = await api.post<Regularization>("/hrms/regularize", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "regularize"] });
    },
  });
}

/** PATCH /hrms/regularize/:id — approve/reject (manager+). Corrects the record. */
export function useDecideRegularization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
      note,
    }: {
      id: string;
      status: LeaveStatus;
      note?: string;
    }) => {
      const { data } = await api.patch<Regularization>(
        `/hrms/regularize/${id}`,
        { status, ...(note ? { note } : {}) },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "regularize"] });
      // Approval rewrites the attendance record — refresh attendance too.
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "attendance"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* D. Editable commission rate (Module 6 → surfaced on Sales)          */
/* ------------------------------------------------------------------ */

/**
 * PATCH /hrms/commission/:id — set the commission rate (manager+). `rate` is a
 * PERCENT of sales value (e.g. 2.5 = 2.5%), 0–100; the backend recomputes the
 * incentive amount and returns the refreshed commission view.
 */
export function useUpdateCommissionRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, rate }: { id: string; rate: number }) => {
      const { data } = await api.patch<CommissionRow>(
        `/hrms/commission/${id}`,
        { rate },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "commission"] });
    },
  });
}

/** GET /hrms/leaderboard — sales-staff leaderboard (this month), store-scoped. */
export function useLeaderboard() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "leaderboard", storeId],
    queryFn: async () => {
      const { data } = await api.get<LeaderboardRow[]>("/hrms/leaderboard");
      return data;
    },
  });
}

/** GET /hrms/commission — incentive rows, store-scoped. */
export function useCommission() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "commission", storeId],
    queryFn: async () => {
      const { data } = await api.get<CommissionRow[]>("/hrms/commission");
      return data;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Shifts / batches (Module 6)                                         */
/* ------------------------------------------------------------------ */

export interface CreateShiftInput {
  storeId: string;
  name: string;
  /** HH:MM, 24-hour, in the STORE's timezone. */
  startTime: string;
  /** HH:MM, 24-hour. May be earlier than startTime for a night batch. */
  endTime: string;
  bufferMins?: number;
  isNightBatch?: boolean;
  /** Minutes worked for a full day's payroll credit. Defaults to the shift length. */
  fullDayMins?: number;
  /** Minutes for a half day's credit. Defaults to half the full-day threshold. */
  halfDayMins?: number;
}

/* ------------------------------------------------------------------ */
/* Day close — end-of-day reconciliation (Module 6)                    */
/* ------------------------------------------------------------------ */

export interface DayCloseResult {
  storeId: string;
  /** YYYY-MM-DD, store-local. */
  date: string;
  timezone: string;
  staffConsidered: number;
  /** Dangling punches closed at the shift's scheduled end. */
  autoClosed: number;
  markedAbsent: number;
  markedOnLeave: number;
  /** Week-offs + holidays written so they don't read as absences. */
  markedNonWorking: number;
}

/**
 * POST /hrms/attendance/day-close — close a working day for a store.
 *
 * Writes an explicit row for everyone who never punched (absent / on_leave /
 * week_off / holiday) and closes any dangling punch at the shift's end. Without
 * this, absence leaves no record at all. Idempotent — safe to re-run.
 * Defaults to the previous store-local day when `date` is omitted.
 */
export function useDayClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { storeId: string; date?: string }) => {
      const { data } = await api.post<DayCloseResult>(
        "/hrms/attendance/day-close",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "attendance"] });
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "late-flags"] });
    },
  });
}

/** GET /hrms/shifts — store shifts/batches, store-scoped. */
export function useShifts() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "shifts", storeId],
    queryFn: async () => {
      const { data } = await api.get<Shift[]>("/hrms/shifts");
      return data;
    },
  });
}

/** POST /hrms/shifts — add a shift/batch to a store. */
export function useCreateShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateShiftInput) => {
      const { data } = await api.post<Shift>("/hrms/shifts", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "shifts"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Week-off + holidays (Module 6)                                      */
/* ------------------------------------------------------------------ */

export interface AddHolidayInput {
  storeId: string;
  /** yyyy-mm-dd */
  date: string;
  label?: string;
}

export interface SetWeekOffInput {
  storeId: string;
  /** 0 (Sun) – 6 (Sat). */
  weekOffDay: number;
}

/** GET /hrms/holidays — store holidays, store-scoped. */
export function useHolidays() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "holidays", storeId],
    queryFn: async () => {
      const { data } = await api.get<Holiday[]>("/hrms/holidays");
      return data;
    },
  });
}

/** POST /hrms/holidays — add a store holiday. */
export function useAddHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddHolidayInput) => {
      const { data } = await api.post<Holiday>("/hrms/holidays", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "holidays"] });
    },
  });
}

/** PATCH /hrms/week-off — set a store's weekly-off day (HO only). */
export function useSetWeekOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetWeekOffInput) => {
      const { data } = await api.patch<{ storeId: string; weekOffDay: number }>(
        "/hrms/week-off",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "week-off"] });
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "holidays"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Late flags (Module 6) — 3× late/month → flag ONLY (deferred cut).   */
/* ------------------------------------------------------------------ */

/**
 * GET /hrms/late-flags?month=YYYY-MM — monthly late roll-up, store-scoped.
 * `flagged` is true at ≥3 lates. This is a FLAG only; salary / half-day
 * automation is deferred (see the UI caption).
 */
export function useLateFlags(month: string, options: { enabled?: boolean } = {}) {
  const storeId = useStoreKey();
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: [HRMS_KEY, "late-flags", storeId, month],
    queryFn: async () => {
      // Server wraps the rows: { month, note, staff: LateFlag[] } — unwrap to
      // the array the tab expects (else rows.filter/.map crashes the page).
      const { data } = await api.get<{ staff?: LateFlag[] } | LateFlag[]>(
        "/hrms/late-flags",
        { params: { month } },
      );
      return Array.isArray(data) ? data : (data.staff ?? []);
    },
  });
}
