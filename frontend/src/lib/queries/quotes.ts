"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Quote, QuoteKind, QuoteLine } from "@/lib/mock/quotation";

export interface CreateQuoteInput {
  storeId: string;
  customerName: string;
  phone?: string;
  validUntil?: string;
  redeemableStoreIds?: string[];
  /** Sale (default) vs repair (making-only). */
  kind?: QuoteKind;
  /** Free-text remarks (repair notes). */
  remarks?: string;
  /** Gross intake weight in grams (repair). */
  grossWeightG?: number;
  /** Kaccha ("@") estimate — server forces GST = 0 and hides it from the list. */
  isKaccha?: boolean;
  lines: Omit<QuoteLine, "id">[];
}

/**
 * GET /quotes — portable quotes raised at or redeemable to the active store.
 * Kaccha estimates are excluded server-side by default; pass
 * `{ includeKaccha: true }` to opt back in (the backend gates this to
 * head-office, so it's safe to always send when the toggle is on).
 */
export function useQuotes(opts: { includeKaccha?: boolean } = {}) {
  const storeId = useStoreKey();
  const includeKaccha = opts.includeKaccha ?? false;
  return useQuery({
    queryKey: ["quotes", storeId, { includeKaccha }],
    queryFn: async () => {
      const { data } = await api.get<Quote[]>("/quotes", {
        params: includeKaccha ? { includeKaccha: "true" } : undefined,
      });
      return data;
    },
  });
}

/** POST /quotes — create a quote with priced lines. */
export function useCreateQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateQuoteInput) => {
      const { data } = await api.post<Quote>("/quotes", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
    },
  });
}

/**
 * POST /quotes/:id/photo — attach a reference photo to a quote. Sends multipart
 * form-data (field `file`, optional text `label`); returns the updated quote.
 * Mirrors {@link useUploadOrderImage} in timelines.ts.
 */
export function useUploadQuotePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      file,
      label,
    }: {
      id: string;
      file: File;
      label?: string;
    }) => {
      const form = new FormData();
      form.append("file", file);
      if (label) form.append("label", label);
      const { data } = await api.post<Quote>(`/quotes/${id}/photo`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
    },
  });
}

/** Custom-order fields captured when converting a quote into a timeline order. */
export interface ConvertQuoteInput {
  id: string;
  ringSize?: string;
  bangleSize?: string;
  metalColor?: string;
  /** yyyy-mm-dd promised delivery date. */
  deliveryDate?: string;
  advanceReceived?: number;
  /** cash | card | upi | bank. */
  advanceMode?: string;
}

/** Shape returned by POST /quotes/:id/convert-to-order. */
export interface ConvertQuoteResult {
  order: { id: string; ref: string };
  quote: Quote;
}

/**
 * POST /quotes/:id/convert-to-order — accepts the quote and creates the linked
 * timeline CustomOrder. Invalidates both the quotes list (status → accepted)
 * and the timeline orders list so the new CO- appears immediately.
 */
export function useConvertQuoteToOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: ConvertQuoteInput) => {
      const { data } = await api.post<ConvertQuoteResult>(
        `/quotes/${id}/convert-to-order`,
        body,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["timelines", "orders"] });
    },
  });
}

/* ------------------------------------------------------- manager approval */

/** Whether a quote may go to the customer yet — the same gate sharing enforces. */
export interface QuoteApprovalGate {
  required: boolean;
  cleared: boolean;
  reason: string | null;
}

export interface PendingQuoteApproval {
  id: string;
  ref: string;
  customerName: string;
  amount: number;
  requestedAt: string | null;
  requestedByName: string | null;
  requestedById: string | null;
  storeName: string | null;
}

export interface QuoteApprovalSettings {
  /** Quotes at or above this grand total need a manager. `null` = approval off. */
  valueThreshold: number | null;
  allowSelfApproval: boolean;
}

/** GET /quotes/:id/approval */
export function useQuoteApproval(id: string | null) {
  return useQuery({
    queryKey: ["quotes", "approval", id],
    enabled: !!id,
    queryFn: async () => (await api.get<QuoteApprovalGate>(`/quotes/${id}/approval`)).data,
  });
}

/** GET /quotes/approval/pending — store manager and head office. */
export function usePendingQuoteApprovals(enabled: boolean) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["quotes", "approval", "pending", storeId],
    enabled,
    queryFn: async () =>
      (await api.get<PendingQuoteApproval[]>("/quotes/approval/pending")).data,
  });
}

/** POST /quotes/:id/request-approval */
export function useRequestQuoteApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/quotes/${id}/request-approval`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["quotes"] }),
  });
}

/** POST /quotes/:id/decide — a reason is required to reject. */
export function useDecideQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; approve: boolean; reason?: string }) =>
      (
        await api.post(`/quotes/${input.id}/decide`, {
          approve: input.approve,
          reason: input.reason,
        })
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["quotes"] }),
  });
}

/** GET /quotes/approval/settings */
export function useQuoteApprovalSettings(enabled: boolean) {
  return useQuery({
    queryKey: ["quotes", "approval", "settings"],
    enabled,
    queryFn: async () =>
      (await api.get<QuoteApprovalSettings>("/quotes/approval/settings")).data,
  });
}

/** PUT /quotes/approval/settings — head office. */
export function useSaveQuoteApprovalSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<QuoteApprovalSettings>) =>
      (await api.put<QuoteApprovalSettings>("/quotes/approval/settings", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["quotes"] }),
  });
}
