"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * What can actually reach a customer today.
 *
 * The three states are kept apart here as deliberately as they are on the
 * server. `dry_run` is not a softer `unavailable`: the code path is finished and
 * running, nothing leaves the building, and the work left is a setting. An
 * `unavailable` channel can be waiting on an app review or a DLT registration,
 * measured in weeks. A screen that showed them the same colour would send
 * somebody looking for a form that does not exist.
 */

export type DeliveryState = "live" | "dry_run" | "unavailable";

export interface ChannelDeliverability {
  channel: "whatsapp" | "instagram" | "email" | "voice";
  state: DeliveryState;
  code: string;
  reason: string;
  /** False until a real provider has answered. Never set by a saved credential. */
  verified: boolean;
  capabilities?: Record<string, boolean>;
}

export interface AiCapability {
  enabled: boolean;
  reason: string | null;
}

export interface AdapterReport {
  channels: ChannelDeliverability[];
  liveChannels: string[];
  dryRunChannels: string[];
  ai: {
    configured: boolean;
    vendor: string | null;
    model: string | null;
    reason: string | null;
    capabilities: { extraction: AiCapability; drafting: AiCapability };
  };
  verification: { anyVerified: boolean; note: string };
}

export function useAdapterReport() {
  return useQuery({
    queryKey: ["adapters"],
    queryFn: async () => {
      const { data } = await api.get<AdapterReport>("/adapters");
      return data;
    },
    staleTime: 60_000,
  });
}

/** How a channel's state reads on screen. */
export const STATE_LABEL: Record<
  DeliveryState,
  { label: string; tone: "good" | "bad" | "wait" | "mute"; hint: string }
> = {
  live: {
    label: "Reaching customers",
    tone: "good",
    hint: "A real message goes out on this channel.",
  },
  dry_run: {
    label: "Logged, not sent",
    tone: "wait",
    // The honest description. It is finished code waiting on a setting, which is
    // a different task from waiting on a provider.
    hint: "The path is complete and runs, but nothing leaves the building yet. This is a setting away.",
  },
  unavailable: {
    label: "Not connected",
    tone: "bad",
    hint: "There is no working path. The reason says what is missing.",
  },
};

export const CHANNEL_LABEL: Record<ChannelDeliverability["channel"], string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram Direct",
  email: "Email",
  voice: "Calls (outbound)",
};
