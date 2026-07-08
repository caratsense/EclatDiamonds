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
  lines: Omit<QuoteLine, "id">[];
}

/** GET /quotes — portable quotes raised at or redeemable to the active store. */
export function useQuotes() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["quotes", storeId],
    queryFn: async () => {
      const { data } = await api.get<Quote[]>("/quotes");
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
