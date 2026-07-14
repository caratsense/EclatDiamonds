"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Metal } from "@/lib/mock/catalogue";
import type { StockItem } from "@/lib/mock/inventory";

export interface CreateStockInput {
  storeId: string;
  sku: string;
  name?: string;
  metal: Metal;
  karat?: number;
  grossWeight?: number;
  netWeight?: number;
  mrp?: number;
  tagPrice?: number;
  productId?: string;
}

/**
 * Raw StockStatus enum (schema/`StockStatus`), distinct from the humanized
 * label the list endpoint renders on `StockItem.status`. PATCH /stock/:id
 * expects these enum values.
 */
export type StockStatusValue =
  | "in_stock"
  | "aging"
  | "dead_stock"
  | "reserved"
  | "sold"
  | "melted"
  | "transferred";

/** Humanized labels for the status Select on the adjust dialog. */
export const STOCK_STATUS_LABELS: Record<StockStatusValue, string> = {
  in_stock: "In stock",
  aging: "Aging",
  dead_stock: "Dead stock",
  reserved: "Reserved",
  sold: "Sold",
  melted: "Melted",
  transferred: "Transferred",
};

/**
 * Reverse map from the humanized label the list returns back to the enum
 * value, so the adjust dialog can preselect the item's current status. Only
 * the four in-ledger statuses appear in lists (sold/melted/transferred are
 * filtered out server-side).
 */
export const STOCK_STATUS_VALUE_BY_LABEL: Record<string, StockStatusValue> = {
  "In stock": "in_stock",
  Aging: "aging",
  "Dead stock": "dead_stock",
  Reserved: "reserved",
};

export interface AdjustStockInput {
  id: string;
  /** New status (enum value). */
  status?: StockStatusValue;
  /** Destination store for a cross-store transfer (area_manager+). */
  storeId?: string;
  note?: string;
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
  /** Optional server-side status filter (reflected in `total`). */
  status?: string;
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
      const { data } = await api.get<Paginated<StockItem>>("/stock", {
        params,
      });
      return data;
    },
    // Keep the previous page on screen while the next one loads — page flips
    // must not flash the table empty (TanStack v5 keepPreviousData equivalent).
    placeholderData: (prev) => prev,
  });
}

/** POST /stock — add a physical piece to inventory against the active store. */
export function useCreateStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStockInput) => {
      const { data } = await api.post<StockItem>("/stock", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock"] });
    },
  });
}

/**
 * PATCH /stock/:id — change a piece's status and/or transfer it to another
 * store. A status-only change is store_manager+; supplying a different
 * `storeId` is a cross-store transfer the API gates to area_manager+.
 * Invalidates the ledger so the row reflects the new status (or drops out
 * when moved to a non-ledger status like sold/melted/transferred).
 */
export function useAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, storeId, note }: AdjustStockInput) => {
      const { data } = await api.patch<StockItem>(`/stock/${id}`, {
        status,
        storeId,
        note,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock"] });
    },
  });
}
