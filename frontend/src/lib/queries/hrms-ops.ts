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
  AttendanceStatus,
  Holiday,
  LeaveStatus,
  LeaveType,
  Shift,
} from "@/lib/mock/hrms";

/**
 * Module 6 — attendance operations (docs/modules/06-attendance.md, "Attendance
 * operations"). Today snapshot, register corrections, the raw punch ledger,
 * processing runs, payroll locks, the approvals inbox and the shift/holiday/
 * assignment edits. Every key sits under "hrms" and carries the active store so
 * a store switch refetches.
 */

const K = "hrms";

/** Attendance writes ripple into Today, the register, reports and analytics —
 * refresh the whole HRMS cache rather than guess which views changed. */
function useInvalidateHrms() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [K] });
}

/** Drop empty filter values so they never reach the query string. */
function clean<T extends Record<string, unknown>>(params: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Partial<T>;
}

/** Master references may arrive as a plain label or as `{id, name}`. */
export type NamedRef = string | { id?: string; name: string } | null | undefined;
export function refName(v: NamedRef): string {
  if (!v) return "—";
  return typeof v === "string" ? v : v.name;
}

/* ------------------------------------------------------------------ */
/* Today snapshot                                                      */
/* ------------------------------------------------------------------ */

/** Exactly one primary state per eligible employee per day. */
export type DayState =
  | "present"
  | "half_day"
  | "absent"
  | "on_leave"
  | "week_off"
  | "holiday"
  | "not_marked";

export const DAY_STATES: DayState[] = [
  "present",
  "half_day",
  "absent",
  "on_leave",
  "week_off",
  "holiday",
  "not_marked",
];

export const DAY_STATE_LABELS: Record<DayState, string> = {
  present: "Present",
  half_day: "Half day",
  absent: "Absent",
  on_leave: "On leave",
  week_off: "Week off",
  holiday: "Holiday",
  not_marked: "Not marked",
};

export interface TodayRow {
  userId: string;
  employeeCode: string | null;
  name: string;
  storeId: string;
  storeName: string;
  department: NamedRef;
  designation: NamedRef;
  shift: NamedRef;
  state: DayState;
  isLate: boolean;
  lateMinutes: number | null;
  /** HH:MM store-local. */
  checkIn: string | null;
  checkOut: string | null;
  /** Null when nothing is written for the day yet (not_marked). */
  recordId: string | null;
}

export interface TodaySnapshot {
  snapshotAt: string;
  stores: { storeId: string; storeName: string; timezone: string; date: string }[];
  denominator: number;
  /** `late` is a subset of `present`, never part of the sum. */
  counts: Record<DayState, number> & { late: number };
  rows: TodayRow[];
}

/** GET /hrms/attendance/today — refreshed every minute while open. */
export function useTodaySnapshot(storeId?: string) {
  const store = useStoreKey();
  return useQuery({
    queryKey: [K, "attendance", "today", store, storeId ?? ""],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data } = await api.get<TodaySnapshot>("/hrms/attendance/today", {
        params: clean({ storeId }),
      });
      return data;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Register + corrections                                              */
/* ------------------------------------------------------------------ */

export type RegisterRow = AttendanceRecord & {
  recordId: string;
  source?: string;
  employeeCode?: string | null;
};

export interface RegisterParams {
  from: string;
  to: string;
  storeId?: string;
  userId?: string;
  status?: string;
  page: number;
  pageSize: number;
}

/** GET /hrms/attendance/register — paginated `{items, total}`. */
export function useAttendanceRegister(params: RegisterParams) {
  const store = useStoreKey();
  return useQuery({
    queryKey: [K, "attendance", "register", store, params],
    enabled: !!params.from && !!params.to,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data } = await api.get<{ items: RegisterRow[]; total: number }>(
        "/hrms/attendance/register",
        { params: clean({ ...params }) },
      );
      return data;
    },
  });
}

export interface EditAttendanceInput {
  id: string;
  status?: AttendanceStatus;
  /** HH:MM store-local. */
  checkIn?: string;
  checkOut?: string;
  shiftId?: string;
  note: string;
}

/** PATCH /hrms/attendance/:id — correction with a mandatory note. */
export function useEditAttendance() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, ...body }: EditAttendanceInput) => {
      const { data } = await api.patch<RegisterRow>(`/hrms/attendance/${id}`, body);
      return data;
    },
    onSuccess: invalidate,
  });
}

