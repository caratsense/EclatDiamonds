"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Quote, QuoteLine } from "@/lib/mock/quotation";

export interface CreateQuoteInput {
  storeId: string;
  customerName: string;
  phone?: string;
  validUntil?: string;
  redeemableStoreIds?: string[];
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
