"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Lead, LeadSource, LeadStage } from "@/lib/mock/crm";

export interface CreateLeadInput {
  storeId: string;
  customerName: string;
  phone?: string;
  /** REQUIRED per Module 1 — where the lead came from (day-end analysis). */
  source: LeadSource;
  interest?: string;
  /** Free-text remark. Replaces the removed price/amount field. */
  remark?: string;
}

/** GET /leads — store-scoped, role-filtered server-side. */
export function useLeads() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["leads", storeId],
    queryFn: async () => {
      const { data } = await api.get<Lead[]>("/leads");
      return data;
    },
  });
}

/** POST /leads — create a lead against the active store. */
export function useCreateLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateLeadInput) => {
      const { data } = await api.post<Lead>("/leads", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

/** PATCH /leads/:id — move a lead to a new pipeline stage. */
export function useMoveLeadStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: LeadStage }) => {
      const { data } = await api.patch<Lead>(`/leads/${id}`, { stage });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}
