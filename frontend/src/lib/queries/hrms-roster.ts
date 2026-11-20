"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { LeaveStatus, LeaveType } from "@/lib/mock/hrms";

/**
 * Module 6 — the roster grid and My Schedule (GET /hrms/roster,
 * GET /hrms/schedule/me).
 *
 * Both endpoints return the SAME envelope: one row per (employee, branch) and
 * one cell per actual DATE. Dates, not weekday names — the client's rule is a
 * variable weekly off ("Monday this week, Friday the next"), which a grid keyed
 * on weekdays cannot express.
 *
 * Nothing here recomputes a cell. Whether a day is an off, which shift applies
 * and whether leave covers it are the server's answers, decided by the same
 * rules the attendance register and payroll read through (`day-off.util`,
 * `resolveShiftFor`). A browser-side version of those rules would be a second
 * source of truth that silently disagrees with the register.
 *
 * Writes reuse the existing endpoints: shift assignments via
 * `@/lib/queries/hrms-ops`, dated and weekly offs via `@/lib/queries/payroll`.
 * There is no roster-specific write.
 */

const HRMS_KEY = "hrms";
const ROSTER_KEY = [HRMS_KEY, "roster"] as const;

export interface RosterShift {
  id: string;
  name: string;
  /** HH:MM, 24-hour, in the STORE's timezone. */
  startTime: string;
  endTime: string;
  isNightBatch: boolean;
  /** No fixed start: lateness is never computed. */
  isFlexible: boolean;
}

export interface RosterLeave {
  id: string;
  type: LeaveType;
  /** Only 'approved' and 'pending' reach the grid — the rest are not time off. */
  status: Extract<LeaveStatus, "approved" | "pending">;
  halfDay: boolean;
}

/** One employee's one date. */
export interface RosterDay {
  /** YYYY-MM-DD, store-local. */
  date: string;
  /** 0 (Sun) – 6 (Sat), read in the store's timezone. */
  weekday: number;
  /** False outside their employment — there is no roster to plan there. */
  employed: boolean;
  shift: RosterShift | null;
  /**
   * 'assignment' — somebody planned it. 'store_default' — nobody did, and this
   * is still the shift the register would time them against.
   */
  shiftSource: "assignment" | "store_default" | null;
  isOff: boolean;
  /** Which rule made it an off: the dated row for that week, or the pattern. */
  offSource: "dated" | "pattern" | null;
  isHoliday: boolean;
  holidayLabel: string | null;
  leave: RosterLeave | null;
  /**
   * Rostered onto an explicit shift on a day approved leave covers. A read-time
   * signal only — neither write is blocked, because leave is approved after the
   * roster is planned as often as the other way round.
   */
  conflict: "shift_on_approved_leave" | null;
}

export interface RosterEmployee {
  userId: string;
  name: string;
  role: string;
  employeeCode: string | null;
  storeId: string;
  storeName: string;
  timezone: string;
  isPrimary: boolean;
  /** What a week with no dated offs falls back to. */
  weekOffDays: number[];
  /** True when that fallback is the branch's day, not their own rows. */
  followsStore: boolean;
  days: RosterDay[];
}

export interface Roster {
  from: string;
  to: string;
  /** Every date in the span, ascending — the grid's columns. */
  dates: string[];
  stores: { id: string; name: string; timezone: string; weekOffDay: number | null }[];
  holidays: { id: string; storeId: string; date: string; label: string | null }[];
  employees: RosterEmployee[];
}

/**
 * GET /hrms/roster — the manager's planning grid for one span (manager+).
 *
 * `storeId` narrows a multi-branch scope; omitted, the X-Store-Id header
 * decides, and the topbar's "All Stores" returns every branch in scope.
 */
export function useRoster(
  params: { from: string; to: string; storeId?: string },
  options: { enabled?: boolean } = {},
) {
  const store = useStoreKey();
  return useQuery({
    queryKey: [...ROSTER_KEY, store, params],
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<Roster>("/hrms/roster", {
        params: {
          from: params.from,
          to: params.to,
          ...(params.storeId ? { storeId: params.storeId } : {}),
        },
      });
      return data;
    },
  });
}

/** GET /hrms/schedule/me — the caller's own rows, read-only, every role. */
export function useMySchedule(params: { from: string; to: string }) {
  const store = useStoreKey();
  return useQuery({
    queryKey: [HRMS_KEY, "schedule-me", store, params],
    queryFn: async () => {
      const { data } = await api.get<Roster>("/hrms/schedule/me", { params });
      return data;
    },
  });
}

/**
 * Refresh the grid after a write.
 *
 * The shift-assignment mutations already invalidate the whole "hrms" cache, so
 * the grid rides along. The dated/weekly-off mutations live in `payroll.ts` and
 * invalidate their own keys, not this one — a cell that was just set to Off
 * would keep drawing the old state. Call this from their onSuccess.
 */
export function useInvalidateRoster() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ROSTER_KEY });
    void qc.invalidateQueries({ queryKey: [HRMS_KEY, "schedule-me"] });
  };
}

/* ------------------------------------------------------------------ */
/* Calendar arithmetic on YYYY-MM-DD keys                              */
/* ------------------------------------------------------------------ */

/**
 * These never build a Date from a local-time string, because the keys are
 * store-local business dates and re-reading them through the device's timezone
 * is how a grid ends up a day out for anybody travelling.
 */

/** Today as a store-local-shaped key (en-CA renders YYYY-MM-DD). */
export function todayYmd(now = new Date()): string {
  return now.toLocaleDateString("en-CA");
}

export function addDaysYmd(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The Monday of this date's week — the SAME week boundary the server's
 * `weekKeyOf` uses. The grid has to agree with it: a dated off governs the week
 * it falls in, so a column shown in the wrong week would re-plan a week the
 * manager is not looking at.
 */
export function mondayOf(key: string): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  return addDaysYmd(key, -((d.getUTCDay() + 6) % 7));
}

/** The seven date keys of the week containing `key`, Monday first. */
export function weekDates(key: string): string[] {
  const monday = mondayOf(key);
  return Array.from({ length: 7 }, (_, i) => addDaysYmd(monday, i));
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "6 Oct" from a business date, no timezone re-reading. */
export function shortDate(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "Mon" — from the key itself, so it matches the column it labels. */
export function weekdayShort(key: string): string {
  return WEEKDAYS[new Date(`${key}T00:00:00.000Z`).getUTCDay()];
}

/** "October 2026" for a YYYY-MM month key. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${
    [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ][m - 1]
  } ${y}`;
}

/** The month key `n` months from this one. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** "Mon 6 Oct" — the full day label used in headings and My Schedule. */
export function dayLabel(key: string): string {
  return `${weekdayShort(key)} ${shortDate(key)}`;
}
