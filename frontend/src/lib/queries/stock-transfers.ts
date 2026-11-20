"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useSession } from "@/store/use-session";
import type { Role } from "@/lib/types";

/**
 * Module 9 — inter-store Stock Transfer.
 *
 * Lifecycle: draft → submitted → ho_approved → dispatched → received →
 * acknowledged, with off-ramps `rejected` (from submitted) and `cancelled`
 * (before dispatch). The backend enforces every transition + who may run it;
 * the UI only mirrors that so users see buttons they can actually use.
 *
 * List queries are keyed on the active store id so switching the store in the
 * topbar auto-refetches (head office sees all transfers regardless).
 */

export type TransferStatus =
  | "draft"
  | "submitted"
  | "ho_approved"
  | "dispatched"
  | "received"
  | "acknowledged"
  | "rejected"
  | "cancelled";

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  ho_approved: "HO approved",
  dispatched: "Dispatched",
  received: "Received",
  acknowledged: "Acknowledged",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export interface TransferActor {
  id: string;
  name: string;
  role: Role;
  roleLabel: string;
}

export interface TransferItem {
  stockItemId: string;
  sku: string;
  name: string;
  /** Humanized current status of the piece (In stock / Aging / …). */
  currentStatus: string;
  currentStoreId: string;
}

export interface StockTransfer {
  id: string;
  ref: string;
  status: TransferStatus;
  reason: string | null;
  fromStoreId: string;
  fromStoreName: string;
  toStoreId: string;
  toStoreName: string;
  itemCount: number;
  items: TransferItem[];
  requestedBy: TransferActor | null;
  approvedBy: TransferActor | null;
  dispatchedBy: TransferActor | null;
  receivedBy: TransferActor | null;
  acknowledgedBy: TransferActor | null;
  submittedAt: string | null;
  approvedAt: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TransferDirection = "in" | "out" | "all";

export const transferKeys = {
  all: ["stock-transfers"] as const,
  list: (storeId: string, status: string, direction: TransferDirection) =>
    ["stock-transfers", "list", storeId, status, direction] as const,
  detail: (id: string) => ["stock-transfers", "detail", id] as const,
};

/** GET /stock-transfers — store-scoped list, filterable by status + direction. */
export function useStockTransfers(params: {
  status?: TransferStatus | "all";
  direction: TransferDirection;
}) {
  const storeId = useSession((s) => s.currentStore.id);
  const status = params.status ?? "all";
  return useQuery({
    queryKey: transferKeys.list(storeId, status, params.direction),
    queryFn: async () => {
      const query: Record<string, string> = { direction: params.direction };
      if (status !== "all") query.status = status;
      const { data } = await api.get<StockTransfer[]>("/stock-transfers", {
        params: query,
      });
      return data;
    },
  });
}

/** GET /stock-transfers/:id — full detail (pieces, actors, timestamps). */
export function useStockTransfer(id: string | null) {
  return useQuery({
    queryKey: transferKeys.detail(id ?? ""),
    enabled: !!id,
    queryFn: async () => {
      const { data } = await api.get<StockTransfer>(`/stock-transfers/${id}`);
      return data;
    },
  });
}

export interface CreateTransferInput {
  fromStoreId: string;
  toStoreId: string;
  stockItemIds: string[];
  note?: string;
}

/** POST /stock-transfers — create a DRAFT transfer. */
export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTransferInput) => {
      const { data } = await api.post<StockTransfer>("/stock-transfers", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: transferKeys.all });
    },
  });
}

/** The eight stage transitions, all `POST /stock-transfers/:id/<action>`. */
export type TransferAction =
  | "submit"
  | "approve"
  | "reject"
  | "dispatch"
  | "receive"
  | "acknowledge"
  | "cancel";

/**
 * Fire a stage transition. `reject`/`cancel` take an optional reason; the rest
 * take no body. One hook covers all eight endpoints — the backend is the
 * authority, so on a 409/403 the caller surfaces the message and we refetch.
 */
export function useTransferAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: TransferAction;
      reason?: string;
    }) => {
      const { data } = await api.post<StockTransfer>(
        `/stock-transfers/${id}/${action}`,
        reason ? { reason } : {},
      );
      return data;
    },
    // Refresh both the list and the open detail regardless of outcome so a
    // concurrent action (409) leaves the UI showing the true current state.
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: transferKeys.all });
      qc.invalidateQueries({ queryKey: transferKeys.detail(vars.id) });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Role + status → allowed actions (mirrors the backend guard)               */
/* -------------------------------------------------------------------------- */

export interface ActionMeta {
  action: TransferAction;
  label: string;
  variant: "gold" | "outline" | "destructive" | "ghost";
  /** Opens a reason prompt before firing. */
  needsReason?: boolean;
}

const SUBMIT: ActionMeta = { action: "submit", label: "Submit to HO", variant: "gold" };
const APPROVE: ActionMeta = { action: "approve", label: "Approve", variant: "gold" };
const REJECT: ActionMeta = { action: "reject", label: "Reject", variant: "ghost", needsReason: true };
const DISPATCH: ActionMeta = { action: "dispatch", label: "Dispatch", variant: "gold" };
const RECEIVE: ActionMeta = { action: "receive", label: "Mark received", variant: "gold" };
const ACKNOWLEDGE: ActionMeta = { action: "acknowledge", label: "Acknowledge", variant: "gold" };
const CANCEL: ActionMeta = { action: "cancel", label: "Cancel", variant: "outline", needsReason: true };

/**
 * Which stage buttons a given user may fire on a transfer, matching the API:
 *  - store_manager at the SOURCE store: submit / dispatch / cancel
 *  - store_manager at the DESTINATION store: receive / acknowledge
 *  - head_office: approve / reject only
 *  - everyone else (salesperson, area_manager): read-only
 * `operatedStoreIds` are the concrete stores this user runs (session.stores).
 */
export function availableActions(
  t: StockTransfer,
  role: Role,
  operatedStoreIds: Set<string>,
): ActionMeta[] {
  if (role === "head_office") {
    return t.status === "submitted" ? [APPROVE, REJECT] : [];
  }
  if (role !== "store_manager") return [];

  const isSource = operatedStoreIds.has(t.fromStoreId);
  const isDest = operatedStoreIds.has(t.toStoreId);
  const out: ActionMeta[] = [];

  if (isSource) {
    if (t.status === "draft") out.push(SUBMIT);
    if (t.status === "ho_approved") out.push(DISPATCH);
    if (t.status === "draft" || t.status === "submitted" || t.status === "ho_approved") {
      out.push(CANCEL);
    }
  }
  if (isDest) {
    if (t.status === "dispatched") out.push(RECEIVE);
    if (t.status === "received") out.push(ACKNOWLEDGE);
  }
  return out;
}
