"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { StockClass } from "@/lib/queries/dead-stock";

/**
 * Head office's catalogue photo archive.
 *
 * An export is a background job: requesting one returns at once as `pending`,
 * the list polls until it is `completed` or `failed`, and the download is a
 * separate, audited request. Limits refuse rather than trim, so a failed export
 * carries the reason — never a smaller archive that looks complete.
 */

export interface CatalogueExportFilters {
  storeId?: string;
  category?: string;
  /** Style Number or SKU. */
  code?: string;
  updatedFrom?: string;
  updatedTo?: string;
  availability?: "in_stock" | "lead_time";
  stockClass?: StockClass;
}

export interface SkippedPhoto {
  sku: string;
  productName: string;
  reason: "external" | "not_authorised" | "missing";
  detail: string;
}

export interface CatalogueExport {
  id: string;
  status: "pending" | "completed" | "failed";
  running: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requestedBy: { id: string; name: string } | null;
  filters: CatalogueExportFilters;
  emailRequested: boolean;
  error: string | null;
  archive: {
    filename: string;
    files: number;
    bytes: number;
    skippedCount: number;
    expiresAt: string;
    expired: boolean;
  } | null;
  /** Null when nobody asked for email. `dry_run` means nothing was sent. */
  email: { status: string; detail: string } | null;
  /** Only on the single-export read. */
  skipped?: SkippedPhoto[];
}

const KEY = ["catalogue-exports"] as const;

export function useCatalogueExports(enabled: boolean) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async () => {
      const { data } = await api.get<CatalogueExport[]>("/catalogue-exports");
      return data;
    },
    // Poll only while something is still in the queue.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((e) => e.status === "pending") ? 5_000 : false,
  });
}

export function useCatalogueExport(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await api.get<CatalogueExport>(`/catalogue-exports/${id}`);
      return data;
    },
  });
}

export function useCreateCatalogueExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CatalogueExportFilters & { emailMe?: boolean }) => {
      const { data } = await api.post<CatalogueExport>("/catalogue-exports", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** `responseType: "blob"` or the ZIP bytes are read as text and will not open. */
export function useDownloadCatalogueExport() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.get<Blob>(`/catalogue-exports/${id}/download`, {
        responseType: "blob",
        timeout: 30 * 60_000,
      });
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "catalogue-photos.zip";
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
