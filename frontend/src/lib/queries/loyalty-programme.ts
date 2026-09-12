"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The points programme, and the key the tenant's website authenticates with.
 *
 * Two rules the screens built on this must not break. A balance is never
 * computed in the browser — it comes from the server's ledger, and a figure
 * derived client-side would disagree with the statement the counter prints. And
 * the API key and signing secret are returned ONCE by their mutations; nothing
 * here caches them, because a credential in a query cache is a credential in a
 * React DevTools screenshot.
 */

export interface ProgrammeSettings {
  earnPoints: number | null;
  earnPerAmount: number | null;
  redeemValuePerPoint: number | null;
  minRedeemPoints: number;
  maxRedeemPointsPerTransaction: number | null;
  webhookUrl: string | null;
  /** False until both halves of the earn rate are set. Earning is then refused. */
  configured: boolean;
}

export interface LoyaltyMember {
  id: string;
  phone: string;
  name: string | null;
  tier: string | null;
  status: string;
  /** Signed. Negative only after a reversal, and then it is a debt. */
  pointsBalance: number;
  /**
   * What can actually be spent — never negative.
   *
   * Kept apart from `pointsBalance` deliberately. A member in debt has zero to
   * spend, and showing the negative number where a redeemable balance belongs
   * would put a negative discount in front of a checkout.
   */
  spendablePoints: number;
  /** Points owed back after a cancelled sale. Zero for almost every member. */
  adjustmentDebt: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  storeId: string | null;
  partyId: string | null;
  enrolledAt: string;
}

export interface LedgerEntry {
  id: string;
  kind: "earn" | "redeem" | "reversal" | "adjustment";
  /** Signed. Summing the column gives the balance. */
  points: number;
  balanceAfter: number;
  amount: number | null;
  reason: string | null;
  reference: string | null;
  source: string;
  storeId: string | null;
  reversesId: string | null;
  createdAt: string;
}

export interface Ledger {
  balance: number;
  entries: LedgerEntry[];
  nextCursor: string | null;
}

export interface IssuedKey {
  key: string;
  keyPrefix: string;
  header: string;
  basePath: string;
  warning: string;
}

export interface IssuedSecret {
  secret: string;
  header: string;
  scheme: string;
  warning: string;
}

const SETTINGS_KEY = ["loyalty-programme", "settings"] as const;
const MEMBERS_KEY = ["loyalty-programme", "members"] as const;

export function useProgrammeSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => {
      const { data } = await api.get<ProgrammeSettings>("/loyalty/programme/settings");
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useUpdateProgrammeSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Omit<ProgrammeSettings, "configured">>) => {
      // Only the fields the form actually changed are sent. The server treats
      // undefined as "leave alone" and an explicit null as "clear", so sending
      // the whole object would clear whatever the form left blank.
      const { data } = await api.put<ProgrammeSettings>("/loyalty/programme/settings", input);
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(SETTINGS_KEY, data);
    },
  });
}

export function useLoyaltyMembers(filters: { q?: string; storeId?: string } = {}) {
  return useQuery({
    queryKey: [...MEMBERS_KEY, filters],
    queryFn: async () => {
      const { data } = await api.get<LoyaltyMember[]>("/loyalty/programme/members", {
        params: filters,
      });
      return data;
    },
    staleTime: 60_000,
  });
}

export function useMemberLedger(phone: string | null) {
  return useQuery({
    queryKey: ["loyalty-programme", "ledger", phone],
    enabled: Boolean(phone),
    queryFn: async () => {
      const { data } = await api.get<Ledger>(
        `/loyalty/programme/members/${phone}/ledger`,
      );
      return data;
    },
    staleTime: 30_000,
  });
}

export function useRotateApiKey() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<IssuedKey>("/loyalty/programme/api-key");
      return data;
    },
  });
}

export function useRotateSigningSecret() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<IssuedSecret>("/loyalty/programme/signing-secret");
      return data;
    },
  });
}

export function useManualMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      phone: string;
      kind: "earn" | "redeem" | "adjustment";
      points?: number;
      amount?: number;
      reason?: string;
      reference?: string;
      storeId?: string;
    }) => {
      const { data } = await api.post<{
        entryId: string;
        points: number;
        balance: number;
      }>("/loyalty/programme/movements", input);
      return data;
    },
    onSuccess: (_res, input) => {
      void qc.invalidateQueries({ queryKey: MEMBERS_KEY });
      void qc.invalidateQueries({ queryKey: ["loyalty-programme", "ledger", input.phone] });
    },
  });
}

export function useRetryAnnouncements() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ considered: number; sent: number; failed: number }>(
        "/loyalty/programme/announcements/retry",
      );
      return data;
    },
  });
}

/** How a ledger line reads on screen. */
export const ENTRY_KIND: Record<
  LedgerEntry["kind"],
  { label: string; tone: "good" | "bad" | "wait" | "mute" }
> = {
  earn: { label: "Earned", tone: "good" },
  redeem: { label: "Redeemed", tone: "wait" },
  // Deliberately distinct from a redemption: the customer did not spend these,
  // a cancelled sale took them back.
  reversal: { label: "Reversed", tone: "bad" },
  adjustment: { label: "Adjusted by hand", tone: "mute" },
};
