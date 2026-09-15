"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The roster and the payslip.
 *
 * Two rules the screens built on this must not break. A payslip's numbers come
 * from the server's snapshot, never recomputed in the browser — an issued slip is
 * what the employee was shown, and a figure derived client-side would drift the
 * moment anything about the roster changed. And pay is not public: these hooks
 * hit endpoints that refuse a colleague's data, so a screen cannot leak it by
 * accident.
 */

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface WeekOffStaff {
  userId: string;
  name: string;
  storeId: string | null;
  /** Their own days. Empty means they follow the branch. */
  days: number[];
  /** What actually applies — their own days, or the branch's. */
  effectiveDays: number[];
  followsStore: boolean;
}

export interface WeekOffRoster {
  stores: { id: string; name: string; weekOffDay: number | null }[];
  staff: WeekOffStaff[];
}

export interface Compensation {
  id: string;
  userId: string;
  /** 'monthly' — offs and holidays are paid. 'daily' — only days worked are. */
  basis: string;
  amount: number;
  paidLeavePerMonth: number | null;
  /** Null means overtime is recorded but not paid. */
  overtimeHourlyRate: number | null;
}

export interface PayslipDay {
  date: string;
  kind: "present" | "half" | "absent" | "leave" | "week_off" | "holiday" | "no_record";
  credit: number;
  paid: boolean;
}

export interface Payslip {
  id: string;
  userId: string;
  staffName: string;
  storeId: string | null;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  /** 'draft' recomputes on request; 'issued' never changes. */
  status: "draft" | "issued";
  issuedAt: string | null;
  calendarDays: number;
  weeklyOffDays: number;
  holidayDays: number;
  presentDays: number;
  paidLeaveDays: number;
  unpaidDays: number;
  overtimeMins: number;
  basis: string;
  amount: number;
  perDayRate: number;
  earnedAmount: number;
  overtimeAmount: number;
  deductionAmount: number;
  netPay: number;
  /** Shown on every slip, so "net pay" is never read as take-home. */
  note: string;
  breakdown?: PayslipDay[];
  /**
   * Issued, and the register has moved since. The figures above stand; this
   * names what changed so a person can settle it.
   */
  difference: PayslipDifference | null;
  differenceDetectedAt: string | null;
}

export interface PayslipDifference {
  days: {
    date: string;
    was: { kind: PayslipDay["kind"]; credit: number } | null;
    now: { kind: PayslipDay["kind"]; credit: number };
  }[];
  presentDays: { was: number; now: number };
  overtimeMins: { was: number; now: number };
}

/** One branch-month run: the month-end scheduler's, or a person's re-run. */
export interface PayrollRun {
  id: string;
  storeId: string;
  periodKey: string;
  trigger: "scheduler" | "user";
  triggeredByName: string | null;
  /** A 'started' run that never finished is a process that died part-way. */
  status: "started" | "completed" | "failed";
  generated: number;
  skipped: number;
  issued: number;
  differences: number;
  skippedDetail: { name: string; reason: string }[] | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const ROSTER_KEY = ["week-offs"] as const;
const SLIP_KEY = ["payslips"] as const;
const RUN_KEY = ["payroll-runs"] as const;

export function useWeekOffRoster(storeId?: string) {
  return useQuery({
    queryKey: [...ROSTER_KEY, storeId ?? "all"],
    queryFn: async () => {
      const { data } = await api.get<WeekOffRoster>("/hrms/payroll/week-offs", {
        params: storeId ? { storeId } : undefined,
      });
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSetWeekOffs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; storeId?: string | null; days: number[] }) => {
      const { data } = await api.put<WeekOffRoster>("/hrms/payroll/week-offs", input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ROSTER_KEY });
      // The roster decides which days the day-close marks as off, so the
      // attendance register's future reads change with it.
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
  });
}

export function useCompensation(userId: string | null) {
  return useQuery({
    queryKey: ["compensation", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data } = await api.get<Compensation | null>(
        `/hrms/payroll/compensation/${userId}`,
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSetCompensation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      userId: string;
      basis?: string;
      amount: number;
      paidLeavePerMonth?: number | null;
      overtimeHourlyRate?: number | null;
    }) => {
      const { data } = await api.put<Compensation>("/hrms/payroll/compensation", input);
      return data;
    },
    onSuccess: (_res, input) => {
      void qc.invalidateQueries({ queryKey: ["compensation", input.userId] });
    },
  });
}

export function usePayslips(filters: { periodKey?: string; userId?: string; storeId?: string } = {}) {
  return useQuery({
    queryKey: [...SLIP_KEY, filters],
    queryFn: async () => {
      const { data } = await api.get<Payslip[]>("/hrms/payroll/payslips", { params: filters });
      return data;
    },
    staleTime: 60_000,
  });
}

/** One slip, with the day-by-day breakdown behind its totals. */
export function usePayslip(id: string | null) {
  return useQuery({
    queryKey: [...SLIP_KEY, "one", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await api.get<Payslip>(`/hrms/payroll/payslips/${id}`);
      return data;
    },
    staleTime: 60_000,
  });
}

export function useGeneratePayslips() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId?: string; storeId?: string; periodKey: string }) => {
      const { data } = await api.post<
        Payslip | { periodKey: string; generated: number; skipped: { name: string; reason: string }[] }
      >("/hrms/payroll/payslips/generate", input, { timeout: 120_000 });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SLIP_KEY });
      // Generating is a run too, and leaves a row in the run log.
      void qc.invalidateQueries({ queryKey: RUN_KEY });
    },
  });
}

/** Management only — the endpoint refuses anybody else. */
export function usePayrollRuns(filters: { periodKey?: string; storeId?: string }, enabled: boolean) {
  return useQuery({
    queryKey: [...RUN_KEY, filters],
    enabled,
    queryFn: async () => {
      const { data } = await api.get<PayrollRun[]>("/hrms/payroll/runs", { params: filters });
      return data;
    },
    staleTime: 60_000,
  });
}

/** Run one branch's month again. Drafts only; an issued slip is never rewritten. */
export function useRerunPayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { storeId: string; periodKey: string }) => {
      const { data } = await api.post<PayrollRun>("/hrms/payroll/runs", input, {
        timeout: 120_000,
      });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: RUN_KEY });
      void qc.invalidateQueries({ queryKey: SLIP_KEY });
    },
  });
}

export function useIssuePayslip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<Payslip>(`/hrms/payroll/payslips/${id}/issue`);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SLIP_KEY });
    },
  });
}

/** Human labels for a breakdown row. */
export const DAY_KIND: Record<PayslipDay["kind"], { label: string; tone: "good" | "bad" | "wait" | "mute" }> = {
  present: { label: "Present", tone: "good" },
  half: { label: "Half day", tone: "wait" },
  leave: { label: "Leave", tone: "wait" },
  week_off: { label: "Weekly off", tone: "mute" },
  holiday: { label: "Holiday", tone: "mute" },
  absent: { label: "Absent", tone: "bad" },
  // Deliberately distinct from "Absent": the register says nothing, which is a
  // different conversation from "they did not come".
  no_record: { label: "Nothing recorded", tone: "bad" },
};

/** The current month as a period key, which is what these endpoints take. */
export function currentPeriodKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
