"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Metal } from "@/lib/mock/catalogue";
import type { AgingBucket, StockItem } from "@/lib/mock/inventory";

export interface CreateStockInput {
  storeId: string;
  sku: string;
  name?: string;
  metal: Metal;
  karat?: number;
  grossWeight?: number;
  netWeight?: number;
  pureWeight?: number;
  /** Number of diamonds on the piece. */
  diamondPieces?: number;
  diamondWeightCt?: number;
  stoneWeightCt?: number;
  mrp?: number;
  tagPrice?: number;
  huid?: string;
  hallmarkNo?: string;
  certificateNo?: string;
  // No imageUrl — a piece's photo is Gati-sourced (synced), not set from the website.
  productId?: string;
}

/**
 * Raw StockStatus enum (schema/`StockStatus`), distinct from the humanized
 * label the list endpoint renders on `StockItem.status`.
 */
export type StockStatusValue =
  | "in_stock"
  | "aging"
  | "dead_stock"
  | "reserved"
  | "sold"
  | "melted"
  | "transferred";

/**
 * The mandatory "Adjust status" reasons (client requirement). Each reason maps
 * server-side to the StockStatus the piece moves to — see the backend
 * ADJUST_REASON_TO_STATUS. The label is what the user picks; the value is what
 * PATCH /stock/:id expects.
 */
export type AdjustReason =
  | "sold"
  | "reserved"
  | "damaged"
  | "lost"
  | "melting"
  | "vendor_return"
  | "repair";

export const ADJUST_REASON_OPTIONS: { value: AdjustReason; label: string }[] = [
  { value: "sold", label: "Sold" },
  { value: "reserved", label: "Reserved" },
  { value: "damaged", label: "Damaged" },
  { value: "lost", label: "Lost" },
  { value: "melting", label: "Sent for melting" },
  { value: "vendor_return", label: "Returned to vendor" },
  { value: "repair", label: "Repair" },
];

/**
 * PATCH /stock/:id — "Adjust status" for one piece. A reason is MANDATORY and
 * determines the resulting status. Moving a piece between stores is NOT done
 * here — that's the Stock Transfer workflow — so there is no storeId.
 */
export interface AdjustStockInput {
  id: string;
  reason: AdjustReason;
  note?: string;
}

/** POST /stock/bulk-adjust — one reason applied to many pieces at once. */
export interface BulkAdjustInput {
  ids: string[];
  reason: AdjustReason;
  note?: string;
}

/** One parsed spreadsheet row for POST /stock/bulk-import (store set per-batch). */
export interface ImportStockRow {
  sku: string;
  metal: Metal;
  name?: string;
  karat?: number;
  grossWeight?: number;
  netWeight?: number;
  diamondPieces?: number;
  diamondWeightCt?: number;
  tagPrice?: number;
  huid?: string;
  hallmarkNo?: string;
  certificateNo?: string;
}

export interface BulkImportInput {
  storeId: string;
  rows: ImportStockRow[];
}

export interface BulkImportResult {
  imported: number;
  errors: { row: number; sku: string; error: string }[];
}

/** Paginated envelope returned by list endpoints when page params are sent. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StockListParams {
  /** 1-based page index — always sent so the API returns the envelope. */
  page: number;
  pageSize: number;
  /** Free-text search over SKU / name (server-side, whole set). */
  q?: string;
  /** ProductCategory enum key (necklace, ring, …). */
  category?: string;
  /** MetalKind enum key (gold_22k, …) — the purity facet. */
  metal?: string;
  /** Optional server-side status filter (reflected in `total`). */
  status?: string;
  /** Store id facet — only sent for multi-store roles. */
  storeId?: string;
  /** Age bucket key: 0-30 | 31-90 | 91-180 | 181-365 | 365+. */
  ageBucket?: string;
}

/**
 * GET /stock — store-scoped stock ledger (aging, status, tag price),
 * server-paginated. Page + pageSize are always sent, which makes the
 * response the `{ items, total, page, pageSize }` envelope.
 */
export function useStock(params: StockListParams) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["stock", storeId, params],
    queryFn: async () => {
      // Drop empty filters so we don't send `?q=&category=` (which the API would
      // treat as a real, match-nothing filter).
      const clean = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== "" && v != null),
      );
      const { data } = await api.get<Paginated<StockItem>>("/stock", {
        params: clean,
      });
      return data;
    },
    // Keep the previous page on screen while the next one loads.
    placeholderData: (prev) => prev,
  });
}

/** Per-store slice of the stock value/pieces (populated only on "All Stores"). */
export interface StoreBreakdown {
  storeId: string;
  storeName: string;
  pieces: number;
  value: number;
}

/** Live, store-scoped aging distribution + KPI cards (whole set). */
export interface StockSummary {
  aging: AgingBucket[];
  deadStock: number;
  totalItems: number;
  /** KPI cards — computed server-side over the whole store-scoped set. */
  totalPieces: number;
  /** Sum of gross grams across gold pieces. */
  totalGoldGrams: number;
  /** Value at today's per-karat rate (tag price when set, else weight × rate). */
  totalStockValue: number;
  /** Per-store split — non-empty only when more than one store is in scope. */
  byStore: StoreBreakdown[];
}

/**
 * GET /stock/summary — store-scoped aging buckets + KPI totals computed over the
 * ENTIRE matching set server-side, so the aging chart and the dead-stock card
 * agree (neither is a per-page count nor mock data).
 */
export function useStockSummary() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["stock-summary", storeId],
    queryFn: async () => {
      const { data } = await api.get<StockSummary>("/stock/summary");
      return data;
    },
  });
}

/** POST /stock — add a physical piece to inventory against a concrete store. */
export function useCreateStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStockInput) => {
      const { data } = await api.post<StockItem>("/stock", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
    },
  });
}

/**
 * PATCH /stock/:id — "Adjust status" for one piece. A mandatory reason drives
 * the new status; an optional note is recorded in the audit trail. Invalidates
 * the ledger so the row reflects the new status (or drops out when moved to a
 * non-ledger status like sold/melted).
 */
export function useAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason, note }: AdjustStockInput) => {
      const { data } = await api.patch<StockItem>(`/stock/${id}`, {
        reason,
        note,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
    },
  });
}

/** POST /stock/bulk-adjust — apply one reason/status to many pieces at once. */
export function useBulkAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkAdjustInput) => {
      const { data } = await api.post<{
        updated: number;
        status: string;
        reason: string;
      }>("/stock/bulk-adjust", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
    },
  });
}

/** POST /stock/bulk-import — add many parsed rows to one concrete store. */
export function useBulkImportStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkImportInput) => {
      const { data } = await api.post<BulkImportResult>(
        "/stock/bulk-import",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
    },
  });
}
