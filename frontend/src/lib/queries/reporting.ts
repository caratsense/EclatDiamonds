"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  DsrHeadline,
  MoverRow,
  PaymentSource,
  ReportChannel,
  ReportPeriod,
  ReportSummary,
  StoreRevenue,
} from "@/lib/mock/reporting";

export type {
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
