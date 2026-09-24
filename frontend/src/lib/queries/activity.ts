import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { DashboardPeriod } from "@/lib/queries/dashboard";

export type ActivityDocType =
  | "sale"
  | "purchase"
  | "branch_transfer"
  | "proforma"
  | "sale_return"
  | "purchase_return";

export interface ActivityDocument {
  id: string;
  docNo: string;
  docType: ActivityDocType;
  /** ISO timestamp — the document's own date, not when it was synced. */
  docDate: string;
  store: string;
  customer: string;
  amount: number;
  isCancelled: boolean;
}

export interface ActivityResponse {
  period: DashboardPeriod;
  from: string | null;
  /** One entry per day in the window, including the days nothing happened. */
  flow: { date: string; label: string; sales: number; bills: number }[];
  documents: ActivityDocument[];
  sold: { pieces: number; value: number; top: { name: string; pieces: number; value: number }[] };
  unsold: { pieces: number; value: number; buckets: { label: string; pieces: number; value: number }[] };
}

/**
 * GET /dashboard/activity — what happened in the window, not just how much.
 *
 * The tiles say how much. This is what you open when the next question is when,
 * which bills, and what is still sitting on the shelf.
 */
export function useActivity(period: DashboardPeriod = "month") {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "activity", storeId, period],
    queryFn: async () => {
      const { data } = await api.get<ActivityResponse>("/dashboard/activity", {
        params: { period },
      });
      return data;
    },
  });
}
