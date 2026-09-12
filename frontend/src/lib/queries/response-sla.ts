"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The first-response promise: how long a customer may wait, and who is not
 * keeping it.
 *
 * Every number here comes from the server's own aggregates. Nothing on this
 * screen counts rows it happens to be holding — a breach count derived from the
 * fifty rows on a page reports fifty, whatever the real figure is.
 */

export interface ResponseSlaSettings {
  organisationId: string;
  /** Null means the SLA is not running. Éclat's number is 5. */
  firstResponseMinutes: number | null;
  escalateAfterMinutes: number | null;
  autoCallOnBreach: boolean;
  active: boolean;
  /**
   * Why an automatic call would not be placed. Non-null even when the switch is
   * on — having the switch on is not the same as having a provider that dials.
   */
  autoCallBlockedReason: string | null;
}

export interface ResponseSlaSummary {
  windowDays: number;
  since: string;
  storeIds: string[];
  targetMinutes: number | null;
  active: boolean;
  tracked: number;
  met: number;
  breached: number;
  escalated: number;
  awaiting: number;
  answered: number;
  /** Null, not zero, when nothing has been measured yet. */
  medianResponseSeconds: number | null;
  p90ResponseSeconds: number | null;
  withinTargetPct: number | null;
}

export interface ResponseSlaClock {
  id: string;
  conversationId: string;
  channel: string;
  customerName: string | null;
  storeId: string | null;
  storeName: string | null;
  startedAt: string;
  dueAt: string;
  targetMinutes: number;
  status: "waiting" | "met" | "breached";
  respondedAt: string | null;
  responseSeconds: number | null;
  responderName: string | null;
  responderType: string | null;
  breachedAt: string | null;
  escalatedAt: string | null;
  /** Null for anyone but a manager — whose queue it landed in is their business. */
  taskId: string | null;
}

export interface SlaFilters {
  storeId?: string;
  status?: ResponseSlaClock["status"];
  days?: number;
  limit?: number;
}

const KEY = ["response-sla"] as const;

export function useResponseSlaSettings() {
  return useQuery({
    queryKey: [...KEY, "settings"],
    queryFn: async () => {
      const { data } = await api.get<ResponseSlaSettings>("/crm/sla/settings");
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSaveResponseSlaSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      firstResponseMinutes?: number | null;
      escalateAfterMinutes?: number | null;
      autoCallOnBreach?: boolean;
    }) => {
      const { data } = await api.put<ResponseSlaSettings>("/crm/sla/settings", input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useResponseSlaSummary(filters: Pick<SlaFilters, "storeId" | "days"> = {}) {
  return useQuery({
    queryKey: [...KEY, "summary", filters],
    queryFn: async () => {
      const { data } = await api.get<ResponseSlaSummary>("/crm/sla/summary", { params: filters });
      return data;
    },
    // Short: the point of the screen is that a breach is minutes old.
    staleTime: 30_000,
  });
}

export function useResponseSlaClocks(filters: SlaFilters = {}) {
  return useQuery({
    queryKey: [...KEY, "clocks", filters],
    queryFn: async () => {
      const { data } = await api.get<ResponseSlaClock[]>("/crm/sla/clocks", { params: filters });
      return data;
    },
    staleTime: 30_000,
  });
}

/** Settle everything owed right now rather than waiting for the next tick. */
export function useSweepResponseSla() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{
        examined: number;
        met: number;
        breached: number;
        escalated: number;
      }>("/crm/sla/sweep");
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** "1m 20s" / "45s" / "—". Seconds, because a five-minute promise needs them. */
export function formatResponseTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
