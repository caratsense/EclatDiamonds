"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Kpi, StoreCompare, TrendPoint } from "@/lib/mock/dashboards";

export interface DashboardCharts {
  salesTrend: TrendPoint[];
  storeComparison: StoreCompare[];
}

/** A collaboration task surfaced on the departmental dashboard. */
export interface DashboardTask {
  id: string;
  title: string;
  detail?: string;
  assignee?: string;
  dueDate?: string;
  storeId?: string;
}

export interface CreateTaskInput {
  title: string;
  detail?: string;
  assignee?: string;
  dueDate?: string;
  storeId?: string;
}

/** GET /dashboard/kpis — store-scoped KPI snapshot. */
export function useKpis() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "kpis", storeId],
    queryFn: async () => {
      const { data } = await api.get<Kpi[]>("/dashboard/kpis");
      return data;
    },
  });
}

/** GET /dashboard/charts — sales trend + store comparison. */
export function useCharts() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "charts", storeId],
    queryFn: async () => {
      const { data } = await api.get<DashboardCharts>("/dashboard/charts");
      return data;
    },
  });
}

/** GET /dashboard/tasks — collaboration tasks, store-scoped. */
export function useTasks() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "tasks", storeId],
    queryFn: async () => {
      const { data } = await api.get<DashboardTask[]>("/dashboard/tasks");
      return data;
    },
  });
}

/** POST /dashboard/tasks — create a collaboration task. */
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTaskInput) => {
      const { data } = await api.post<DashboardTask>(
        "/dashboard/tasks",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "tasks"] });
    },
  });
}
