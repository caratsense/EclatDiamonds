"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";

/**
 * CRM › NPS.
 *
 * Three facts kept apart on purpose, because the client's register keeps them
 * apart: we sent something, the customer replied on WhatsApp, the customer
 * filled the form. A reply is not a submission.
 */

export type NpsStage =
  | "pending_initial"
  | "initial_sent"
  | "awaiting_response"
  | "reminder_due"
  | "reminder_sent"
  | "completed"
  | "failed";

export interface NpsUpdateRow {
  checkInId: string;
  partyId: string | null;
  customerName: string | null;
  phone: string | null;
  store: string | null;
  visitAt: string | null;
  visitDate: string | null;
  salesperson: string | null;
  manager: string | null;
  stage: NpsStage;
  stageLabel: string;
  replyState: "none" | "replied" | "submitted";
  initialSentAt: string | null;
  reminderDueAt: string | null;
  reminderSentAt: string | null;
  repliedAt: string | null;
  submittedAt: string | null;
  score: number | null;
  scoreAnswer: string | null;
  failureNote: string | null;
  attempts: number;
  followups: { id: string; at: string; date: string | null; response: string | null }[];
}

export interface NpsResponseRow {
  id: string;
  submittedAt: string;
  rawName: string | null;
  rawNumber: string | null;
  phoneE164: string | null;
  firstPurchase: string | null;
  recommendAnswer: string | null;
  visitPurpose: string | null;
  likedMost: string | null;
  couldImprove: string | null;
  notFound: string | null;
  heardAboutUs: string | null;
  followsSocial: string | null;
  concerns: string | null;
  score: number | null;
  matchState: "matched" | "unmatched" | "ambiguous";
  matchNote: string | null;
  party: { id: string; name: string } | null;
  checkIn: { id: string; timeIn: string; store: { name: string } | null } | null;
}

export function useNpsUpdates(opts: { stage?: NpsStage; take?: number } = {}) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["nps", "updates", storeId, opts.stage ?? "all", opts.take ?? 100],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts.stage) params.set("stage", opts.stage);
      params.set("take", String(opts.take ?? 100));
      const { data } = await api.get<{ rows: NpsUpdateRow[]; total: number }>(
        `/crm/nps/updates?${params.toString()}`,
      );
      return data;
    },
  });
}

export function useNpsResponses(opts: { matchState?: string } = {}) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["nps", "responses", storeId, opts.matchState ?? "all"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts.matchState) params.set("matchState", opts.matchState);
      const { data } = await api.get<{ rows: NpsResponseRow[]; total: number }>(
        `/crm/nps/responses?${params.toString()}`,
      );
      return data;
    },
  });
}
