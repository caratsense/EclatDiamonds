"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * When a piece counts as dead, and which piece is which.
 *
 * The threshold is the tenant's, per category. A chain moves in weeks and a
 * bridal set is expected to sit — one number across both produces a figure that
 * either alarms about normal inventory or says nothing, and either way nobody
 * acts on it.
 */

export const STOCK_CATEGORIES = [
  "necklace",
  "ring",
  "earrings",
  "bangle",
  "bracelet",
  "pendant",
  "chain",
  "other",
] as const;

export type StockCategory = (typeof STOCK_CATEGORIES)[number];

export interface DeadStockRule {
  /** Null is the tenant default — everything without its own rule. */
  category: StockCategory | null;
  thresholdDays: number;
  warnAfterDays: number | null;
}

export interface DeadStockPolicy {
  rules: DeadStockRule[];
  defaultThresholdDays: number;
  defaultWarnAfterDays: number | null;
  /** True when nothing is configured and the platform default (180) applies. */
  usingPlatformDefault: boolean;
}

/** Block 9 — what kind of stock a design or piece is. */
export type StockClass = "standard" | "customised" | "non_stock";

export const STOCK_CLASS_OPTIONS: { value: StockClass; label: string }[] = [
  { value: "standard", label: "Standard stock" },
  { value: "customised", label: "Customised / made to order" },
  { value: "non_stock", label: "Non-stock (display / sample)" },
];

export type DeadStockView = "stock" | "customised" | "remake" | "excluded" | "all";
export type DeadStockState = "dead" | "ageing" | "all";
export type DeadStockSuggestion = "sell" | "remake" | "contact_customer";

export const SUGGESTION_LABEL: Record<DeadStockSuggestion, string> = {
  sell: "Sell / promote",
  remake: "Remake or customise",
  contact_customer: "Contact the customer",
};

export interface DeadStockItem {
  id: string;
  sku: string;
  vin: string | null;
  /** The design; null when the piece is not linked to one (no photos). */
  productId: string | null;
  styleNumber: string | null;
  name: string;
  category: string;
  storeId: string;
  storeName: string;
  ageDays: number;
  thresholdDays: number;
  warnAfterDays: number | null;
  /** How far past the line — the right sort for working a list worst-first. */
  daysOver: number;
  state: "dead" | "ageing" | "fresh";
  tagPrice: number;
  stockClass: StockClass;
  /** "design" when the piece has no classification of its own and inherits one. */
  stockClassSource: "piece" | "design";
  remakeSuitable: boolean;
  /** Null for display pieces and fresh ones. Never "sell" for a customised piece. */
  suggestion: DeadStockSuggestion | null;
}

export interface DeadStockList {
  view: DeadStockView;
  items: DeadStockItem[];
  dead: number;
  ageing: number;
  value: number;
  /** Rows in the whole view, of which `items` is the worst-first page. */
  total: number;
  /** True when the cap was hit: there are more than this list is showing. */
  truncated: boolean;
  /** Dead pieces per view, returned whichever view is open. */
  buckets: { stock: number; customised: number; remake: number; excluded: number };
}

const KEY = ["dead-stock"] as const;

export function useDeadStockPolicy() {
  return useQuery({
    queryKey: [...KEY, "policy"],
    queryFn: async () => {
      const { data } = await api.get<DeadStockPolicy>("/stock/dead/policy");
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSetDeadStockRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      category?: string | null;
      thresholdDays: number;
      warnAfterDays?: number | null;
    }) => {
      const { data } = await api.put<DeadStockPolicy>("/stock/dead/policy", input);
      return data;
    },
    onSuccess: () => {
      // The threshold changes what the summary's dead-stock figure MEANS, so the
      // KPI card has to be refetched with the list.
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["stock"] });
    },
  });
}

export function useClearDeadStockRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (category: string) => {
      const { data } = await api.delete<DeadStockPolicy>(
        `/stock/dead/policy/${category || "default"}`,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["stock"] });
    },
  });
}

export interface DeadStockFilters {
  storeId?: string;
  category?: string;
  state?: DeadStockState;
  view?: DeadStockView;
  limit?: number;
}

export function useDeadStock(filters: DeadStockFilters = {}) {
  return useQuery({
    queryKey: [...KEY, "list", filters],
    queryFn: async () => {
      const { data } = await api.get<DeadStockList>("/stock/dead", { params: filters });
      return data;
    },
    staleTime: 60_000,
  });
}

/** Classify one piece, or mark it worth remaking. `stockClass: null` = follow its design. */
export function useClassifyPiece() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      stockClass?: StockClass | null;
      remakeSuitable?: boolean;
    }) => {
      const { data } = await api.patch<{
        id: string;
        stockClass: StockClass;
        stockClassSource: "piece" | "design";
        remakeSuitable: boolean;
      }>(`/stock/dead/classification/piece/${id}`, body);
      return data;
    },
    onSuccess: () => {
      // Classification moves a piece between views AND in or out of the
      // summary's dead figure and the catalogue's "on the shelf" count.
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["stock"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

/**
 * The current view as a workbook. `responseType: "blob"` or the bytes are read
 * as text and the file will not open.
 */
export function useDownloadDeadStockExport() {
  return useMutation({
    mutationFn: async (filters: Omit<DeadStockFilters, "limit">) => {
      const res = await api.get<Blob>("/stock/dead/export.xlsx", {
        params: filters,
        responseType: "blob",
        timeout: 120_000,
      });
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "dead-stock.xlsx";
      const url = URL.createObjectURL(res.data);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      const rows = res.headers?.["x-export-rows"];
      return { filename, rows: rows == null ? null : Number(rows) };
    },
  });
}

/* ------------------------------------------------------------------------- */

export interface VinLookupHit {
  found: true;
  id: string;
  vin: string;
  sku: string;
  name: string;
  styleNumber: string | null;
  status: string;
  storeId: string;
  store: { name: string } | null;
  ageDays: number;
  tagPrice: number;
  huid: string | null;
  product: { id: string; name: string; styleNumber: string | null; imageUrl: string | null } | null;
  /** False when the piece belongs to a branch outside the viewer's scope. */
  inScope: boolean;
}

export type VinLookup = VinLookupHit | { found: false; vin: string };

/** Find a piece by the number on its tag. */
export function useVinLookup(vin: string) {
  return useQuery({
    queryKey: ["vin", vin],
    enabled: vin.trim().length >= 4,
    queryFn: async () => {
      const { data } = await api.get<VinLookup>(`/stock/vin/${encodeURIComponent(vin.trim())}`);
      return data;
    },
    staleTime: 30_000,
  });
}

export function useIssueVin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (stockItemId: string) => {
      const { data } = await api.post<{ vin: string; issued: boolean }>(
        `/stock/vin/issue/${stockItemId}`,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["stock"] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** Issue one for every piece in scope that has none. Bounded; says what is left. */
export function useIssueMissingVins() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { storeId?: string; limit?: number } = {}) => {
      const { data } = await api.post<{ issued: number; remaining: number; examined: number }>(
        "/stock/vin/issue-missing",
        input,
        { timeout: 120_000 },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["stock"] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
