"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Lead export.
 *
 * The count is fetched BEFORE the file is offered, so a manager sees "12,480
 * leads" and can narrow the range rather than waiting on a download that is then
 * refused for being over the limit. The server refuses rather than truncating —
 * a short spreadsheet is worse than none, because nobody can see what is missing.
 */

export interface LeadExportFilters {
  from?: string;
  to?: string;
  storeId?: string;
  ownerId?: string;
  source?: string;
  stage?: string;
  outcome?: string;
  tagIds?: string[];
  columns?: string[];
}

/** Drop empties and flatten arrays, so the query string carries only real filters. */
function toParams(f: LeadExportFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v.join(",");
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

export function useLeadExportCount(filters: LeadExportFilters, enabled = true) {
  return useQuery({
    queryKey: ["lead-export-count", filters],
    enabled,
    queryFn: async () => {
      const { data } = await api.get<{ rows: number }>("/crm/exports/leads/count", {
        params: toParams(filters),
      });
      return data.rows;
    },
  });
}

/**
 * Download the workbook.
 *
 * `responseType: "blob"` matters: without it the XLSX bytes are read as text and
 * the saved file will not open. The filename comes from the server's
 * Content-Disposition so the name a person sees matches the audit row.
 */
export function useDownloadLeadExport() {
  return useMutation({
    mutationFn: async (filters: LeadExportFilters) => {
      const res = await api.get<Blob>("/crm/exports/leads.xlsx", {
        params: toParams(filters),
        responseType: "blob",
      });

      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? "leads.xlsx";
      const rows = Number(res.headers?.["x-export-rows"] ?? 0);

      const url = URL.createObjectURL(res.data);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        // Revoked in a finally, so a click that throws does not leak the object.
        URL.revokeObjectURL(url);
      }
      return { filename, rows };
    },
  });
}
