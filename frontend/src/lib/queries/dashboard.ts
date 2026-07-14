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

export type TaskStatus = "open" | "in_progress" | "done";

/** A collaboration task surfaced on the departmental dashboard. */
export interface DashboardTask {
  id: string;
  title: string;
  detail?: string;
  assignee?: string;
  dueDate?: string;
  storeId?: string;
  status?: TaskStatus;
}

export interface CreateTaskInput {
  title: string;
  detail?: string;
  assignee?: string;
  dueDate?: string;
  storeId?: string;
}

/** An item on today's consolidated agenda (GET /dashboard/agenda). */
export type AgendaType = "follow_up" | "task" | "checkin";

export interface AgendaItem {
  id: string;
  time?: string;
  title: string;
  type: AgendaType;
  href: string;
}

export type HandoffStatus = "open" | "accepted" | "done";

/** A cross-department hand-off (GET /dashboard/handoffs). */
export interface Handoff {
  id: string;
  storeId: string;
  fromDept: string;
  toDept: string;
  title: string;
  note?: string;
  status: HandoffStatus;
  createdByName: string;
  assignedTo?: string;
  createdAt: string;
}

export interface CreateHandoffInput {
  storeId?: string;
  fromDept: string;
  toDept: string;
  title: string;
  note?: string;
  assignedTo?: string;
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

/** PATCH /dashboard/tasks/:id — advance a task's status. */
export function useUpdateTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: TaskStatus;
    }) => {
      const { data } = await api.patch<DashboardTask>(
        `/dashboard/tasks/${id}`,
        { status },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "tasks"] });
    },
  });
}

/** GET /dashboard/agenda — consolidated to-do / calendar for today, store-scoped. */
export function useAgenda() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "agenda", storeId],
    queryFn: async () => {
      const { data } = await api.get<AgendaItem[]>("/dashboard/agenda");
      return data;
    },
  });
}

/** GET /dashboard/handoffs — cross-department hand-offs, store-scoped. */
export function useHandoffs() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "handoffs", storeId],
    queryFn: async () => {
      const { data } = await api.get<Handoff[]>("/dashboard/handoffs");
      return data;
    },
  });
}

/** POST /dashboard/handoffs — raise a new cross-department hand-off. */
export function useCreateHandoff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateHandoffInput) => {
      const { data } = await api.post<Handoff>(
        "/dashboard/handoffs",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "handoffs"] });
    },
  });
}

/** PATCH /dashboard/handoffs/:id — accept or mark a hand-off done. */
export function useUpdateHandoff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: HandoffStatus;
    }) => {
      const { data } = await api.patch<Handoff>(
        `/dashboard/handoffs/${id}`,
        { status },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "handoffs"] });
    },
  });
}
