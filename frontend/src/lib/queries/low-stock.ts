"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";

/**
 * Designs a branch has run short of.
 *
 * The same count the catalogue card shows — pieces on hand of standard
 * merchandise — compared against a reorder level: the organisation's default,
 * or the design's own. Computed on every read rather than served from the alert
 * table, so a piece inwarded an hour ago is no longer listed as missing.
 */

export interface LowStockRow {
  productId: string;
  sku: string;
  name: string;
  styleNumber: string | null;
  storeId: string;
  storeName: string;
  onHand: number;
  level: number;
  /** Whose number this is — the design's own override, or the tenant default. */
  levelSource: "design" | "default";
  /** Pieces at the other branches in view: a transfer rather than a reorder. */
  elsewhere: number;
  /** When the sweep first told somebody, or null if it has not yet. */
  alertedSince: string | null;
}

export interface LowStockList {
  defaultLevel: number;
  rows: LowStockRow[];
  /** Rows below the line in the whole scope, of which `rows` is the first page. */
  total: number;
  truncated: boolean;
}

const KEY = ["low-stock"] as const;

export function useLowStock(limit?: number) {
  // Keyed on the active store: switching branch in the topbar changes the
  // X-Store-Id header, and with it the answer.
  const storeKey = useStoreKey();
  return useQuery({
    queryKey: [...KEY, "list", storeKey, limit ?? null],
    queryFn: async () => {
      const { data } = await api.get<LowStockList>("/stock/low-stock", {
        params: limit ? { limit } : undefined,
      });
      return data;
    },
    staleTime: 60_000,
  });
}

/** The organisation's default level. Head office only, server-side. */
export function useSetLowStockDefault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (defaultLevel: number) => {
      const { data } = await api.put<{ defaultLevel: number }>("/stock/low-stock/settings", {
        defaultLevel,
      });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** One design's own level; null puts it back on the default. */
export function useSetReorderLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, level }: { productId: string; level: number | null }) => {
      const { data } = await api.put<{ productId: string; reorderLevel: number | null }>(
        `/stock/low-stock/level/${productId}`,
        { level },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
