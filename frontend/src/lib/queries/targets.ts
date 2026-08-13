"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Module 10 — Monthly sales targets per store (and optionally per staff) plus
 * achievement tracking. Set/managed by area_manager+ (backend enforces this).
 * Periods are "YYYY-MM". Mutations invalidate the target + achievement queries
 * and the store-comparison feed (which now carries a real target number).
 */

export interface TargetRow {
  id: string;
  storeId: string;
  storeName: string;
  /** Present for a per-staff target; omitted for a whole-store target. */
  staffId?: string | null;
  staffName?: string | null;
  period: string;
  amount: number;
}

export interface TargetAchievementRow {
  storeId: string;
  storeName: string;
  target: number;
  achieved: number;
  /** Achieved ÷ target (%). */
  pct: number;
}

export interface SetTargetInput {
  storeId: string;
  staffId?: string;
  period: string;
  amount: number;
}

/** GET /targets?period — configured target rows for the month. */
export function useTargets(period: string) {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  return useQuery({
    queryKey: ["targets", period],
    enabled: canView && !!period,
    queryFn: async () => {
      const { data } = await api.get<{ items: TargetRow[] }>("/targets", {
        params: { period },
      });
      return data.items;
    },
  });
}

/** GET /targets/achievement?period — per-store target vs. achieved. */
export function useTargetAchievement(period: string) {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  return useQuery({
    queryKey: ["targets", "achievement", period],
    enabled: canView && !!period,
    queryFn: async () => {
      const { data } = await api.get<{ items: TargetAchievementRow[] }>(
        "/targets/achievement",
        { params: { period } },
      );
      return data.items;
    },
  });
}

/** Invalidate every target-derived cache, including the store-comparison feed. */
function invalidateTargets(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["targets"] });
  qc.invalidateQueries({ queryKey: ["targets", "achievement"] });
  qc.invalidateQueries({ queryKey: ["dashboard", "charts"] });
}

/** POST /targets — upsert a target (whole-store when staffId is omitted). */
export function useSetTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetTargetInput) => {
      const { data } = await api.post<TargetRow>("/targets", input);
      return data;
    },
    onSuccess: () => invalidateTargets(qc),
  });
}

/** PATCH /targets/:id — change a target amount. */
export function usePatchTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, amount }: { id: string; amount: number }) => {
      const { data } = await api.patch<TargetRow>(`/targets/${id}`, { amount });
      return data;
    },
    onSuccess: () => invalidateTargets(qc),
  });
}

/** DELETE /targets/:id — remove a target. */
export function useDeleteTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/targets/${id}`);
      return id;
    },
    onSuccess: () => invalidateTargets(qc),
  });
}
