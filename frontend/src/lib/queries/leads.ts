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
  /** REQUIRED (Round-2) — the API 400s on a blank phone. */
  phone: string;
  /** REQUIRED per Module 1 — where the lead came from (day-end analysis). */
  source: LeadSource;
  interest?: string;
  /** Free-text remark. Replaces the removed price/amount field. */
  remark?: string;
  /** Round-2 optional profile fields. */
  address?: string;
  /** yyyy-mm-dd. */
  birthday?: string;
  /** yyyy-mm-dd. */
  anniversary?: string;
}

/** Optional inclusive date range for GET /leads (yyyy-mm-dd, latest-first). */
export interface LeadFilter {
  from?: string;
  to?: string;
}

/** GET /leads — store-scoped, role-filtered server-side. Optional date range. */
export function useLeads(filter: LeadFilter = {}) {
  const storeId = useStoreKey();
  const { from, to } = filter;
  return useQuery({
    // Keep the range in the key so changing it refetches like a fresh query.
    queryKey: ["leads", storeId, from ?? null, to ?? null],
    queryFn: async () => {
      const { data } = await api.get<Lead[]>("/leads", {
        params: {
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      });
      // Normalise the collection fields: the list endpoint may omit occasion
      // reminders / notes / SOP follow-ups, and the lead card + detail dialog
      // read `.length`/`.map` on each — default them to [] so neither crashes.
      return (Array.isArray(data) ? data : []).map((l) => ({
        ...l,
        reminders: l.reminders ?? [],
        notes: l.notes ?? [],
        followUps: l.followUps ?? [],
      }));
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

/** PATCH /leads/:id body — a stage move and/or the Round-2 profile fields. */
export interface UpdateLeadInput {
  id: string;
  stage?: LeadStage;
  address?: string;
  /** yyyy-mm-dd. */
  birthday?: string;
  /** yyyy-mm-dd. */
  anniversary?: string;
}

/** PATCH /leads/:id — move a lead's stage and/or update its profile fields. */
export function useMoveLeadStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: UpdateLeadInput) => {
      const { data } = await api.patch<Lead>(`/leads/${id}`, patch);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}
