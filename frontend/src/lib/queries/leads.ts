"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  ActivityKind,
  Lead,
  LeadOutcome,
  LeadSource,
  LeadStage,
} from "@/lib/mock/crm";

/**
 * Query key used by @/lib/queries/reminders.ts (REMINDERS_KEY there).
 * Adding a follow-up here must refresh the Reminders page too.
 */
const REMINDERS_KEY = "reminders";

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

/** Outcome facet for GET /leads. Server defaults to 'open' when omitted. */
export type LeadOutcomeFilter = LeadOutcome | "all";

/** Optional inclusive date range for GET /leads (yyyy-mm-dd, latest-first). */
export interface LeadFilter {
  from?: string;
  to?: string;
  /** 'open' (default) | 'won' | 'lost' | 'all'. */
  outcome?: LeadOutcomeFilter;
  /** Leads carrying ANY of these tags. Empty means every lead. */
  tagIds?: string[];
}

/**
 * The CRM search box, matched the way the server matches `?q=` for the export:
 * name or reference contains the text, or — when it is mostly a number — the
 * phone contains its digits.
 */
export function matchesLeadSearch(lead: Lead, query: string): boolean {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return true;
  if (lead.customer.toLocaleLowerCase().includes(text)) return true;
  if (lead.ref.toLocaleLowerCase().includes(text)) return true;
  const digits = text.replace(/\D/g, "");
  return digits.length >= 4 && (lead.phone ?? "").includes(digits);
}

/** GET /leads — store-scoped, role-filtered server-side. Optional date range. */
export function useLeads(filter: LeadFilter = {}) {
  const storeId = useStoreKey();
  const { from, to, outcome } = filter;
  const tagIds = [...(filter.tagIds ?? [])].sort().join(",");
  return useQuery({
    // Keep the range + outcome + tags in the key so changing any refetches
    // like a fresh query.
    queryKey: ["leads", storeId, from ?? null, to ?? null, outcome ?? "open", tagIds],
    queryFn: async () => {
      const { data } = await api.get<Lead[]>("/leads", {
        params: {
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(outcome ? { outcome } : {}),
          ...(tagIds ? { tagIds } : {}),
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

/**
 * PATCH /leads/:id — move a lead's stage and/or update its profile fields.
 * Server side-effects: stage → quotation auto-creates a +2d follow-up;
 * stage → order_placed auto-sets outcome = won. Invalidate reminders too
 * so the auto-created follow-up appears without a manual refresh.
 */
export function useMoveLeadStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: UpdateLeadInput) => {
      const { data } = await api.patch<Lead>(`/leads/${id}`, patch);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: [REMINDERS_KEY] });
    },
  });
}

/** POST /leads/:id/activities — log a call / visit / WhatsApp / note. */
export interface LogActivityInput {
  id: string;
  kind: ActivityKind;
  text: string;
}

/** Logs an activity on the lead's timeline and bumps lastActivity. */
export function useLogActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, kind, text }: LogActivityInput) => {
      const { data } = await api.post<Lead>(`/leads/${id}/activities`, {
        kind,
        text,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

/** POST /leads/:id/follow-ups — schedule an ad-hoc follow-up reminder. */
export interface AddFollowUpInput {
  id: string;
  /** Due date, yyyy-mm-dd. */
  dueDate: string;
  note?: string;
}

/** The new follow-up flows into the Reminders page — invalidate both. */
export function useAddFollowUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, dueDate, note }: AddFollowUpInput) => {
      const { data } = await api.post(`/leads/${id}/follow-ups`, {
        dueDate,
        ...(note ? { note } : {}),
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: [REMINDERS_KEY] });
    },
  });
}

/** PATCH /leads/:id/outcome — close (won/lost) or reopen a lead. */
export interface SetOutcomeInput {
  id: string;
  outcome: LeadOutcome;
  /** Required by the API when outcome = 'lost' (400 otherwise). */
  lostReason?: string;
}

export function useSetOutcome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, outcome, lostReason }: SetOutcomeInput) => {
      const { data } = await api.patch<Lead>(`/leads/${id}/outcome`, {
        outcome,
        ...(lostReason ? { lostReason } : {}),
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}
