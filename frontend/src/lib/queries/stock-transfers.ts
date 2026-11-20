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
 * A PULL — this branch asking another branch for a piece — is the same record
 * with `initiatedBy: "destination"`, and takes one extra step in front of that
 * line: `pending_source`, where the branch holding the pieces accepts (joining
 * the ladder at `submitted`) or declines (terminal).
 *
 * List queries are keyed on the active store id so switching the store in the
 * topbar auto-refetches (head office sees all transfers regardless).
 */

export type TransferStatus =
  | "draft"
  | "pending_source"
  | "submitted"
  | "ho_approved"
  | "dispatched"
  | "received"
  | "acknowledged"
  | "declined"
  | "rejected"
  | "cancelled";

/** Which end raised it: a branch sending stock away, or one asking for it. */
export type TransferInitiator = "source" | "destination";

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  draft: "Draft",
  // Named for what is actually happening: somebody at the other branch has to
  // answer. "Pending" alone would read as another queue nobody owns.
  pending_source: "With the holding branch",
  submitted: "Submitted",
  ho_approved: "HO approved",
  dispatched: "Dispatched",
  received: "Received",
  acknowledged: "Acknowledged",
  declined: "Declined by branch",
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
  initiatedBy: TransferInitiator;
  fromStoreId: string;
  fromStoreName: string;
  toStoreId: string;
  toStoreName: string;
  itemCount: number;
  items: TransferItem[];
  requestedBy: TransferActor | null;
  /** Who at the holding branch answered a pull (accepted or declined). */
  sourceDecidedBy: TransferActor | null;
  approvedBy: TransferActor | null;
  dispatchedBy: TransferActor | null;
  receivedBy: TransferActor | null;
  acknowledgedBy: TransferActor | null;
  submittedAt: string | null;
  sourceDecidedAt: string | null;
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

/**
 * A piece at ANOTHER branch, as that branch's shelf is shown to an asker.
 *
 * Deliberately thin: no price, no cost, no hallmark. The backend serves only
 * these columns (see backend pullable-stock.ts); this type says the same thing
 * on the screen so nobody writes a card expecting a number that will never
 * arrive.
 */
export interface PullableStockItem {
  id: string;
  sku: string;
  name: string;
  styleNumber: string | null;
  category: string;
  metal: string | null;
  karat: number;
  grossGrams: number;
  status: string;
  storeId: string;
  storeName: string;
}

/** GET /stock-transfers/pullable — one other branch's available pieces. */
export function usePullableStock(fromStoreId: string, q: string) {
  const search = q.trim();
  return useQuery({
    queryKey: ["stock-transfers", "pullable", fromStoreId, search] as const,
    // Nothing to ask about until a branch is chosen — and the endpoint refuses
    // an empty one, so firing it would only produce a red toast.
    enabled: !!fromStoreId,
    queryFn: async () => {
      const { data } = await api.get<PullableStockItem[]>(
        "/stock-transfers/pullable",
        { params: { fromStoreId, ...(search ? { q: search } : {}) } },
      );
      return data;
    },
  });
}

/** POST /stock-transfers/pull — create a DRAFT pull from another branch. */
export function useCreatePull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTransferInput) => {
      const { data } = await api.post<StockTransfer>("/stock-transfers/pull", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: transferKeys.all });
    },
  });
}

/** The stage transitions, all `POST /stock-transfers/:id/<action>`. */
export type TransferAction =
  | "submit"
  | "accept"
  | "decline"
  | "approve"
  | "reject"
  | "dispatch"
  | "receive"
  | "acknowledge"
  | "cancel";

