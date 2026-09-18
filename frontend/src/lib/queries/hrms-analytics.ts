"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AxiosError } from "axios";

import { api } from "@/lib/api";
import { useSession } from "@/store/use-session";

/**
 * Module 6 — attendance analytics + the report centre.
 * Contract: docs/modules/06-attendance.md ("Analytics and reports").
 * Both endpoints are store_manager+; the backend clamps scope to the token and
 * `storeId` only narrows ("all" = every store in the caller's scope).
 */

const HRMS_KEY = "hrms";

/* ------------------------------ dates ------------------------------ */

/** Local calendar date as YYYY-MM-DD (never toISOString — that is UTC). */
export function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type PeriodPreset = "this_month" | "last_month" | "last_7" | "custom";

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_7: "Last 7 days",
  custom: "Custom range",
};

/** from/to for a preset, relative to `now` (store-local dates). */
export function presetRange(
  preset: Exclude<PeriodPreset, "custom">,
  now = new Date(),
): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (preset === "last_month") {
    return { from: localYmd(new Date(y, m - 1, 1)), to: localYmd(new Date(y, m, 0)) };
  }
  if (preset === "last_7") {
    return { from: localYmd(new Date(y, m, now.getDate() - 6)), to: localYmd(now) };
  }
  return { from: localYmd(new Date(y, m, 1)), to: localYmd(now) };
}

/** "2026-09" → the whole month as from/to. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  return { from: localYmd(new Date(y, m - 1, 1)), to: localYmd(new Date(y, m, 0)) };
}

/* --------------------------- store filter --------------------------- */

/**
 * Store filter for the analytics/report screens: follows the topbar store
 * (the aggregate "All stores" maps to "all") until the user picks another
 * one here. Topbar changes re-sync it (render-time adjust, no effect).
 */
export function useStoreFilter() {
  const currentStore = useSession((s) => s.currentStore);
  const stores = useSession((s) => s.stores).filter((s) => !s.isAggregate);
  const topbar = currentStore.isAggregate ? "all" : currentStore.id;
  const [storeId, setStoreId] = useState(topbar);
  const [seen, setSeen] = useState(topbar);
  if (seen !== topbar) {
    setSeen(topbar);
    setStoreId(topbar);
  }
  return { storeId, setStoreId, stores };
}

/* ----------------------------- overview ----------------------------- */

export interface AnalyticsFilters {
  from: string;
  to: string;
  /** A store id, or "all" for every store in scope. */
  storeId: string;
  departmentId?: string;
}

export interface AnalyticsKpis {
  /** Percent, 0-100. */
  attendanceRate: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  lateCount: number;
  avgLateMinutes: number;
  halfDays: number;
  overtimeHours: number;
  missedPunches: number;
  newJoiners: number;
  exits: number;
}

/** One business date. `present` INCLUDES the late ones (late is a modifier). */
export interface TrendPoint {
  date: string;
  present: number;
  late: number;
  half_day?: number;
  absent: number;
  on_leave: number;
  week_off: number;
  holiday: number;
  not_marked?: number;
}

export interface BreakdownRow {
  headcount: number;
  attendanceRate: number;
  lateCount: number;
  absentDays: number;
}

export interface StoreBreakdown extends BreakdownRow {
  storeId: string;
  storeName: string;
}

export interface DepartmentBreakdown extends BreakdownRow {
  departmentId: string | null;
  departmentName: string;
}

export interface AnalyticsOverview {
  period: { from: string; to: string };
  headcount: number;
  kpis: AnalyticsKpis;
  trend: TrendPoint[];
  byStore: StoreBreakdown[];
  byDepartment: DepartmentBreakdown[];
  topLate: { userId: string; name: string; lateCount: number; avgLateMinutes: number }[];
  topAbsent: { userId: string; name: string; absentDays: number }[];
}

/** Drop blank params so the API sees only real filters. */
function clean(params: object): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Record<string, string | number>;
}

/** GET /hrms/analytics/overview */
export function useAttendanceOverview(f: AnalyticsFilters) {
  return useQuery({
    queryKey: [HRMS_KEY, "analytics", "overview", f],
    enabled: !!f.from && !!f.to,
    queryFn: async () =>
      (await api.get<AnalyticsOverview>("/hrms/analytics/overview", { params: clean(f) })).data,
  });
}

/* ------------------------------ reports ------------------------------ */

export type ReportKind =
  | "daily-register"
  | "muster"
  | "monthly-summary"
  | "in-out"
  | "late-early"
  | "missed-punch"
  | "constant-absent"
  | "leave-balance"
  | "leave-register"
  | "punch-log"
  | "gps"
  | "birthdays"
  | "hiring"
  | "separation"
  | "employee-details";

export interface ReportParams {
  from?: string;
  to?: string;
  storeId?: string;
  departmentId?: string;
  userId?: string;
  /** constant-absent only. */
  minDays?: number;
  /** birthdays only, 1-12. */
  month?: number;
}

export interface ReportColumn {
  key: string;
  label: string;
}

export type ReportCell = string | number | boolean | null;

export interface ReportResponse {
  kind: ReportKind;
  period?: { from: string; to: string };
  columns: ReportColumn[];
  rows: Record<string, ReportCell>[];
  /** Keyed like a row; absent/null when the report has no totals. */
  totals?: Record<string, ReportCell> | null;
}

/** GET /hrms/reports/:kind (JSON) */
export function useAttendanceReportData(kind: ReportKind, params: ReportParams) {
  return useQuery({
    queryKey: [HRMS_KEY, "reports", kind, params],
    queryFn: async () =>
      (await api.get<ReportResponse>(`/hrms/reports/${kind}`, { params: clean(params) })).data,
  });
}

/**
 * GET /hrms/reports/:kind?format=csv — saves the file. `responseType: "blob"`
 * makes a refusal arrive as a Blob too, so it is read back into JSON for
 * `apiErrorMessage`. The filename comes from Content-Disposition.
 */
export type AttendanceExportFormat = "csv" | "xlsx" | "pdf";

export function useDownloadAttendanceReport() {
  return useMutation({
    mutationFn: async ({
      kind,
      params,
      format,
    }: {
      kind: ReportKind;
      params: ReportParams;
      format: AttendanceExportFormat;
    }) => {
      let res;
      try {
        res = await api.get<Blob>(`/hrms/reports/${kind}`, {
          params: { ...clean(params), format },
          responseType: "blob",
        });
      } catch (e) {
        if (e instanceof AxiosError && e.response?.data instanceof Blob) {
          try {
            e.response.data = JSON.parse(await e.response.data.text());
          } catch {
            // Not JSON: the caller falls back to its own sentence.
          }
        }
        throw e;
      }
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const filename =
        /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `attendance-${kind}.${format}`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      if (format === "pdf") {
        // The API marks PDFs inline; a new browser tab gives the operator the
        // native print/save viewer without adding a client-side PDF library.
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      } else {
        a.download = filename;
      }
      a.click();
      if (format === "pdf") {
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        URL.revokeObjectURL(url);
      }
      return { filename, format };
    },
  });
}
