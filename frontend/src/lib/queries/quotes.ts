"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AxiosError } from "axios";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Quote, QuoteBillTo, QuoteKind, QuoteLine, QuotePayment } from "@/lib/mock/quotation";

export interface CreateQuoteInput {
  storeId: string;
  customerName: string;
  /** Indian mobile or international (+, 8-15 digits). */
  phone?: string;
  /** The customer's own address, printed under their name on the quote. */
  customerAddress?: string;
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
  /** One % off making + diamonds (never gold), for callers without the split below. */
  discountPercent?: number;
  /** % off making, % off diamonds and stones, and a flat amount off at the end. */
  makingDiscountPercent?: number;
  stoneDiscountPercent?: number;
  additionalDiscount?: number;
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

/**
 * PATCH /quotes/:id/details — the customer's address, the bill-to box and the
 * payments after the quote is saved. Not the price: the revision stays as it is.
 */
export function useUpdateQuoteDetails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      /** Empty string clears it; left out, it stays. */
      customerAddress?: string;
      billTo?: QuoteBillTo;
      payments?: QuotePayment[];
    }) =>
      (await api.patch<Quote>(`/quotes/${id}/details`, body)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["quotes"] }),
  });
}

/** Body for PATCH /quotes/:id — the price itself, unlike the details PATCH above. */
export interface UpdateQuoteInput {
  id: string;
  /** Replaces ALL lines — the server re-prices from these. */
  lines?: Omit<QuoteLine, "id">[];
  makingDiscountPercent?: number;
  stoneDiscountPercent?: number;
  additionalDiscount?: number;
  /** yyyy-mm-dd, or empty to clear. */
  validUntil?: string;
  remarks?: string;
}

/**
 * PATCH /quotes/:id — re-price a saved quote. Every accepted edit bumps the
 * revision. Refused once the quote is accepted.
 */
export function useUpdateQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateQuoteInput) =>
      (await api.patch<Quote>(`/quotes/${id}`, body)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["quotes"] }),
  });
}

/** DELETE /quotes/:id — managers and above; an accepted quote is refused. */
export function useDeleteQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete<{ deleted: boolean }>(`/quotes/${id}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["quotes"] }),
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

/* ------------------------------------------------------------ quote PDF */

/**
 * GET /quotes/:id/pdf — download the detailed quote.
 *
 * `responseType: "blob"` means a refusal also arrives as a Blob, which would hide
 * the server's reason behind a generic toast; it is read back into JSON so
 * `apiErrorMessage` can show it.
 */
export function useDownloadQuotePdf() {
  return useMutation({
    mutationFn: async (id: string) => {
      let res;
      try {
        res = await api.get<Blob>(`/quotes/${id}/pdf`, { responseType: "blob" });
      } catch (e) {
        if (e instanceof AxiosError && e.response?.data instanceof Blob) {
          try {
            e.response.data = JSON.parse(await e.response.data.text());
          } catch {
            // Not JSON: leave it, the caller falls back to its own sentence.
          }
        }
        throw e;
      }
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "quote.pdf";
      const url = URL.createObjectURL(res.data);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      return { filename };
    },
  });
}

/** Shape returned by POST /quotes/:id/send-pdf. Queued is not sent. */
export interface SendQuotePdfResult {
  queued: boolean;
  ref: string;
  revision: number;
  messageId: string;
  status: string;
  /** WhatsApp is not connected: the message will fail with the reason, not send. */
  dryRun: boolean;
}

/**
 * POST /quotes/:id/send-pdf — queue the PDF on WhatsApp: to the quote's own
 * customer, or to a different number the sender typed (string form keeps the
 * detail dialog's one-argument call working).
 */
export function useSendQuotePdf() {
  return useMutation({
    mutationFn: async (input: string | { id: string; to?: string }) => {
      const { id, to } = typeof input === "string" ? { id: input, to: undefined } : input;
      return (
        await api.post<SendQuotePdfResult>(`/quotes/${id}/send-pdf`, to ? { to } : {})
      ).data;
    },
  });
}
