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
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface DashboardTask {
  id: string;
  title: string;
  detail?: string;
  /** Display name. The only record of who was meant on pre-A11 tasks. */
  assignee?: string;
  /** The stable identity. Null on historical rows — fall back to `assignee`. */
  assigneeId?: string | null;
  assignedTo?: { id: string; name: string } | null;
  priority?: TaskPriority;
  dueDate?: string;
  completedAt?: string | null;
  storeId?: string | null;
  status?: TaskStatus;
  /** What the task is about, when it concerns a customer or a lead. */
  party?: { id: string; name: string } | null;
  lead?: { id: string; ref: string } | null;
}

export interface CreateTaskInput {
  title: string;
  detail?: string;
  /** Kept for compatibility; `assigneeId` is what the task is really assigned to. */
  assignee?: string;
  assigneeId?: string;
  priority?: TaskPriority;
  partyId?: string;
  leadId?: string;
  dueDate?: string;
  storeId?: string;
}

/** Server-side task filters. `mine` resolves to the caller — there is no id to pass. */
export interface TaskFilter {
  mine?: boolean;
  status?: TaskStatus;
  priority?: TaskPriority;
  partyId?: string;
  leadId?: string;
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

export type HandoffStatus = "open" | "accepted" | "done" | "closed";

/** A cross-department hand-off (GET /dashboard/handoffs). */
export interface Handoff {
  id: string;
  storeId: string;
  fromDept: string;
  toDept: string;
  title: string;
  note?: string;
  status: HandoffStatus;
  createdBy: string;
  createdById: string;
  assignedTo?: string;
  assignedToId: string | null;
  createdAt: string;
}

export interface CreateHandoffInput {
  storeId?: string;
  fromDept: string;
  toDept: string;
  title: string;
  note?: string;
  assignedTo?: string;
  assignedToId?: string;
}

/** A person a hand-off can be assigned to (GET /dashboard/assignable-users). */
export interface AssignableUser {
  id: string;
  name: string;
}

/** GET /dashboard/assignable-users — active staff in scope for the assignee picker. */
export function useAssignableUsers() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "assignable-users", storeId],
    queryFn: async () => {
      const { data } = await api.get<AssignableUser[]>(
        "/dashboard/assignable-users",
      );
      return data;
    },
  });
}

/**
 * How far back the dashboard looks. The tiles counted only today, so a shop
 * whose history came from the old ERP saw crores on the twelve-month chart and
 * zero on every tile above it.
 */
export const DASHBOARD_PERIODS = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "month", label: "30 days" },
  { value: "quarter", label: "90 days" },
  { value: "year", label: "12 months" },
] as const;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]["value"];

/** GET /dashboard/kpis — store-scoped KPI snapshot over the chosen window. */
export function useKpis(period: DashboardPeriod = "today") {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "kpis", storeId, period],
    queryFn: async () => {
      const { data } = await api.get<Kpi[]>("/dashboard/kpis", { params: { period } });
      return data;
    },
  });
}

/** GET /dashboard/charts — sales trend + store comparison. */
export function useCharts(period: DashboardPeriod = "today") {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "charts", storeId, period],
    queryFn: async () => {
      const { data } = await api.get<DashboardCharts>("/dashboard/charts", {
        params: { period },
      });
      return data;
    },
  });
}

/** GET /dashboard/tasks — collaboration tasks, store-scoped. */
export function useTasks(filter: TaskFilter = {}) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["dashboard", "tasks", storeId, filter],
    queryFn: async () => {
      const { data } = await api.get<DashboardTask[]>("/dashboard/tasks", {
        params: {
          // Sent as a flag, never as a user id: the server resolves "mine" to
          // the authenticated caller, so one user cannot request another's list.
          mine: filter.mine ? "true" : undefined,
          status: filter.status,
          priority: filter.priority,
          partyId: filter.partyId,
          leadId: filter.leadId,
        },
      });
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
      /*
       * The calling queue reads the SAME Task rows through a different endpoint,
       * so closing one here has to refresh there too. It did not: marking a
       * follow-up done from the floor app left the four KPI cards showing the
       * old counts, and the row still sitting in the list, until something else
       * happened to refetch.
       */
      qc.invalidateQueries({ queryKey: ["calling"] });
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
