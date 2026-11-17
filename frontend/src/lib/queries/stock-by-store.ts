"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";

/**
 * Stock as each branch holds it.
 *
 * Four different facts the client's notes insist must not be merged: where a
 * piece CAME FROM (its data source), where it was first recorded, which store
 * holds it now, and where a transfer is sending it. This answers the third
 * and reports the first beside it — it never collapses them into one column.
 */

export const STOCK_SOURCES = ["gati", "website", "import", "manual"] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

export const STOCK_SOURCE_LABELS: Record<StockSource, string> = {
  gati: "Gati (APRS-SJEP)",
  website: "Website",
  import: "Imported file",
  manual: "Added here",
};

/** How much the branch's data can be trusted, from integration evidence. */
export type StoreDataState = "synced" | "no_data" | "unmapped_holding";

export interface StoreStockRow {
  storeId: string;
  storeName: string;
  inStock: number;
  reserved: number;
  everRecorded: number;
  sold: number;
  transferredOut: number;
  bySource: Record<StockSource, number>;
  dataState: StoreDataState;
  lastRecordAt: string | null;
}

export interface StoreStockResponse {
  rows: StoreStockRow[];
  totals: { inStock: number; reserved: number; unmapped: number };
  /** `scope` is "organisation" while the sync agent writes no per-store rows. */
  syncEvidence: { scope: string; lastRunAt: string | null; tables: number };
}

export function useStockByStore(source?: StockSource) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["stock", "by-store", storeId, source ?? "all"],
    queryFn: async () => {
      const params = source ? `?source=${source}` : "";
      return (await api.get<StoreStockResponse>(`/stock/by-store${params}`)).data;
    },
  });
}
