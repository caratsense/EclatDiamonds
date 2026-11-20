"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Sale, SaleDocType, SalePaymentMode } from "@/lib/mock/sales";
import type { Role } from "@/lib/types";

/**
 * Direct-sales format + payment capture (client call § "Sales (Direct Sales)"
 * and Module 12 — Payment Collection, folded into Sales & Orders).
 *
 * Every list query is keyed on the active store id so switching the store in
 * the topbar auto-refetches (store scoping is applied server-side via the
 * X-Store-Id header). Mutations invalidate the whole `["sales"]` tree.
 */

const SALES_KEY = "sales";

/**
 * A bill is the input to almost every figure on the dashboard — the KPI tiles,
 * the twelve-month trend, the store comparison (which the Store Comparison page
 * reads under `["dashboard","charts","all-stores"]`) and the day-by-day activity
 * flow. None of those were invalidated here, so billing a sale left the
 * dashboard showing the pre-sale figures for the whole of React Query's default
 * stale window: the shop recorded a sale and the chart said it had not.
 *
 * It is also the input to the DSR, whose headline tiles and per-store revenue
 * bars are the same Sale rows read for the store's own today; and, when the
 * bill carries an advance, the server writes a Payment alongside it
 * (sales.service.ts `create`), which is what the collections ledger and the
 * payment-mode donut on both the Payments and DSR screens are drawn from. A
 * cash sale therefore landed in the till without appearing in the mode split.
 *
 * Scoped to the derived feeds rather than the whole `["dashboard"]` tree, which
 * would also drop the task and hand-off lists a sale cannot change.
 */
function invalidateSalesDerived(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: [SALES_KEY] });
  qc.invalidateQueries({ queryKey: ["dashboard", "kpis"] });
  qc.invalidateQueries({ queryKey: ["dashboard", "charts"] });
  qc.invalidateQueries({ queryKey: ["dashboard", "activity"] });
  qc.invalidateQueries({ queryKey: ["payments"] });
  qc.invalidateQueries({ queryKey: ["reporting", "dsr"] });
}

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

/** One piece on a bill (GET /sales/:id). Amounts are null where the source had none. */
export interface SaleLineRow {
  id: string;
  description: string | null;
  netWeight: number | null;
  metalAmount: number | null;
  makingAmount: number | null;
  stoneAmount: number | null;
  discountAmount: number | null;
  lineTotal: number;
}

export type SaleDetail = Sale & { payments: SalePayment[]; lines?: SaleLineRow[] };

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
  /**
   * Optional. When supplied, the sale is linked to a real customer record and
   * appears on their Customer 360 timeline; without it the sale is recorded
   * exactly as before, with the name kept as a historical snapshot. Never
   * required — a customer who declines to give a number must still be billable.
   */
  phone?: string;
  description?: string;
  invoiceNo: string;
  salesValue: number;
  /** Optional — omit for a no-discount sale (backend defaults total = salesValue). */
  afterDiscountValue?: number;
  /** Discount split (gold is never discounted). Send only when discounting. */
  diamondValue?: number;
  makingValue?: number;
  diamondDiscountPercent?: number;
  makingDiscountPercent?: number;
  paymentMode?: SalePaymentMode;
  advanceReceived?: number;
  /**
   * Set to an approved-but-unbilled discount request id to complete that
   * over-cap sale. The backend verifies the request is approved, in-scope,
   * unused, and that the applied %s stay within the approved amounts (so it
   * does NOT re-escalate).
   */
  discountRequestId?: string;
}

/**
 * When the discount exceeds the salesperson's cap the backend creates NO sale
 * and returns this instead — the discount is queued for approval.
 */
export interface SaleApprovalRequired {
  requiresApproval: true;
  discountRequest: { ref: string; requiredRole: Role; status: string; id: string };
  message: string;
}

export type CreateSaleResult = Sale | SaleApprovalRequired;

export function isApprovalRequired(
  r: CreateSaleResult,
): r is SaleApprovalRequired {
  return (r as SaleApprovalRequired).requiresApproval === true;
}

/**
 * POST /sales — record a direct sale. Returns the created sale, OR a
 * `{ requiresApproval }` payload when the discount exceeds the caller's cap
 * (in which case no sale was created — see `isApprovalRequired`).
 */
export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSaleInput) => {
      const { data } = await api.post<CreateSaleResult>("/sales", input);
      return data;
    },
    onSuccess: () => {
      invalidateSalesDerived(qc);
      // Completing an approved request marks it billed (saleId set) and a
      // fresh over-cap attempt queues a new request — refresh both lists.
      qc.invalidateQueries({ queryKey: ["discounts"] });
    },
  });
}

/**
 * POST /sales/:id/cancel — soft-void a sale (store manager + head office only).
 * Returns the updated sale (`isCancelled: true`).
 */
export function useCancelSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data } = await api.post<Sale>(`/sales/${id}/cancel`, { reason });
      return data;
    },
    // A void removes the bill from every aggregate too — the charts exclude
    // `isCancelled` rows, so they are as wrong after a void as after a sale.
    onSuccess: () => invalidateSalesDerived(qc),
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
