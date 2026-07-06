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

/** GET /stock — store-scoped stock ledger (aging, status, tag price). */
export function useStock() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["stock", storeId],
    queryFn: async () => {
      const { data } = await api.get<StockItem[]>("/stock");
      return data;
    },
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
