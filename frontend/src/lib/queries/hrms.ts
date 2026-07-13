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
export type AttendanceStatus = "present" | "late" | "absent" | "on_leave";

export interface MarkAttendanceInput {
  staffName: string;
  status: AttendanceStatus;
  storeId: string;
  checkInAt?: string;
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

/** PATCH /hrms/leave/:id — approve/reject a leave request (manager+ only). */
export function useDecideLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LeaveStatus }) => {
      const { data } = await api.patch<LeaveRequest>(`/hrms/leave/${id}`, {
        status,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HRMS_KEY, "leave"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* A. Self-service geo check-in / check-out (Module 6)                 */
/* ------------------------------------------------------------------ */

export interface PunchInput {
  lat: number;
  lng: number;
  /** Optional shift/batch to score lateness against (check-in only). */
  shiftId?: string;
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
    mutationFn: async (input: { lat: number; lng: number }) => {
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
    mutationFn: async ({ id, status }: { id: string; status: LeaveStatus }) => {
      const { data } = await api.patch<Regularization>(
        `/hrms/regularize/${id}`,
        { status },
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
  /** HH:MM, 24-hour. */
  startTime: string;
  /** HH:MM, 24-hour. */
  endTime: string;
  bufferMins?: number;
  isNightBatch?: boolean;
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
export function useLateFlags(month: string) {
  const storeId = useStoreKey();
  return useQuery({
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
