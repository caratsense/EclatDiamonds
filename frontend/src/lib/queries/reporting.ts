"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AxiosError } from "axios";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  DailyReport,
  DailyReportInput,
  DsrBasis,
  DsrHeadline,
  MoverRow,
  PaymentSource,
  ReportChannel,
  ReportPeriod,
  ReportSummary,
  StoreRevenue,
} from "@/lib/mock/reporting";

export type {
  DailyReport,
  DailyReportInput,
  ReportChannel,
  ReportPeriod,
  ReportSummary,
} from "@/lib/mock/reporting";

/**
 * Module 10 — Reporting & DSR query hooks.
 * Keyed on the active store id so the topbar store switcher refetches.
 */

export interface DsrResponse {
  headline: DsrHeadline[];
  paymentSources: PaymentSource[];
  storeRevenue: StoreRevenue[];
  basis?: DsrBasis;
}

/** GET /reporting/dsr — Daily Sales Report (headline KPIs, payment mix, store rows). */
export function useDsr() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["reporting", "dsr", storeId],
    queryFn: async () => {
      const { data } = await api.get<DsrResponse>("/reporting/dsr");
      return data;
    },
  });
}

/** GET /reporting/movers — fast/slow movers by category. */
export function useMovers() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["reporting", "movers", storeId],
    queryFn: async () => {
      const { data } = await api.get<MoverRow[]>("/reporting/movers");
      return data;
    },
  });
}

/**
 * GET /reporting/summary — period rollup (daily / weekly / monthly).
 * Daily data rolled up over the requested window. Keyed on period + date +
 * active store so the topbar store switcher and period control both refetch.
 */
export function useReportSummary(period: ReportPeriod, date?: string) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["reporting", "summary", period, date ?? null, storeId],
    queryFn: async () => {
      const { data } = await api.get<ReportSummary>("/reporting/summary", {
        params: { period, ...(date ? { date } : {}) },
      });
      return data;
    },
  });
}

export interface SendReportInput {
  period: ReportPeriod;
  /** Anchor date (YYYY-MM-DD); omit for the latest closed period. */
  date?: string;
  channel: ReportChannel;
  /** Phone number (WhatsApp) or email address. */
  to: string;
}

export interface SendReportResult {
  sent: boolean;
  channel: ReportChannel;
  /** True when that channel isn't configured yet — preview only, NOT an error. */
  disabled?: boolean;
  /** The composed report text the backend would deliver. */
  preview: string;
}

/** POST /reporting/send — deliver a composed rollup over WhatsApp or email. */
export function useSendReport() {
  return useMutation({
    mutationFn: async (input: SendReportInput) => {
      const { data } = await api.post<SendReportResult>(
        "/reporting/send",
        input,
      );
      return data;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Daily Report (DSR) — the manual store-close report (was typed on WhatsApp). */
/* -------------------------------------------------------------------------- */

const DAILY_REPORTS_KEY = "daily-reports";

export interface DsrCompliance {
  days: number;
  from: string | null;
  to: string | null;
  missingToday: number;
  stores: {
    storeId: string;
    storeName: string;
    submitted: number;
    missing: number;
    reportedToday: boolean;
    entries: {
      date: string;
      submitted: boolean;
      source: string | null;
      submittedBy: string | null;
      reportId: string | null;
    }[];
  }[];
}

/** GET /reporting/compliance — which branches filed a DSR on each of the last `days` days. */
export function useDsrCompliance(days = 7) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dsr-compliance", days, storeId],
    queryFn: async () => {
      const { data } = await api.get<DsrCompliance>("/reporting/compliance", { params: { days } });
      return data;
    },
  });
}

/**
 * GET /reporting/daily?date=&storeId= — recent filed DSRs, store-scoped.
 * Keyed on the optional date + active store so the topbar switcher refetches.
 */
export function useDailyReports(date?: string) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [DAILY_REPORTS_KEY, date ?? null, storeId],
    queryFn: async () => {
      const { data } = await api.get<DailyReport[]>("/reporting/daily", {
        params: { ...(date ? { date } : {}), storeId },
      });
      return data;
    },
  });
}

export type CreateDailyReportInput = DailyReportInput;

/** POST /reporting/daily — file a store-close report (returns composed text). */
export function useCreateDailyReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateDailyReportInput) => {
      const { data } = await api.post<DailyReport>("/reporting/daily", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [DAILY_REPORTS_KEY] });
    },
  });
}

export interface SendDailyReportInput {
  id: string;
  channel: ReportChannel;
  /** Phone number (WhatsApp) or email address. */
  to: string;
}

export interface SendDailyReportResult {
  sent: boolean;
  /** True when that channel isn't configured yet — preview only, NOT an error. */
  disabled?: boolean;
  /** The composed report text the backend would deliver. */
  preview: string;
}

/** POST /reporting/daily/:id/send — deliver a filed DSR over WhatsApp/email. */
export function useSendDailyReport() {
  return useMutation({
    mutationFn: async ({ id, ...body }: SendDailyReportInput) => {
      const { data } = await api.post<SendDailyReportResult>(
        `/reporting/daily/${id}/send`,
        body,
      );
      return data;
    },
  });
}

export type DsrSheetPeriod = "day" | "week" | "month";
export type DsrSheetFormat = "pdf" | "xlsx";

export interface DsrSheetInput {
  storeId: string;
  period: DsrSheetPeriod;
  /** Any day in the period (YYYY-MM-DD). */
  date: string;
  /** Defaults to the printable PDF. */
  format?: DsrSheetFormat;
}

/**
 * GET /reporting/daily/sheet — the store's DSRs laid out as its paper sheet,
 * saved as a file (PDF to print, XLSX to work on). Through axios, not a plain
 * link, so the bearer token and the `/_api` proxy apply; `responseType: "blob"`
 * keeps the bytes intact.
 */
export function useDownloadDsrSheet() {
  return useMutation({
    mutationFn: async (input: DsrSheetInput) => {
      let res;
      try {
        res = await api.get<Blob>("/reporting/daily/sheet", {
          params: input,
          responseType: "blob",
        });
      } catch (e) {
        // A refusal arrives as a Blob too; read it back so the reason shows.
        if (e instanceof AxiosError && e.response?.data instanceof Blob) {
          try {
            e.response.data = JSON.parse(await e.response.data.text());
          } catch {
            // Not JSON: leave it, the caller falls back to its own sentence.
          }
        }
        throw e;
      }
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const filename =
        /filename="?([^";]+)"?/i.exec(disposition)?.[1] ??
        `DSR-${input.storeId}-${input.period}-${input.date}.${input.format ?? "pdf"}`;
      const url = URL.createObjectURL(res.data);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      return { filename };
    },
  });
}

export interface SendDsrSheetInput extends DsrSheetInput {
  channel: ReportChannel;
  /** Phone number (WhatsApp) or email address. */
  to: string;
}

export interface SendDsrSheetResult extends SendDailyReportResult {
  /** The file that was attached, as the recipient sees it named. */
  filename: string;
}

/** POST /reporting/daily/sheet/send — the sheet as a file, over WhatsApp/email. */
export function useSendDsrSheet() {
  return useMutation({
    mutationFn: async (input: SendDsrSheetInput) => {
      const { data } = await api.post<SendDsrSheetResult>(
        "/reporting/daily/sheet/send",
        input,
      );
      return data;
    },
  });
}
