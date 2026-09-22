"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Which external channels are actually connected on this deployment.
 *
 * The backend degrades to a logged no-op when credentials are missing, which is
 * the right behaviour for a service — but it means "send" can succeed without
 * anything leaving the building. The UI reads this so it can warn BEFORE someone
 * types a customer's number, rather than after.
 */
export interface IntegrationStatus {
  whatsapp: boolean;
  razorpay: boolean;
  goldRate: boolean;
  email: boolean;
}

export type IntegrationChannel = keyof IntegrationStatus;

export const CHANNEL_LABEL: Record<IntegrationChannel, string> = {
  whatsapp: "WhatsApp",
  razorpay: "Online payments",
  goldRate: "Live gold rate",
  email: "Email",
};

export type MetalKind =
  | "gold_24k"
  | "gold_22k"
  | "gold_18k"
  | "gold_14k"
  | "gold_12k"
  | "gold_10k"
  | "gold_9k"
  | "rose_gold_18k"
  | "platinum"
  | "silver";

export interface MetalRate {
  metal: MetalKind;
  ratePerGram: number;
  /** ISO timestamp the rate took effect. */
  effectiveFrom: string;
  ageHours: number;
  /** True once the rate is older than the server's stale window. */
  stale: boolean;
  /** ibja (the IBJA benchmark), manual (entered by hand) or feed (another provider). */
  source?: "ibja" | "manual" | "feed";
  /** The IBJA publication day (YYYY-MM-DD) when source is ibja. */
  publishedOn?: string | null;
  /** Not published by the source; derived from the 999 rate by purity. */
  derived?: boolean;
}

/** Karat shown in the quote builder → the metal key the backend stores. */
const KARAT_METAL: Record<number, MetalKind> = {
  24: "gold_24k",
  22: "gold_22k",
  18: "gold_18k",
  14: "gold_14k",
  12: "gold_12k",
  10: "gold_10k",
  9: "gold_9k",
};

/**
 * GET /integrations/gold-rate — today's metal rates for the active store.
 *
 * The quote builder used to price "auto" lines off a hardcoded constant in
 * `lib/mock/quotation.ts` (₹7,180/g for 22k), which meant every quote was built
 * on whatever gold cost the day that file was written. This is the live number.
 */
export function useMetalRates() {
  const query = useQuery({
    queryKey: ["integrations", "gold-rate"],
    queryFn: async () => {
      const { data } = await api.get<MetalRate[]>("/integrations/gold-rate");
      return data;
    },
    // Rates move through the day but not by the second. Poll every 5 min so the
    // live-rate chip + quote builder reflect a feed refresh or a manual override
    // without a reload.
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: false,
  });

  /** The stored rate for a karat, or null when nothing is on record yet. */
  function rateFor(karat: number): MetalRate | null {
    const metal = KARAT_METAL[karat];
    if (!metal) return null;
    return query.data?.find((r) => r.metal === metal) ?? null;
  }

  return { ...query, rateFor };
}

/**
 * POST /integrations/gold-rate — set today's gold rate by hand (managers+).
 * The manager enters one karat; the backend derives the other purities. On
 * success every quote built today prefills off the new number, so the cache is
 * invalidated to pull it straight through.
 */
export function useSetGoldRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ratePerGram: number; karat: 22 | 24 }) => {
      const { data } = await api.post<{ rates: Record<string, number> }>(
        "/integrations/gold-rate",
        input,
      );
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["integrations", "gold-rate"] }),
  });
}

/** POST /integrations/gold-rate/refresh — pull an intraday rate from the feed. */
export function useRefreshGoldRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{
        updated: boolean;
        dryRun: boolean;
        rates?: Record<string, number>;
      }>("/integrations/gold-rate/refresh");
      return data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["integrations", "gold-rate"] }),
  });
}

/** GET /integrations/status — deployment-wide, so it is cached for the session. */
export function useIntegrationStatus() {
  return useQuery({
    queryKey: ["integrations", "status"],
    queryFn: async () => {
      const { data } = await api.get<IntegrationStatus>("/integrations/status");
      return data;
    },
    // Credentials change on deploy, not during a shift.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
