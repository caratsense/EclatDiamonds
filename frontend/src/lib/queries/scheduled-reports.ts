"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Reports that arrive without anybody asking for them.
 *
 * The same workbook as the manual export, on a schedule, with the columns the
 * tenant chose. Nothing here builds a file in the browser — the server owns one
 * spreadsheet writer, so the emailed file and the downloaded one cannot drift
 * apart.
 */

/** Every column the lead report can carry, in the order the server lists them. */
export const REPORT_COLUMNS = [
  { key: "customerName", label: "Customer" },
  { key: "phone", label: "Phone" },
  { key: "ref", label: "Lead ref" },
  { key: "store", label: "Store" },
  { key: "owner", label: "Owner" },
  { key: "source", label: "Source" },
  { key: "campaign", label: "Campaign" },
  { key: "adId", label: "Ad ID" },
  { key: "tags", label: "Tags" },
  { key: "stage", label: "Stage" },
  { key: "outcome", label: "Outcome" },
  { key: "createdAt", label: "Created" },
  { key: "lastActivity", label: "Last activity" },
  { key: "nextFollowUp", label: "Next follow-up" },
  { key: "visitCount", label: "Visits" },
  { key: "value", label: "Value" },
] as const;

export interface ScheduledReportRun {
  id: string;
  periodKey: string;
  periodFrom: string;
  periodTo: string;
  rows: number;
  status: "ok" | "empty" | "failed";
  detail: string | null;
  /** `dry_run` means the file was built and email is not configured here. */
  emailStatus: "sent" | "dry_run" | "no_recipients" | "failed";
  emailDetail: string | null;
  recipients: string[];
  createdAt: string;
}

export interface ScheduledReport {
  id: string;
  name: string;
  kind: string;
  storeId: string | null;
  storeName: string | null;
  cadence: "monthly" | "weekly";
  sendHour: number;
  /** Empty means every column. */
  columns: string[];
  recipients: string[];
  isActive: boolean;
  lastRunAt: string | null;
  lastRun: Pick<
    ScheduledReportRun,
    "periodKey" | "rows" | "status" | "emailStatus" | "emailDetail" | "createdAt"
  > | null;
}

export interface ScheduledReportInput {
  name?: string;
  storeId?: string | null;
  cadence?: "monthly" | "weekly";
  sendHour?: number;
  columns?: string[];
  recipients?: string[];
  isActive?: boolean;
}

const KEY = ["scheduled-reports"] as const;

export function useScheduledReports() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data } = await api.get<ScheduledReport[]>("/reporting/scheduled");
      return data;
    },
    staleTime: 60_000,
  });
}

export function useScheduledReportRuns(reportId: string | null) {
  return useQuery({
    queryKey: [...KEY, reportId, "runs"],
    enabled: Boolean(reportId),
    queryFn: async () => {
      const { data } = await api.get<ScheduledReportRun[]>(
        `/reporting/scheduled/${reportId}/runs`,
      );
      return data;
    },
    staleTime: 60_000,
  });
}

export function useCreateScheduledReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ScheduledReportInput & { name: string }) => {
      const { data } = await api.post<ScheduledReport>("/reporting/scheduled", input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useUpdateScheduledReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: ScheduledReportInput & { id: string }) => {
      const { data } = await api.patch<ScheduledReport>(`/reporting/scheduled/${id}`, input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useDeleteScheduledReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ deleted: boolean }>(`/reporting/scheduled/${id}`);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/**
 * Send the last completed period now.
 *
 * Idempotent on the PERIOD, not on the button: pressing it twice for the same
 * month delivers one email, and the second answer says it was already sent.
 */
export function useRunScheduledReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{
        rows: number;
        emailStatus: string;
        periodKey: string;
        alreadyDelivered?: boolean;
      }>(`/reporting/scheduled/${id}/run`);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/**
 * Download the last completed period as a workbook.
 *
 * Through axios rather than a plain link: the API needs the bearer token, which
 * an `<a href>` cannot carry. `responseType: "blob"` matters too — without it
 * the XLSX bytes are read as text and the saved file will not open.
 */
export function useDownloadScheduledReport() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.get<Blob>(`/reporting/scheduled/${id}/download.xlsx`, {
        responseType: "blob",
      });
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? "report.xlsx";
      const rows = Number(res.headers?.["x-export-rows"] ?? 0);

      const url = URL.createObjectURL(res.data);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      return { filename, rows };
    },
  });
}

/** What a run outcome means, in words somebody can act on. */
export function describeDelivery(run: {
  emailStatus: string;
  emailDetail: string | null;
}): string {
  switch (run.emailStatus) {
    case "sent":
      return run.emailDetail ?? "Sent";
    case "dry_run":
      return "Built, but email is not configured on this server";
    case "no_recipients":
      return "Built. Nobody is configured to receive it";
    case "failed":
      return run.emailDetail ?? "The mail server refused it";
    default:
      return run.emailStatus;
  }
}
