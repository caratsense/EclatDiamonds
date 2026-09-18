"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { AttendanceRecord, LeaveBalance } from "@/lib/mock/hrms";
import type { Role } from "@/lib/types";

/**
 * Module 6 — employee master, departments/designations and the EzAttendance
 * import. Contract: docs/modules/06-attendance.md ("Masters and employees").
 * Every write invalidates the whole "hrms" prefix: an employee change moves
 * Today, the register and reports too.
 */

const HRMS_KEY = "hrms";

export type EmploymentStatus = "active" | "inactive" | "separated";
export type EmploymentType = "full_time" | "part_time" | "contract";

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  separated: "Separated",
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
};

export interface Department {
  id: string;
  name: string;
  storeId: string | null;
  storeName: string | null;
  sortOrder: number;
  isActive: boolean;
  employeeCount: number;
}

export interface Designation {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  employeeCount?: number;
}

export interface Ref {
  id: string;
  name: string;
}

export interface EmployeeRow {
  userId: string;
  employeeCode: string | null;
  name: string;
  phone: string | null;
  loginEmail: string | null;
  personalEmail: string | null;
  role: Role;
  isActive: boolean;
  storeIds: string[];
  storeNames: string[];
  department: Ref | null;
  designation: Ref | null;
  unit: string | null;
  gender: string | null;
  /** Dates arrive as YYYY-MM-DD or ISO; always read with `ymd()`. */
  dateOfBirth: string | null;
  dateOfJoining: string | null;
  dateOfConfirmation: string | null;
  exitDate: string | null;
  exitReason: string | null;
  employmentType: EmploymentType | null;
  status: EmploymentStatus | null;
  bloodGroup: string | null;
  address: string | null;
  biometricNo: string | null;
  shiftCode: string | null;
  currentShift: { id: string; name: string; startTime: string; endTime: string } | null;
  reportingManager: Ref | null;
  source: string | null;
  /** false = a CaratOS staff login with no employee-master row yet. */
  hasProfile: boolean;
}

/** Recent attendance rows use the existing register view shape. */
export type EmployeeAttendanceRow = Pick<AttendanceRecord, "id" | "status" | "checkIn" | "checkOut"> &
  Partial<Pick<AttendanceRecord, "date" | "isLate" | "lateMinutes" | "storeName">> & {
    source?: string | null;
  };

export interface EmployeeDetail extends EmployeeRow {
  leaveBalances: LeaveBalance[];
  recentAttendance: EmployeeAttendanceRow[];
}

export interface EmployeeFilters {
  q?: string;
  departmentId?: string;
  designationId?: string;
  status?: EmploymentStatus;
  storeId?: string;
}

/** Writable profile fields — the create/edit dialog body. */
export interface EmployeeInput {
  name: string;
  phone?: string | null;
  role?: Role;
  storeIds?: string[];
  employeeCode?: string;
  personalEmail?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
  unit?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  dateOfJoining?: string | null;
  dateOfConfirmation?: string | null;
  employmentType?: EmploymentType;
  status?: EmploymentStatus;
  bloodGroup?: string | null;
  address?: string | null;
  biometricNo?: string | null;
  shiftCode?: string | null;
  reportingManagerId?: string | null;
}

export type BulkAction = "separate" | "activate" | "deactivate";

/** First 10 chars of an ISO/Date string → YYYY-MM-DD (no tz drift for @db.Date). */
export function ymd(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : "";
}

/** YYYY-MM-DD → "18 Sep 2026", read as a calendar date (no tz shift). */
export function formatYmd(v: string | null | undefined): string {
  const s = ymd(v);
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/* ------------------------------ masters ------------------------------ */

type MasterKind = "departments" | "designations";

function useMasterList<T>(kind: MasterKind) {
  return useQuery({
    queryKey: [HRMS_KEY, kind],
    queryFn: async () => (await api.get<T[]>(`/hrms/${kind}`)).data,
  });
}

export const useDepartments = () => useMasterList<Department>("departments");
export const useDesignations = () => useMasterList<Designation>("designations");

export interface MasterInput {
  name: string;
  storeId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/** Create / update / delete for either master, one hook each. */
export function useSaveMaster(kind: MasterKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: MasterInput & { id?: string }) =>
      id
        ? (await api.patch(`/hrms/${kind}/${id}`, body)).data
        : (await api.post(`/hrms/${kind}`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [HRMS_KEY] }),
  });
}

