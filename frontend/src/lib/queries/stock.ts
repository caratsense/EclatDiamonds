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
