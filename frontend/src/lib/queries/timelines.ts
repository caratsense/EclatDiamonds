"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  CustomOrder,
  OrderCategory,
  OrderKind,
  Replenishment,
} from "@/lib/mock/timelines";

/**
 * Module 8 — Timelines & Status Tracking (internal operations view; the
 * customer-facing timeline is an open decision, see docs/DECISIONS.md).
 * Live hooks against `/timelines/*`.
 *
 * Backend shape notes (timelines.service.ts): `grams` is not modelled on a
 * CustomOrder so it comes back as 0 (UI shows "—"); replenishment has no
 * `carrier`; `status` strings already match ReplenishmentStatus; ETA/bookedOn
 * are ISO date strings. We type against the existing mock interfaces.
 */

const TIMELINES_KEY = "timelines";

/** One production stage event in an order's history (orders/:id only). */
export interface OrderEvent {
  id: string;
  stage: string;
  stageIndex: number;
  note: string;
  byRole: string;
  byName: string;
  at: string;
}

export type CustomOrderDetail = CustomOrder & { events: OrderEvent[] };

export interface CreateWorkflowInput {
  customer: string;
  item: string;
  storeId: string;
}

/**
 * @deprecated Superseded by {@link useCreateOrder} (Module 2 booking form).
 * Kept so any older caller keeps compiling; new code should book via
 * POST /timelines/orders.
 */
export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateWorkflowInput) => {
      const { data } = await api.post<CustomOrder>(
        "/timelines/workflows",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [TIMELINES_KEY, "orders"] });
    },
  });
}

/**
 * Module 2 — Order Booking payload. Mirrors POST /timelines/orders. For a
 * stock order with no `eta`, the server auto-sets eta = bookedOn + 21 days.
 */
export interface CreateOrderInput {
  storeId: string;
  customerName: string;
  kind: OrderKind;
  category?: OrderCategory;
  qty?: number;
  details?: string;
  /** Optional short item/description used as the order title. */
  item?: string;
  estimation?: number;
  advanceReceived?: number;
  /** Ring size (custom rings). */
  ringSize?: string;
  /** Bangle size (custom bangles). */
  bangleSize?: string;
  /** Metal colour — preset or free text. */
  metalColor?: string;
  /** How the advance was collected (cash/card/upi/bank). */
  advanceMode?: string;
  /** yyyy-mm-dd — promised delivery date (customer-facing). */
  deliveryDate?: string;
  /** yyyy-mm-dd — order-placed date. */
  bookedOn?: string;
  /** yyyy-mm-dd — estimated delivery date. */
  eta?: string;
}

/** POST /timelines/orders — book a custom or stock order. */
export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOrderInput) => {
      const { data } = await api.post<CustomOrder>("/timelines/orders", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [TIMELINES_KEY, "orders"] });
    },
  });
}

/**
 * POST /timelines/orders/:id/image — attach a reference image to an order.
 * Sends multipart form-data (field `file`); returns the order with `imageUrl`.
 */
export function useUploadOrderImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post<CustomOrder>(
        `/timelines/orders/${id}/image`,
        form,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [TIMELINES_KEY, "orders"] });
    },
  });
}

/**
 * POST /timelines/orders/:id/receipt — attach the advance-receipt image to an
 * order. Sends multipart form-data (field `file`); returns the order with
 * `advanceReceiptUrl`. Mirrors {@link useUploadOrderImage}.
 */
export function useUploadReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post<CustomOrder>(
        `/timelines/orders/${id}/receipt`,
        form,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [TIMELINES_KEY, "orders"] });
    },
  });
}

/** Which order kinds to list. */
export type OrderKindFilter = OrderKind | "all";
/** ongoing = still in production; all = include collected/closed. */
export type OrderScope = "ongoing" | "all";

export interface UseOrdersParams {
  kind?: OrderKindFilter;
  scope?: OrderScope;
}

/**
 * GET /timelines/orders — orders with current stage, store-scoped. Filter by
 * `kind` (custom | stock | all) and `scope` (ongoing | all). Store scoping is
 * applied server-side via the X-Store-Id header; `storeId` is in the query key
 * so switching store refetches.
 */
export function useOrders({ kind = "all", scope = "ongoing" }: UseOrdersParams = {}) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [TIMELINES_KEY, "orders", storeId, kind, scope],
    queryFn: async () => {
      const { data } = await api.get<CustomOrder[]>("/timelines/orders", {
        params: { kind, scope },
      });
      return data;
    },
  });
}

/** GET /timelines/orders/:id — one order plus its full event history. */
export function useOrderDetail(id: string | null) {
  return useQuery({
    queryKey: [TIMELINES_KEY, "order", id],
    enabled: !!id,
    queryFn: async () => {
      const { data } = await api.get<CustomOrderDetail>(
        `/timelines/orders/${id}`,
      );
      return data;
    },
  });
}

/** GET /timelines/replenishment — factory→store stock movement, store-scoped. */
export function useReplenishment() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [TIMELINES_KEY, "replenishment", storeId],
    queryFn: async () => {
      const { data } = await api.get<Replenishment[]>(
        "/timelines/replenishment",
      );
      return data;
    },
  });
}
