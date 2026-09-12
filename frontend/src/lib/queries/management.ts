"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The management view.
 *
 * Every figure arrives already aggregated and already scoped — nothing here
 * re-counts, re-filters or re-totals. A browser that summed a page of rows would
 * disagree with the server the moment a tenant outgrew one page, and the
 * disagreement would appear exactly when the numbers started to matter.
 *
 * A `Ratio` deliberately carries its own working. `value: null` means the
 * question could not be asked, which is not the same as 0% — a branch that
 * converted none of forty leads and one that had no leads at all are different
 * Tuesdays, and a screen that renders both as 0% teaches people to ignore it.
 */

export interface Ratio {
  /** Percentage, or null when the denominator was zero. */
  value: number | null;
  numerator: number;
  denominator: number;
}

export interface KpiWindow {
  from: string;
  to: string;
  timezone: string;
  /** True when branches in scope disagree and one clock had to be chosen. */
  ambiguous: boolean;
  zonesInScope: string[];
  resolvedBy: "requested" | "single_store" | "organisation_default";
  fromDate: string;
  toDate: string;
}

export interface Counted {
  key: string | null;
  label?: string;
  count: number;
}

export interface KpiReport {
  window: KpiWindow;
  scope: {
    stores: { id: string; name: string }[];
    ownerId?: string | null;
    organisationWide?: boolean;
    /** Present INSTEAD of the sections when nothing can be computed. */
    unavailable?: string;
  };
  leads?: {
    total: number;
    perDayAverage: number;
    bySource: Counted[];
    byStore: Counted[];
    byOwner: Counted[];
    byStage: Counted[];
    newCustomers: number;
    returningCustomers: number;
    measuredAdAttribution: number;
  };
  engagement?: {
    byChannel: Counted[];
    unanswered: number;
    averageFirstResponseSeconds: number | null;
    answeredWithinTarget: number;
    breached: number;
    escalated: number;
    firstResponseByHuman: number;
    firstResponseByApprovedAi: number;
    slaMeasured: number;
  };
  followUps?: {
    total: number;
    completed: number;
    open: number;
    overdue: number;
    completionRate: Ratio;
    digest: Record<string, number>;
    calls: {
      total: number;
      byOutcome: Record<string, number>;
      answered: number;
      manual: number;
    };
  };
  floor?: {
    visits: number;
    byStore: Counted[];
    byOutcome: Counted[];
    visitToLead: Ratio;
    visitToSale: Ratio;
    walkOuts: number;
  };
  quotes?: {
    total: number;
    byStatus: Record<string, number>;
    averageApprovedAmount: number | null;
    approvalTurnaroundHours: {
      average: number;
      sampled: number;
      sampleCapped: boolean;
    } | null;
  };
  feedback?: {
    requested: number;
    delivered: number;
    responded: number;
    positive: number;
    negativeOrEscalated: number;
    reviewLinksOffered: number;
    responseRate: Ratio;
  };
  operations?: {
    scheduledReports: Record<string, number>;
    latestReport: {
      periodKey: string;
      status: string;
      at: string;
      delivered: boolean;
    } | null;
    imports: {
      batches: number;
      imported: number;
      rejectedRows: number;
      skipped: number;
    };
    deadJobs: number;
  };
  conversion?: {
    bySource: (Ratio & { key: string; label: string })[];
    byStore: (Ratio & { key: string; label: string })[];
    byOwner: (Ratio & { key: string; label: string })[];
    measured: Ratio & { note: string };
  };
}

export interface KpiFilters {
  from?: string;
  to?: string;
  storeId?: string;
  ownerId?: string;
  source?: string;
  channel?: string;
  tagId?: string;
  timezone?: string;
}

export function useManagementKpis(filters: KpiFilters = {}) {
  return useQuery({
    queryKey: ["management-kpis", filters],
    queryFn: async () => {
      const { data } = await api.get<KpiReport>("/management/kpis", {
        params: filters,
        // These are real aggregates across several tables. A short client
        // timeout would report a slow query as a broken screen.
        timeout: 60_000,
      });
      return data;
    },
    staleTime: 2 * 60_000,
  });
}

/**
 * Download the rows behind the lead figures.
 *
 * Through axios rather than a plain link: the API needs the bearer token, which
 * an `<a href>` cannot carry, and the export is audited against the person who
 * asked for it. `responseType: "blob"` matters too — without it the XLSX bytes
 * are read as text and the saved file will not open.
 */
export function useDownloadLeadExport() {
  return useMutation({
    mutationFn: async (filters: KpiFilters) => {
      const res = await api.get<Blob>("/management/export/leads", {
        params: filters,
        responseType: "blob",
        timeout: 120_000,
      });
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? "leads.xlsx";

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

/** Seconds as something a person reads without converting it in their head. */
export function humanSeconds(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  return `${Math.round((minutes / 60) * 10) / 10} h`;
}

/** A ratio, or an em dash when it could not be computed. Never a bare 0%. */
export function percent(r: Ratio | undefined): string {
  if (!r || r.value == null) return "—";
  return `${r.value}%`;
}