/** DELETE /hrms/attendance/:id — removes the register row; raw punches stay. */
export function useDeleteAttendance() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await api.delete(`/hrms/attendance/${id}`, { data: { reason } });
    },
    onSuccess: invalidate,
  });
}

/* ------------------------------------------------------------------ */
/* Raw punch ledger                                                    */
/* ------------------------------------------------------------------ */

export interface RawPunch {
  id: string;
  userId: string;
  name: string;
  employeeCode: string | null;
  storeName: string | null;
  kind: "in" | "out";
  eventAt: string;
  /** Store-local display time. */
  local: string | null;
  source: string;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  note: string | null;
  voidedAt: string | null;
}

export function usePunches(
  params: { from: string; to: string; storeId?: string; userId?: string },
  options: { enabled?: boolean } = {},
) {
  const store = useStoreKey();
  return useQuery({
    queryKey: [K, "punches", store, params],
    enabled: (options.enabled ?? true) && !!params.from && !!params.to,
    queryFn: async () => {
      const { data } = await api.get<RawPunch[]>("/hrms/punches", {
        params: clean({ ...params }),
      });
      return data;
    },
  });
}

export interface AddPunchInput {
  userId: string;
  storeId: string;
  kind: "in" | "out";
  /** ISO datetime. */
  at: string;
  note: string;
}

export function useAddPunch() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async (input: AddPunchInput) => {
      const { data } = await api.post<RawPunch>("/hrms/punches", input);
      return data;
    },
    onSuccess: invalidate,
  });
}

/** DELETE /hrms/punches/:id — voids the punch; the row stays as evidence. */
export function useVoidPunch() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await api.delete(`/hrms/punches/${id}`, { data: { reason } });
    },
    onSuccess: invalidate,
  });
}

/* ------------------------------------------------------------------ */
/* Processing runs + payroll locks (head office)                       */
/* ------------------------------------------------------------------ */

export interface ProcessingRun {
  id: string;
  storeId: string | null;
  storeName?: string | null;
  fromDate: string;
  toDate: string;
  status: "running" | "done" | "failed" | string;
  processed: number;
  changed: number;
  skippedLocked: number;
  startedAt: string;
  finishedAt: string | null;
}

export function useProcessingRuns(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [K, "processing-runs"],
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<ProcessingRun[]>("/hrms/processing-runs");
      return data;
    },
  });
}

export function useStartProcessingRun() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async (input: { from: string; to: string; storeId?: string }) => {
      const { data } = await api.post<ProcessingRun>(
        "/hrms/processing-runs",
        clean(input),
        // A month of recompute can outlast the default 15 s.
        { timeout: 120_000 },
      );
      return data;
    },
    onSuccess: invalidate,
  });
}

export interface PayrollLock {
  id: string;
  /** YYYY-MM */
  month: string;
  lockedAt: string;
  lockedBy?: NamedRef;
  reopenedAt: string | null;
  reopenedBy?: NamedRef;
  reopenReason: string | null;
}

export function usePayrollLocks(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [K, "payroll-locks"],
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<PayrollLock[]>("/hrms/payroll-locks");
      return data;
    },
  });
}

export function useLockPayrollMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (month: string) => {
      const { data } = await api.post<PayrollLock>("/hrms/payroll-locks", { month });
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [K, "payroll-locks"] }),
  });
}

export function useReopenPayrollMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ month, reason }: { month: string; reason: string }) => {
      const { data } = await api.post<PayrollLock>(
        `/hrms/payroll-locks/${month}/reopen`,
        { reason },
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [K, "payroll-locks"] }),
  });
}

/* ------------------------------------------------------------------ */
/* Approvals inbox                                                     */
/* ------------------------------------------------------------------ */

export type ApprovalKind = "leave" | "regularization";

export interface ApprovalItem {
  kind: ApprovalKind;
  id: string;
  staffId: string;
  staffName: string;
  storeName: string | null;
  submittedAt: string;
  summary: string;
  /** YYYY-MM-DD */
  from: string;
  to: string;
  days?: number;
  reason: string | null;
  status: LeaveStatus;
  ageHours: number;
  /** Present on leave items when the API sends them — used to prefill an edit. */
  leaveType?: LeaveType;
  halfDay?: boolean;
}

