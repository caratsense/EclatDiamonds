"use client";

import { useQuery } from "@tanstack/react-query";

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
  | "rose_gold_18k"
  | "platinum"
  | "silver";

export interface MetalRate {
  metal: MetalKind;
  ratePerGram: number;
  /** ISO timestamp the rate took effect. */
  effectiveFrom: string;
  ageHours: number;
  /** True once older than the configured window (24h by default). */
  stale: boolean;
}

/** Karat shown in the quote builder → the metal key the backend stores. */
const KARAT_METAL: Record<number, MetalKind> = {
  24: "gold_24k",
  22: "gold_22k",
  18: "gold_18k",
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
    // Rates move through the day but not by the second.
    staleTime: 5 * 60 * 1000,
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
