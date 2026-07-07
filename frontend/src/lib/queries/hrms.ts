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
  CommissionRow,
  Holiday,
  LateFlag,
  LeaderboardRow,
  LeaveRequest,
  LeaveStatus,
  Shift,
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
