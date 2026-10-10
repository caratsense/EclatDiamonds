"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * STORE-level sales commission (client 9 Oct item 13):
 *
 *   commission = max(0, qualifying monthly sales − threshold) × rate
 *
 * Threshold + rate are a per-store CommissionPlan set by head office (like
 * discount limits); the monthly summary is store_manager+ and store-scoped.
 * Strictly separate from the per-staff /hrms/commission incentive rows and
 * from the customer referral credit (Module 17).
 */

const COMMISSIONS_KEY = "commissions";

export interface CommissionPlanView {
  id: string;
  storeId: string;
  storeName: string;
  /** Monthly qualifying-sales threshold (INR). */
  threshold: number;
  /** Percent paid on the excess above the threshold (1 = 1%). */
  ratePercent: number;
  isActive: boolean;
}

export interface StoreCommissionRow {
  storeId: string;
  storeName: string;
  /** "YYYY-MM" — the calendar month at the store's timezone. */
  month: string;
  timezone: string;
  plan: CommissionPlanView | null;
  /** Billed sales for the month (non-cancelled 'sale' docs). */
  sales: number;
  /** Billed sale returns for the month (non-cancelled 'sale_return' docs). */
  returns: number;
  /** sales − returns. */
  qualifyingSales: number;
  /** max(0, qualifying − threshold); null when no active plan. */
  excess: number | null;
  /** excess × rate; null when no active plan. */
  commission: number | null;
}

export interface UpsertCommissionPlanInput {
  storeId: string;
  threshold: number;
  ratePercent: number;
  isActive?: boolean;
}

/** GET /commissions/summary?month — per-store breakdown (store_manager+). */
export function useCommissionSummary(month: string) {
  const storeId = useStoreKey();
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  return useQuery({
    queryKey: [COMMISSIONS_KEY, "summary", storeId, month],
    enabled: canView && !!month,
    queryFn: async () => {
      const { data } = await api.get<{ items: StoreCommissionRow[] }>(
        "/commissions/summary",
        { params: { month } },
      );
      return data.items;
    },
  });
}

/** PUT /commissions/plans — upsert a store's threshold + rate (head office only). */
export function useUpsertCommissionPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertCommissionPlanInput) => {
      const { data } = await api.put<CommissionPlanView>(
        "/commissions/plans",
        input,
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [COMMISSIONS_KEY] }),
  });
}
