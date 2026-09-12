"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Which number each branch sends from.
 *
 * The server returns numbers, branches and mappings in ONE payload on purpose,
 * and this mirrors that rather than splitting it into three queries: a screen
 * that loaded them separately would show a branch as unrouted while its number
 * was still in flight, and the operator's next action depends on seeing both
 * halves at once.
 *
 * A phone-number id never reaches the browser in full — only its last four
 * digits. Enough to recognise which number is which, useless to anyone who
 * intercepts it.
 */

export type RouteState = "routed" | "only_number" | "no_number" | "ambiguous";

export interface MessagingAccount {
  id: string;
  name: string;
  status: string;
  /** How many numbers live under this provider account. */
  numbers: number;
}

export interface MessagingNumber {
  id: string;
  /** "…4821". The full id is deliberately not sent. */
  phoneNumberIdSuffix: string;
  name: string | null;
  isActive: boolean;
  /** True only after a live provider call proved the token can read it. */
  providerOwnershipVerified: boolean;
  lastVerifiedAt: string | null;
  accountId: string;
  accountName: string;
  /** A number may legitimately answer for several branches. */
  branchesUsing: number;
}

export interface MessagingBranch {
  storeId: string;
  name: string;
  city: string;
  assetId: string | null;
  routedAt: string | null;
  /** What would actually happen if this branch sent right now. */
  effective: RouteState;
}

export interface MessagingRoutesOverview {
  channel: string;
  accounts: MessagingAccount[];
  numbers: MessagingNumber[];
  branches: MessagingBranch[];
  /** Branches that would refuse to send. The list to act on. */
  unroutable: string[];
}

const KEY = ["messaging-routes"] as const;

export function useMessagingRoutes(channel = "whatsapp") {
  return useQuery({
    queryKey: [...KEY, channel],
    queryFn: async () => {
      const { data } = await api.get<MessagingRoutesOverview>("/messaging-routes", {
        params: { channel },
      });
      return data;
    },
    staleTime: 60_000,
  });
}

export function useSetMessagingRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { storeId: string; assetId: string; channel?: string }) => {
      const { data } = await api.put(`/messaging-routes/${input.storeId}`, {
        assetId: input.assetId,
        ...(input.channel ? { channel: input.channel } : {}),
      });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      // Whether the tenant can send at all changes with this, and the
      // integrations screen reports that.
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

export function useClearMessagingRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { storeId: string; channel?: string }) => {
      const { data } = await api.delete<{ removed: boolean; warning: string | null }>(
        `/messaging-routes/${input.storeId}`,
        { params: input.channel ? { channel: input.channel } : undefined },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

/** How a branch's routing state reads on screen. */
export const ROUTE_STATE: Record<
  RouteState,
  { label: string; tone: "good" | "bad" | "wait" | "mute"; detail: string }
> = {
  routed: {
    label: "Mapped",
    tone: "good",
    detail: "This branch sends from the number shown.",
  },
  only_number: {
    label: "Only number",
    tone: "mute",
    detail: "One number is connected, so there is nothing to choose between.",
  },
  no_number: {
    label: "No number",
    tone: "bad",
    detail: "No WhatsApp number is connected for this organisation yet.",
  },
  ambiguous: {
    label: "Cannot send",
    tone: "bad",
    // The honest wording. It is not "unconfigured" — there are too many numbers
    // to guess between, and sending from the wrong one reaches the customer as a
    // different business.
    detail:
      "Several numbers are connected and none is mapped to this branch, so nothing will be sent from it.",
  },
};