/** DELETE — the API answers 409 while employees still reference it, unless `reassignTo`. */
export function useDeleteMaster(kind: MasterKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reassignTo }: { id: string; reassignTo?: string }) =>
      (
        await api.delete(`/hrms/${kind}/${id}`, {
          params: reassignTo ? { reassignTo } : undefined,
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [HRMS_KEY] }),
  });
}

/* ----------------------------- employees ----------------------------- */

export function useEmployees(filters: EmployeeFilters) {
  const storeKey = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "employees", storeKey, filters],
    queryFn: async () => {
      const params = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v),
      );
      return (await api.get<EmployeeRow[]>("/hrms/employees", { params })).data;
    },
  });
}

export function useEmployee(userId: string | null) {
  return useQuery({
    queryKey: [HRMS_KEY, "employees", "detail", userId],
    enabled: !!userId,
    queryFn: async () =>
      (await api.get<EmployeeDetail>(`/hrms/employees/${userId}`)).data,
  });
}

export function useSaveEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, ...body }: EmployeeInput & { userId?: string }) =>
      userId
        ? (await api.patch<EmployeeRow>(`/hrms/employees/${userId}`, body)).data
        : (await api.post<EmployeeRow>("/hrms/employees", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [HRMS_KEY] }),
  });
}

/** Separate (default) or, with `purge`, delete the profile row (head office, no history only). */
export function useSeparateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      userId,
      exitDate,
      exitReason,
      purge,
    }: {
      userId: string;
      exitDate?: string;
      exitReason?: string;
      purge?: boolean;
    }) =>
      (
        await api.delete(`/hrms/employees/${userId}`, {
          data: { exitDate, exitReason },
          params: purge ? { purge: 1 } : undefined,
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [HRMS_KEY] }),
  });
}

export function useBulkEmployees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { userIds: string[]; action: BulkAction }) =>
      (await api.post("/hrms/employees/bulk", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [HRMS_KEY] }),
  });
}

/* ------------------------ EzAttendance import ------------------------ */

export interface ImportResult {
  dryRun: boolean;
  employees: {
    created: number;
    updated: number;
    unchanged: number;
    rows: { code: string; name: string; action: "create" | "update" | "unchanged"; changes: string[] }[];
  };
  departments: { created: string[]; mapped: Record<string, string | null> };
  designations: { created: string[] };
  leaveBalances: { upserted: number; skipped: { code: string; reason: string }[] };
  attendance: { upserted: number; skipped: { code: string; reason: string }[] };
  notInSource: { userId: string; name: string; role: Role; storeNames: string[] }[];
  exceptions: { code: string; field: string; issue: string }[];
}

export interface ImportInput {
  employees: File;
  leaveBalances?: File | null;
  todaysPunch?: File | null;
  attendanceDate?: string;
  departmentStores: Record<string, string | null>;
  dryRun: boolean;
}

export function useEzAttendanceImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ImportInput) => {
      const fd = new FormData();
      fd.append("employees", input.employees);
      if (input.leaveBalances) fd.append("leaveBalances", input.leaveBalances);
      if (input.todaysPunch) fd.append("todaysPunch", input.todaysPunch);
      if (input.attendanceDate) fd.append("attendanceDate", input.attendanceDate);
      fd.append("departmentStores", JSON.stringify(input.departmentStores));
      fd.append("dryRun", input.dryRun ? "1" : "0");
      // Clear the instance's JSON Content-Type or axios serialises the FormData
      // as "{}" and the files never arrive (see UPLOAD in queries/imports.ts).
      return (
        await api.post<ImportResult>("/hrms/import/ezattendance", fd, {
          headers: { "Content-Type": undefined },
          transformRequest: [(d) => d],
          timeout: 120000,
        })
      ).data;
    },
    onSuccess: (res) => {
      if (!res.dryRun) qc.invalidateQueries({ queryKey: [HRMS_KEY] });
    },
  });
}
