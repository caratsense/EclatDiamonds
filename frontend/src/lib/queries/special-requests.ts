"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Role } from "@/lib/types";

/**
 * Special requests — a branch asking someone above it for a decision.
 *
 * Distinct from a ticket: a ticket reports a PROBLEM to be worked and closed; a
 * special request asks for a yes or no, carries an approver level, and (for
 * diamond rates) writes a new rate when approved.
 */

const KEY = "special-requests";

export type SpecialRequestKind =
  | "diamond_rate"
  | "price_override"
  | "stock_transfer"
  | "purchase"
  | "expense"
  | "staff"
  | "other";

export type SpecialRequestStatus =
  | "pending"
  | "escalated"
  | "approved"
  | "rejected"
  | "cancelled";

export type RequestPriority = "low" | "medium" | "high" | "urgent";

export const REQUEST_KIND_LABELS: Record<SpecialRequestKind, string> = {
  diamond_rate: "Diamond rate",
  price_override: "Price override",
  stock_transfer: "Stock transfer",
  purchase: "Purchase",
  expense: "Expense",
  staff: "Staffing",
  other: "Other",
};

/** Display order for the kind picker — most common first. */
export const REQUEST_KINDS: SpecialRequestKind[] = [
  "diamond_rate",
  "price_override",
  "stock_transfer",
  "purchase",
  "expense",
  "staff",
  "other",
];

export interface RequestMessage {
  id: string;
  authorId: string | null;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface SpecialRequest {
  id: string;
  ref: string;
  storeId: string;
  storeName: string;
  kind: SpecialRequestKind;
  kindLabel: string;
  title: string;
  details: string | null;
  amount: number | null;
  priority: RequestPriority;
  status: SpecialRequestStatus;
  /** YYYY-MM-DD, or null. */
  neededBy: string | null;
  /** Past `neededBy` and still undecided. */
  overdue: boolean;
  requestedById: string;
  requestedByName: string;
  requestedRole: Role;
  requiredRole: Role;
  requiredRoleLabel: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  diamondSpec: string | null;
  currentRatePerCarat: number | null;
  requestedRatePerCarat: number | null;
  appliedRateId: string | null;
  createdAt: string;
  /**
   * Whether THIS viewer may act — computed server-side from the escalation
   * ladder plus the no-self-approval rule, so the UI never has to reimplement it.
   */
  canDecide: boolean;
  canEscalate: boolean;
  canCancel: boolean;
}

export type SpecialRequestDetail = SpecialRequest & { messages: RequestMessage[] };

/**
 * `inbox` — undecided and actionable BY ME (the approver queue).
 * `mine`  — what I raised.
 * `open`  — every undecided request in scope.
 * `all`   — everything in scope, decided included.
 */
export type RequestScope = "inbox" | "mine" | "open" | "all";

export function useSpecialRequests(params: {
  scope?: RequestScope;
  kind?: SpecialRequestKind;
  status?: SpecialRequestStatus;
} = {}) {
  const storeId = useStoreKey();
  const { scope = "inbox", kind, status } = params;
  return useQuery({
    queryKey: [KEY, storeId, scope, kind ?? "", status ?? ""],
    queryFn: async () => {
      const { data } = await api.get<SpecialRequest[]>("/requests", {
        params: { scope, ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
      });
      return data;
    },
  });
}

export function useSpecialRequest(id: string | null) {
  return useQuery({
    queryKey: [KEY, "detail", id],
    enabled: !!id,
    queryFn: async () => {
      const { data } = await api.get<SpecialRequestDetail>(`/requests/${id}`);
      return data;
    },
  });
}

export interface CreateSpecialRequestInput {
  storeId: string;
  kind: SpecialRequestKind;
  title: string;
  details?: string;
  amount?: number;
  priority?: RequestPriority;
  /** YYYY-MM-DD. */
  neededBy?: string;
  /** Required when kind is `diamond_rate`. */
  diamondSpec?: string;
  requestedRatePerCarat?: number;
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: [KEY] });
  // A new or decided request changes the bell and the work-queue counts.
  qc.invalidateQueries({ queryKey: ["notifications"] });
}

/** POST /requests — raise one. The approver level is derived, never chosen. */
export function useCreateSpecialRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSpecialRequestInput) => {
      const { data } = await api.post<SpecialRequest>("/requests", input);
      return data;
    },
    onSuccess: () => invalidate(qc),
  });
}

/**
 * PATCH /requests/:id/decide — approve or reject.
 *
 * `approvedRatePerCarat` lets a diamond-rate approver settle at a different
 * number than the one asked for; meeting the branch partway is the usual real
 * outcome, not a flat yes or no.
 */
export function useDecideSpecialRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: "approved" | "rejected";
      note?: string;
      approvedRatePerCarat?: number;
    }) => {
      const { id, ...body } = input;
      const { data } = await api.patch<SpecialRequest>(`/requests/${id}/decide`, body);
      return data;
    },
    onSuccess: () => invalidate(qc),
  });
}

/** PATCH /requests/:id/escalate — hand it to the next role up. */
export function useEscalateSpecialRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note?: string }) => {
      const { data } = await api.patch<SpecialRequest>(`/requests/${id}/escalate`, { note });
      return data;
    },
    onSuccess: () => invalidate(qc),
  });
}

/** PATCH /requests/:id/cancel — withdraw your own. */
export function useCancelSpecialRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const { data } = await api.patch<SpecialRequest>(`/requests/${id}/cancel`, { reason });
      return data;
    },
    onSuccess: () => invalidate(qc),
  });
}

/** POST /requests/:id/messages — add to the thread (notifies the other side). */
export function useAddRequestMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      const { data } = await api.post<RequestMessage>(`/requests/${id}/messages`, { body });
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: [KEY, "detail", vars.id] });
    },
  });
}
