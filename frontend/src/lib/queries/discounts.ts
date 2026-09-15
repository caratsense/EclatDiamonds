"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import { useSession } from "@/store/use-session";
import { ROLE_RANK, type Role } from "@/lib/types";
import type { DiscountRecord } from "@/lib/mock/discounts";

/**
 * Module 15 — Discount Management + Approval Hierarchy.
 *
 * Gold is never discounted — only diamond % and making %. Every response is
 * ROLE-AWARE: cost price / margin come back only for area_manager & head_office
 * (see DiscountRecord). List queries are keyed on the active store id so
 * switching the store in the topbar auto-refetches.
 */

/** Re-export the row shape so callers can `import { DiscountRecord }` from here. */
export type { DiscountRecord } from "@/lib/mock/discounts";

/** POST /discounts body — the new diamond/making request shape. */
export interface CreateDiscountRequestInput {
  storeId: string;
  customerName: string;
  item?: string;
  productId?: string;
  diamondPercent: number;
  makingPercent: number;
  sellingPrice?: number;
  reason?: string;
}

/** GET /discounts/limits row — the per-role diamond/making caps. */
export interface DiscountLimit {
  role: Role;
  /** Max diamond discount (%) this role may self-approve. Null until configured. */
  diamondPercent: number | null;
  /** Max making discount (%) this role may self-approve. Null until configured. */
  makingPercent: number | null;
  /** Max single discount (%) on a QUOTE (making + diamonds) before approval. */
  quotePercent: number | null;
}

/** GET /discounts — store-scoped, role-aware list of discount requests. */
export function useDiscounts() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["discounts", storeId],
    queryFn: async () => {
      const { data } = await api.get<DiscountRecord[]>("/discounts");
      // Server sends `customer`; the UI reads `customerName` — normalise.
      return data.map((d) => ({
        ...d,
        customerName: d.customerName ?? (d as { customer?: string }).customer ?? "",
      }));
    },
  });
}

/**
 * POST /discounts — request a discount. The server auto-approves within the
 * store-manager caps or escalates (M15 rule), returning the decided record
 * with its `status` and `requiredRole`.
 */
export function useCreateDiscountRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateDiscountRequestInput) => {
      const { data } = await api.post<DiscountRecord>("/discounts", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["discounts"] });
    },
  });
}

/**
 * PATCH /discounts/:id/approve — sign off a request. The backend enforces that
 * the caller's role rank ≥ the row's requiredRole; the UI gates the button too.
 */
export function useApproveDiscount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.patch<DiscountRecord>(`/discounts/${id}/approve`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["discounts"] });
    },
  });
}

/**
 * PATCH /discounts/:id/reject — decline a request (same role-rank gate).
 * Accepts an optional `note` (reason) that populates "Note from approver".
 */
export function useRejectDiscount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note?: string }) => {
      const { data } = await api.patch<DiscountRecord>(
        `/discounts/${id}/reject`,
        note ? { note } : {},
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["discounts"] });
    },
  });
}

/**
 * GET /discounts/limits — the per-role caps table. Restricted to store_manager
 * and above server-side, so the query is disabled for salespeople.
 */
export function useDiscountLimits() {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  return useQuery({
    queryKey: ["discounts", "limits"],
    enabled: canView,
    queryFn: async () => {
      const { data } = await api.get<Array<Record<string, number | string | null>>>(
        "/discounts/limits",
      );
      // Server sends maxDiamondPercent/maxMakingPercent (null until configured);
      // fall back to the legacy single maxPercent so the caps still render.
      return data.map(
        (l): DiscountLimit => ({
          role: l.role as Role,
          diamondPercent: (l.maxDiamondPercent ?? l.maxPercent ?? null) as number | null,
          makingPercent: (l.maxMakingPercent ?? l.maxPercent ?? null) as number | null,
          quotePercent: (l.maxPercent ?? null) as number | null,
        }),
      );
    },
  });
}

export interface DiscountPreset {
  id: string;
  code: string;
  name: string;
  diamondPercent: number;
  makingPercent: number;
  overallPercent: number;
  description: string;
}

/** GET /discounts/presets — return preset discount codes dropdown list. */
export function useDiscountPresets() {
  return useQuery({
    queryKey: ["discounts", "presets"],
    queryFn: async () => {
      const { data } = await api.get<DiscountPreset[]>("/discounts/presets");
      return data;
    },
  });
}

