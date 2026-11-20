"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AxiosError } from "axios";

import { api } from "@/lib/api";
import type {
  ChecklistStatus,
  DepartmentKey,
  MilestoneMarker,
  MilestoneState,
} from "@/lib/mock/new-store";

/**
 * Module 11 — Departmental Setup for New Stores.
 * Live hook against `GET /new-store/projects` (area-manager / head-office only;
 * lower roles get a 403 which we surface as a permission state, not an error).
 *
 * The new-store programme is NOT store-scoped (the store does not exist yet),
 * so this query is not keyed on the active store. The backend returns a reduced
 * project shape (new-store.service.ts): checklist tasks carry no `dependsOn`;
 * vendors carry no `contact`/`amount`/`department`; `budget`/`spent` default to
 * 0. The page handles those gracefully.
 */

const NEW_STORE_KEY = "new-store";

export interface ApiChecklistTask {
  id: string;
  label: string;
  status: ChecklistStatus;
}

export interface ApiDepartmentChecklist {
  key: DepartmentKey;
  tasks: ApiChecklistTask[];
}

export interface ApiMilestone {
  marker: MilestoneMarker;
  date: string;
  title: string;
  summary: string;
  state: MilestoneState;
}

export interface ApiVendor {
  id: string;
  task: string;
  vendor: string;
  /** Contracted amount (₹); null when not captured. */
  amount: number | null;
  dueDate: string;
  /** Free-text lifecycle status from the API (e.g. pending, paid, completed). */
  status: string;
}

export interface ApiNewStoreProject {
  id: string;
  name: string;
  city: string;
  launchDate: string;
  overallProgress: number;
  budget: number;
  spent: number;
  leadName: string;
  checklists: ApiDepartmentChecklist[];
  milestones: ApiMilestone[];
  vendors: ApiVendor[];
}

/**
 * GET /new-store/projects — store-launch projects with checklists, milestones,
 * vendors. Returns `{ projects, forbidden }`: `forbidden` is true when the
 * caller's role (salesperson / store_manager) is below area_manager and the
 * API responds 403 — the page renders a permission state in that case.
 */
export function useNewStoreProjects() {
  return useQuery({
    queryKey: [NEW_STORE_KEY, "projects"],
    queryFn: async () => {
      try {
        const { data } = await api.get<ApiNewStoreProject[]>(
          "/new-store/projects",
        );
        return { projects: data, forbidden: false };
      } catch (err) {
        if (err instanceof AxiosError && err.response?.status === 403) {
          return { projects: [] as ApiNewStoreProject[], forbidden: true };
        }
        throw err;
      }
    },
    retry: false,
  });
}

export interface CreateProjectInput {
  name: string;
  city: string;
  launchDate?: string;
  leadName?: string;
}

/** POST /new-store/projects — create a new store-launch project. */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const { data } = await api.post<ApiNewStoreProject>(
        "/new-store/projects",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [NEW_STORE_KEY, "projects"] });
    },
  });
}

/**
 * Every mutation below returns the full, freshly-recomputed project view
 * (readiness / budget / spent), so we simply invalidate the projects query
 * to re-render the whole page from the source of truth.
 */
function useProjectsInvalidation() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [NEW_STORE_KEY, "projects"] });
}

export interface AddChecklistItemInput {
  projectId: string;
  title: string;
  dept?: DepartmentKey;
  status?: ChecklistStatus;
}

/** POST /new-store/projects/:id/checklist — add a checklist task. */
export function useAddChecklistItem() {
  const invalidate = useProjectsInvalidation();
  return useMutation({
    mutationFn: async ({ projectId, ...body }: AddChecklistItemInput) => {
      const { data } = await api.post<ApiNewStoreProject>(
        `/new-store/projects/${projectId}/checklist`,
        body,
      );
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

/** PATCH /new-store/checklist/:id — advance a checklist task's status/title. */
export function useUpdateChecklistItem() {
  const invalidate = useProjectsInvalidation();
  return useMutation({
    mutationFn: async ({
      id,
      status,
      title,
    }: {
      id: string;
      status?: ChecklistStatus;
      title?: string;
    }) => {
      const { data } = await api.patch<ApiNewStoreProject>(
        `/new-store/checklist/${id}`,
        { status, title },
      );
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

export interface AddMilestoneInput {
  projectId: string;
  title: string;
  dueDate: string;
  phase?: string;
  summary?: string;
}

/** POST /new-store/projects/:id/milestones — add a launch milestone. */
export function useAddMilestone() {
  const invalidate = useProjectsInvalidation();
  return useMutation({
    mutationFn: async ({ projectId, ...body }: AddMilestoneInput) => {
      const { data } = await api.post<ApiNewStoreProject>(
        `/new-store/projects/${projectId}/milestones`,
        body,
      );
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

export interface AddVendorInput {
  projectId: string;
  name: string;
  scope: string;
  status?: string;
  amount?: number;
}

/** POST /new-store/projects/:id/vendors — add a vendor (with contracted amount). */
export function useAddVendor() {
  const invalidate = useProjectsInvalidation();
  return useMutation({
    mutationFn: async ({ projectId, ...body }: AddVendorInput) => {
      const { data } = await api.post<ApiNewStoreProject>(
        `/new-store/projects/${projectId}/vendors`,
        body,
      );
      return data;
    },
    onSuccess: () => invalidate(),
  });
}

/** PATCH /new-store/vendors/:id — update a vendor's status and/or amount. */
export function useUpdateVendor() {
  const invalidate = useProjectsInvalidation();
  return useMutation({
    mutationFn: async ({
      id,
      status,
      amount,
    }: {
      id: string;
      status?: string;
      amount?: number;
    }) => {
      const { data } = await api.patch<ApiNewStoreProject>(
        `/new-store/vendors/${id}`,
        { status, amount },
      );
      return data;
    },
    onSuccess: () => invalidate(),
  });
}
