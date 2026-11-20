"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useSession } from "@/store/use-session";
import type {
  AgencyTask,
  Campaign,
  CampaignStatus,
  CampaignType,
  SharedAsset,
} from "@/lib/mock/marketing";

/**
 * Module 16 — Marketing Management.
 * Campaigns are store-scoped via their target-store join; assets and agency
 * tasks hang off in-scope campaigns. The backend returns campaign `channels`
 * as an empty array (not yet modelled) — the UI renders that gracefully.
 *
 * Every query is keyed on the active store id for store-switcher refetch.
 */

export const marketingKeys = {
  all: ["marketing"] as const,
  campaigns: (storeId: string) => ["marketing", "campaigns", storeId] as const,
  assets: (storeId: string) => ["marketing", "assets", storeId] as const,
  agencyTasks: (storeId: string) =>
    ["marketing", "agency-tasks", storeId] as const,
};

/** GET /marketing/campaigns — planner rows, store-scoped via targets. */
export function useCampaigns() {
  const storeId = useSession((s) => s.currentStore.id);
  return useQuery({
    queryKey: marketingKeys.campaigns(storeId),
    queryFn: async () => {
      const { data } = await api.get<Campaign[]>("/marketing/campaigns");
      return data;
    },
  });
}

export interface CreateCampaignInput {
  name: string;
  type: CampaignType;
  status?: CampaignStatus;
  startDate?: string;
  endDate?: string;
  budget?: number;
  ownerName?: string;
  agency?: string;
  /** Target store ids (in the creator's scope); omit for pan-India. */
  storeIds?: string[];
  /** Delivery channels (Instagram, WhatsApp, Email, …). */
  channels?: string[];
}

/** POST /marketing/campaigns — create a campaign (planner row). */
export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCampaignInput) => {
      const { data } = await api.post<Campaign>(
        "/marketing/campaigns",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: marketingKeys.all });
    },
  });
}

/** Raw deliverable/asset lifecycle statuses (assets + agency tasks share one table). */
export type AssetStatus =
  | "pending"
  | "in_progress"
  | "submitted"
  | "approved"
  | "changes_requested"
  | "rejected";

export interface CreateAssetInput {
  campaignId: string;
  title: string;
  type: string;
  url?: string;
}

/** POST /marketing/assets — add an agency deliverable to a campaign (store_manager+). */
export function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAssetInput) => {
      const { data } = await api.post("/marketing/assets", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: marketingKeys.all });
    },
  });
}

/** PATCH /marketing/assets/:id — approve / request changes / reject (area_manager+). */
export function useUpdateAssetStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: AssetStatus;
    }) => {
      const { data } = await api.patch(`/marketing/assets/${id}`, { status });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: marketingKeys.all });
    },
  });
}

export interface CreateAgencyTaskInput {
  campaignId: string;
  title: string;
  assignee?: string;
  dueDate?: string;
}

/** POST /marketing/agency-tasks — create a campaign task (store_manager+). */
export function useCreateAgencyTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAgencyTaskInput) => {
      const { data } = await api.post("/marketing/agency-tasks", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: marketingKeys.all });
    },
  });
}

/** PATCH /marketing/agency-tasks/:id — progress a task (store_manager+). */
export function useUpdateAgencyTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: AssetStatus;
    }) => {
      const { data } = await api.patch(`/marketing/agency-tasks/${id}`, {
        status,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: marketingKeys.all });
    },
  });
}

/** GET /marketing/assets — agency deliverables / shared creative for sign-off. */
export function useMarketingAssets() {
  const storeId = useSession((s) => s.currentStore.id);
  return useQuery({
    queryKey: marketingKeys.assets(storeId),
    queryFn: async () => {
      const { data } = await api.get<SharedAsset[]>("/marketing/assets");
      return data;
    },
  });
}

/** GET /marketing/agency-tasks — the same deliverables shaped as agency tasks. */
export function useAgencyTasks() {
  const storeId = useSession((s) => s.currentStore.id);
  return useQuery({
    queryKey: marketingKeys.agencyTasks(storeId),
    queryFn: async () => {
      const { data } = await api.get<AgencyTask[]>("/marketing/agency-tasks");
      return data;
    },
  });
}