/** GET /hrms/approvals?status — omitted status = every status. */
export function useApprovals(
  status?: LeaveStatus,
  options: { enabled?: boolean } = {},
) {
  const store = useStoreKey();
  return useQuery({
    queryKey: [K, "approvals", store, status ?? "all"],
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<ApprovalItem[]>("/hrms/approvals", {
        params: clean({ status }),
      });
      return data;
    },
  });
}

/** Decisions reuse the existing PATCH routes: /hrms/leave/:id, /hrms/regularize/:id. */
export function useDecideApproval() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({
      kind,
      id,
      status,
      note,
    }: {
      kind: ApprovalKind;
      id: string;
      status: "approved" | "rejected";
      note?: string;
    }) => {
      const path = kind === "leave" ? `/hrms/leave/${id}` : `/hrms/regularize/${id}`;
      await api.patch(path, { status, ...(note ? { note } : {}) });
    },
    onSuccess: invalidate,
  });
}

export interface EditLeaveInput {
  id: string;
  fromDate: string;
  toDate: string;
  type: LeaveType;
  halfDay: boolean;
  reason: string;
}

export function useEditLeave() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, ...body }: EditLeaveInput) => {
      await api.patch(`/hrms/leave/${id}/edit`, body);
    },
    onSuccess: invalidate,
  });
}

export function useDeleteLeave() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await api.delete(`/hrms/leave/${id}`, { data: { reason } });
    },
    onSuccess: invalidate,
  });
}

/* ------------------------------------------------------------------ */
/* Leave balances (head office)                                        */
/* ------------------------------------------------------------------ */

export function useEditLeaveBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      allocated?: number;
      used?: number;
      note: string;
    }) => {
      await api.patch(`/hrms/leave/balances/${id}`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [K, "leave"] }),
  });
}

export function useCreateLeaveBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      userId: string;
      type: LeaveType;
      year: number;
      allocated: number;
    }) => {
      await api.post("/hrms/leave/balances", body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [K, "leave"] }),
  });
}

/* ------------------------------------------------------------------ */
/* Shifts, holidays, shift assignments                                 */
/* ------------------------------------------------------------------ */

export interface UpdateShiftInput {
  id: string;
  name?: string;
  code?: string | null;
  startTime?: string;
  endTime?: string;
  bufferMins?: number;
  isNightBatch?: boolean;
  isFlexible?: boolean;
}

export function useUpdateShift() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateShiftInput) => {
      const { data } = await api.patch<Shift>(`/hrms/shifts/${id}`, body);
      return data;
    },
    onSuccess: invalidate,
  });
}

/** `force` unassigns staff still on the shift (the API 409s without it). */
export function useDeleteShift() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, force }: { id: string; force?: boolean }) => {
      await api.delete(`/hrms/shifts/${id}`, {
        params: force ? { force: 1 } : undefined,
      });
    },
    onSuccess: invalidate,
  });
}

export function useUpdateHoliday() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; date?: string; label?: string }) => {
      const { data } = await api.patch<Holiday>(`/hrms/holidays/${id}`, body);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteHoliday() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/hrms/holidays/${id}`);
    },
    onSuccess: invalidate,
  });
}

export interface ShiftAssignmentRow {
  id: string;
  userId: string;
  userName?: string | null;
  name?: string | null;
  shiftId: string;
  shiftName?: string | null;
  shift?: { id: string; name: string; startTime: string; endTime: string } | null;
  /** YYYY-MM-DD (or ISO). */
  effectiveFrom: string;
  effectiveTo: string | null;
}

export function useShiftAssignments(params: { userId?: string; storeId?: string }) {
  const store = useStoreKey();
  return useQuery({
    queryKey: [K, "shift-assignments", store, params],
    queryFn: async () => {
      const { data } = await api.get<ShiftAssignmentRow[]>("/hrms/shift-assignments", {
        params: clean({ ...params }),
      });
      return data;
    },
  });
}

export function useCreateShiftAssignment() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async (body: { userId: string; shiftId: string; effectiveFrom: string }) => {
      await api.post("/hrms/shift-assignments", body);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateShiftAssignment() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      shiftId?: string;
      effectiveFrom?: string;
      effectiveTo?: string | null;
    }) => {
      await api.patch(`/hrms/shift-assignments/${id}`, body);
    },
    onSuccess: invalidate,
  });
}

export function useDeleteShiftAssignment() {
  const invalidate = useInvalidateHrms();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/hrms/shift-assignments/${id}`);
    },
    onSuccess: invalidate,
  });
}