/**
 * Fire a stage transition. `reject`/`decline`/`cancel` take an optional reason;
 * the rest take no body. One hook covers every endpoint — the backend is the
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
const SEND_TO_BRANCH: ActionMeta = { action: "submit", label: "Send request", variant: "gold" };
const ACCEPT: ActionMeta = { action: "accept", label: "Accept request", variant: "gold" };
/*
 * Declining is an outline button, not a destructive one, and it carries the
 * same weight as accepting. A branch saying "we need this piece here" is a
 * normal answer to a normal question — styling it as damage would push managers
 * toward agreeing to transfers they cannot afford.
 */
const DECLINE: ActionMeta = {
  action: "decline",
  label: "Decline",
  variant: "outline",
  needsReason: true,
};
const APPROVE: ActionMeta = { action: "approve", label: "Approve", variant: "gold" };
const REJECT: ActionMeta = { action: "reject", label: "Reject", variant: "ghost", needsReason: true };
const DISPATCH: ActionMeta = { action: "dispatch", label: "Dispatch", variant: "gold" };
const RECEIVE: ActionMeta = { action: "receive", label: "Mark received", variant: "gold" };
const ACKNOWLEDGE: ActionMeta = { action: "acknowledge", label: "Acknowledge", variant: "gold" };
const CANCEL: ActionMeta = { action: "cancel", label: "Cancel", variant: "outline", needsReason: true };

/** The branch whose staff raised it: the source on a push, the asker on a pull. */
export function initiatingStoreId(t: StockTransfer): string {
  return t.initiatedBy === "destination" ? t.toStoreId : t.fromStoreId;
}

/** Stages a transfer can still be withdrawn from (nothing has physically moved). */
const CANCELLABLE: TransferStatus[] = [
  "draft",
  "pending_source",
  "submitted",
  "ho_approved",
];

/**
 * Which stage buttons a given user may fire on a transfer, matching the API:
 *  - whoever RAISED it, at the raising branch: submit (a salesperson's draft is
 *    theirs to send — the API has allowed that since 9 Oct)
 *  - store_manager at the raising branch: submit / cancel
 *  - store_manager at the SOURCE store: dispatch, and on a pull accept/decline
 *  - store_manager at the DESTINATION store: receive / acknowledge
 *  - head_office: approve / reject only
 *  - everyone else (area_manager): read-only
 * `operatedStoreIds` are the concrete stores this user runs (session.stores);
 * `userId` is the signed-in person, needed because nobody answers their own
 * request — a manager who runs both branches is a real case.
 */
export function availableActions(
  t: StockTransfer,
  role: Role,
  operatedStoreIds: Set<string>,
  userId?: string,
): ActionMeta[] {
  if (role === "head_office") {
    return t.status === "submitted" ? [APPROVE, REJECT] : [];
  }

  const pulling = t.initiatedBy === "destination";
  const onRaisingSide = operatedStoreIds.has(initiatingStoreId(t));
  const raisedIt = !!userId && t.requestedBy?.id === userId;
  const send = pulling ? SEND_TO_BRANCH : SUBMIT;

  // Branch staff: their own draft is theirs to send, and nothing else. Without
  // this a salesperson's request would sit in draft until a manager noticed it.
  if (role !== "store_manager") {
    return t.status === "draft" && onRaisingSide && raisedIt ? [send] : [];
  }

  const isSource = operatedStoreIds.has(t.fromStoreId);
  const isDest = operatedStoreIds.has(t.toStoreId);
  const out: ActionMeta[] = [];

  if (onRaisingSide) {
    if (t.status === "draft") out.push(send);
    if (CANCELLABLE.includes(t.status)) out.push(CANCEL);
  }
  // The holding branch answers a pull — never the branch that asked, and never
  // the person who asked, even when they run both branches.
  if (pulling && isSource && t.status === "pending_source" && !raisedIt) {
    out.push(ACCEPT, DECLINE);
  }
  if (isSource && t.status === "ho_approved") out.push(DISPATCH);
  if (isDest) {
    if (t.status === "dispatched") out.push(RECEIVE);
    if (t.status === "received") out.push(ACKNOWLEDGE);
  }
  return out;
}
