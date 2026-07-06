"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Sale, SaleDocType, SalePaymentMode } from "@/lib/mock/sales";

/**
 * Direct-sales format + payment capture (client call § "Sales (Direct Sales)"
 * and Module 12 — Payment Collection, folded into Sales & Orders).
 *
 * Every list query is keyed on the active store id so switching the store in
 * the topbar auto-refetches (store scoping is applied server-side via the
 * X-Store-Id header). Mutations invalidate the whole `["sales"]` tree.
 */

const SALES_KEY = "sales";

/** manual = direct sales entered here · all = every sale (incl. from orders). */
export type SaleScope = "manual" | "all";

/** GET /sales?scope=manual|all — direct sales for the active store. */
export function useSales(scope: SaleScope = "manual") {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [SALES_KEY, "list", storeId, scope],
    queryFn: async () => {
      const { data } = await api.get<Sale[]>("/sales", { params: { scope } });
      return data;
    },
  });
}

/** One payment posted against a sale (GET /sales/:id). */
export interface SalePayment {
  id: string;
  amount: number;
  mode: string;
  /** ISO datetime of the receipt. */
  date: string;
  reference?: string;
}

export type SaleDetail = Sale & { payments: SalePayment[] };

/** GET /sales/:id — one sale plus its payment history. */
export function useSaleDetail(id: string | null) {
  return useQuery({
    queryKey: [SALES_KEY, "detail", id],
    enabled: !!id,
    queryFn: async () => {
      const { data } = await api.get<SaleDetail>(`/sales/${id}`);
      return data;
    },
  });
}

export interface CreateSaleInput {
  storeId: string;
  customerName: string;
  description?: string;
  invoiceNo: string;
  salesValue: number;
  afterDiscountValue: number;
  paymentMode?: SalePaymentMode;
  advanceReceived?: number;
}

/** POST /sales — record a direct sale. Returns the created sale (with id). */
export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSaleInput) => {
      const { data } = await api.post<Sale>("/sales", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [SALES_KEY] });
    },
  });
}

/**
 * POST /sales/:id/{quotation|invoice|receipt} — attach a counter photo.
 * Sends multipart form-data (field `file`); returns the updated sale.
 */
export function useUploadSaleDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      doc,
      file,
    }: {
      id: string;
      doc: SaleDocType;
      file: File;
    }) => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post<Sale>(`/sales/${id}/${doc}`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [SALES_KEY] });
    },
  });
}
