"use client";

import axios from "axios";
import { useQuery } from "@tanstack/react-query";

import { api, getStoredToken } from "@/lib/api";
import type { DashboardCharts } from "@/lib/queries/dashboard";
import type { StoreCompare } from "@/lib/mock/dashboards";

export type { StoreCompare } from "@/lib/mock/dashboards";

/**
 * All-stores comparison feed for the Store Comparison page (area/HO only).
 *
 * Reuses the dashboard's exact data source — GET /dashboard/charts →
 * `storeComparison` (per-store revenue) — but ALWAYS reads the pan-India
 * aggregate, independent of the topbar store selector. This is an explicit
 * cross-store view, so the query key is intentionally NOT scoped to the active
 * store (switching stores must not change or refetch these figures).
 *
 * Why bypass the shared `api` instance? Its request interceptor unconditionally
 * rewrites X-Store-Id from the persisted active store, so a single-store
 * selection would otherwise collapse the comparison down to one row. We issue
 * the request directly with X-Store-Id: "all" (the backend's aggregate
 * sentinel — see StoreScopeService.effectiveStoreIds), reusing the same base
 * URL + bearer token. The (app) SessionGate already guarantees a valid token
 * before this page renders, so the shared 401 interceptor is not needed here.
 */
export function useStoreComparison() {
  return useQuery({
    queryKey: ["dashboard", "charts", "all-stores"],
    queryFn: async (): Promise<StoreCompare[]> => {
      const token = getStoredToken();
      const { data } = await axios.get<DashboardCharts>("/dashboard/charts", {
        baseURL: api.defaults.baseURL,
        timeout: 15000,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Store-Id": "all",
        },
      });
      return data.storeComparison;
    },
  });
}
