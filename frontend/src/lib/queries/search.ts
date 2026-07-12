"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";

/**
 * Global search — one query across everything synced from the legacy system
 * (customers, designs, stock, bills) plus native Eclat records (leads,
 * orders, quotes). The backend always returns all 7 groups in a fixed order,
 * each capped at 8 items, store-scoped via the normal X-Store-Id header.
 */

export type SearchGroupKey =
  | "customers"
  | "designs"
  | "stock"
  | "bills"
  | "leads"
  | "orders"
  | "quotes";

export interface SearchCustomerItem {
  id: string;
  name: string;
  phone?: string | null;
  storeId?: string | null;
}

export interface SearchDesignItem {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
  imageUrl?: string | null;
}

export interface SearchStockItem {
  id: string;
  sku: string;
  name?: string | null;
  category?: string | null;
  status?: string | null;
  grossGrams?: number | null;
  netGrams?: number | null;
  tagPrice?: number | null;
  storeId?: string | null;
}

export interface SearchBillItem {
  id: string;
  docNo: string;
  customerName?: string | null;
  totalAmount?: number | null;
  docDate?: string | null;
  storeId?: string | null;
}

export interface SearchLeadItem {
  id: string;
  ref: string;
  customerName?: string | null;
  phone?: string | null;
  stage?: string | null;
  storeId?: string | null;
}

export interface SearchOrderItem {
  id: string;
  ref: string;
  customerName?: string | null;
  item?: string | null;
  stage?: string | null;
  storeId?: string | null;
}

export interface SearchQuoteItem {
  id: string;
  ref: string;
  customerName?: string | null;
  grandTotal?: number | null;
  status?: string | null;
  storeId?: string | null;
}

export type SearchItem =
  | SearchCustomerItem
  | SearchDesignItem
  | SearchStockItem
  | SearchBillItem
  | SearchLeadItem
  | SearchOrderItem
  | SearchQuoteItem;

export interface SearchGroup {
  key: SearchGroupKey;
  label: string;
  total: number;
  items: SearchItem[];
}

export interface SearchResponse {
  q: string;
  groups: SearchGroup[];
}

/** Minimum query length the backend accepts. */
export const SEARCH_MIN_CHARS = 2;

/**
 * Debounce a fast-changing value (the search box text) so we only hit
 * GET /search once the user pauses typing.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * GET /search?q=… — grouped global search, keyed on the active store so a
 * store switch refetches automatically. Pass an already-debounced `q`.
 */
export function useGlobalSearch(q: string) {
  const storeId = useStoreKey();
  const query = q.trim();
  return useQuery({
    queryKey: ["search", storeId, query],
    queryFn: async () => {
      const { data } = await api.get<SearchResponse>("/search", {
        params: { q: query },
      });
      return data;
    },
    enabled: query.length >= SEARCH_MIN_CHARS,
    staleTime: 30_000,
    // Keep the previous result set on screen while the next keystroke's
    // query loads — the list must not flash empty mid-typing.
    placeholderData: (prev) => prev,
  });
}
