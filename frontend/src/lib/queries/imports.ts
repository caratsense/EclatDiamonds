"use client";

import type { AxiosRequestConfig } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The file-import pipeline (Phase A7, surfaced in A11).
 *
 * The server holds no cross-request state, so the SAME file is posted at each
 * step: discover → preview → run. That is a deliberate backend choice — a
 * half-finished import cannot be left stranded in a server-side session — and
 * the UI has to keep the `File` object around to honour it.
 *
 * Connector/reconciliation reads live in `tenant-config.ts` alongside the rest
 * of the integrations surface; only the upload steps are here.
 */

export interface CanonicalField {
  field: string;
  label: string;
  required?: boolean;
  recommended?: boolean;
  description?: string;
}

export interface DiscoverResult {
  entity: string;
  rowCount: number;
  columns: { name: string; samples: string[] }[];
  canonicalFields: CanonicalField[];
  suggestions: { sourceColumn: string; canonicalField: string }[];
  /** Required fields no column was matched to. The import will fail without these. */
  missingRequired: string[];
}

export interface PreviewRow {
  row: number;
  status: "valid" | "warning" | "error";
  value: Record<string, unknown> | null;
  issues: { field?: string; message: string }[];
}

export interface PreviewResult {
  entity: string;
  total: number;
  valid: number;
  warning: number;
  error: number;
  sampleRows: PreviewRow[];
}

export interface RunResult {
  batchId: string;
  entity: string;
  sourceSystem: string;
  counts: {
    discovered: number;
    imported: number;
    updated: number;
    skipped: number;
    failed: number;
    duplicate: number;
  };
  issues: { row: number; reason: string }[];
}

export interface ImportBatch {
  id: string;
  sourceSystem: string;
  entity: string;
  fileName: string | null;
  status: string;
  discovered: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  duplicate: number;
  createdAt: string;
}

export interface FieldMapping {
  sourceColumn: string;
  canonicalField: string;
}

/**
 * `spreadsheet` lets the server infer CSV/XLSX from the file. Tally and BUSY
 * mean a user-generated export, not a live vendor connection.
 */
/**
 * Where an uploaded file came from, kept identical to the backend's own union.
 *
 * The backend offers a file-upload fallback for EVERY connector whose adapter
 * cannot be pulled — `'tally' | 'busy' | 'gati' | 'odbc'` in
 * connector-runtime.service.ts — and this list stopped at two. So a tenant whose
 * Gati or ODBC connector fell back to a file had that source silently fail to
 * match any option, and the import lost the source name the fallback exists to
 * preserve.
 */
export type FileImportOrigin =
  | "spreadsheet"
  | "tally"
  | "busy"
  | "gati"
  | "odbc";

/**
 * Build the multipart body. `mappings` goes over the wire as a JSON string
 * because a multipart field cannot carry structured data — the controller
 * parses it back with an explicit error if it is not valid JSON.
 */
function form(
  file: File,
  mappings?: FieldMapping[],
  storeId?: string,
  sourceSystem?: Exclude<FileImportOrigin, "spreadsheet">,
): FormData {
  const fd = new FormData();
  fd.append("file", file);
  if (mappings) fd.append("mappings", JSON.stringify(mappings));
  if (storeId) fd.append("storeId", storeId);
  if (sourceSystem) fd.append("sourceSystem", sourceSystem);
  return fd;
}

/**
 * Upload config — NOT optional, and the reason is worth stating.
 *
 * The shared axios instance defaults to `Content-Type: application/json`. Axios
 * treats that as an instruction to serialise a FormData body *as JSON*, which
 * silently drops the file and sends `{}` — the request succeeds, the server
 * reports "No file uploaded", and nothing in the stack says why. Clearing the
 * header lets the browser set `multipart/form-data` with its boundary, and the
 * identity `transformRequest` guarantees the body is passed through untouched.
 */
const UPLOAD: AxiosRequestConfig = {
  headers: { "Content-Type": undefined },
  transformRequest: [(d) => d],
};

/** Step 1 — what columns does this file have, and what do they look like? */
export function useDiscoverImport() {
  return useMutation({
    mutationFn: async (input: { entity: string; file: File }) =>
      (await api.post<DiscoverResult>(`/imports/${input.entity}/discover`, form(input.file), UPLOAD)).data,
  });
}

/** Step 2 — dry run. Validates every row and writes nothing. */
export function usePreviewImport() {
  return useMutation({
    mutationFn: async (input: { entity: string; file: File; mappings: FieldMapping[] }) =>
      (
        await api.post<PreviewResult>(
          `/imports/${input.entity}/preview`,
          form(input.file, input.mappings),
          UPLOAD,
        )
      ).data,
  });
}

/** Step 3 — the real import. Idempotent and provenance-tracked server-side. */
export function useRunImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      entity: string;
      file: File;
      mappings: FieldMapping[];
      storeId?: string;
      sourceSystem?: Exclude<FileImportOrigin, "spreadsheet">;
    }) =>
      (
        await api.post<RunResult>(
          `/imports/${input.entity}/run`,
          form(input.file, input.mappings, input.storeId, input.sourceSystem),
          UPLOAD,
        )
      ).data,
    onSuccess: () => {
      // The import changes customers/products/stores, so anything reading them
      // is now stale. Broad invalidation is correct here: an import is rare and
      // touches more of the app than any one query key describes.
      void qc.invalidateQueries();
    },
  });
}

export function useImportHistory() {
  return useQuery({
    queryKey: ["imports", "history"],
    queryFn: async () => (await api.get<ImportBatch[]>("/imports")).data,
  });
}

/**
 * Download the starter spreadsheet for an entity. Fetched through the API client
 * rather than a bare link so the Authorization header is attached — the endpoint
 * is behind the same guard as everything else.
 */
export async function downloadTemplate(entity: string): Promise<void> {
  const res = await api.get<string>(`/imports/${entity}/template`, {
    responseType: "text",
  });
  const url = URL.createObjectURL(new Blob([res.data], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `caratos-${entity}-template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** What this source has actually delivered — watermarks for a push source. */
export interface SourceDiscovery {
  sourceSystem: string;
  intakeMode: "pull" | "push" | "file_upload";
  reachable: boolean;
  note: string;
  blocked?: boolean;
  blockedReason?: string;
  watermarks?: {
    sourceTable: string;
    storeId: string | null;
    lastLegacyId: string | null;
    lastUpdatedAt: string | null;
    lastRunAt: string | null;
    rowsSynced: number;
  }[];
  provenance?: Record<string, { fromCustomer: number; local: number }>;
  entities?: string[];
  recentBatches?: ImportBatch[];
}

export function useSourceDiscovery(sourceSystem: string | null) {
  return useQuery({
    queryKey: ["connectors", "discover", sourceSystem],
    enabled: !!sourceSystem,
    queryFn: async () =>
      (await api.get<SourceDiscovery>(`/integration/connectors/discover/${sourceSystem}`)).data,
  });
}
