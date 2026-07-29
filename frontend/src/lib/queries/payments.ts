"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";

/**
 * Module 12 — Payment Collection Tracking query hooks.
 * Keyed on the active store id so the topbar store switcher refetches.
 * The backend already store-scopes server-side via X-Store-Id, so the list
 * comes back pre-filtered (no client-side store filtering needed).
 *
 * `mode` is returned as a human label (e.g. "UPI", "Net Banking",
 * "Gold Exchange") so we type it as a plain string rather than the narrow
 * mock union — the UI maps unknown modes to a neutral badge variant.
 */

export interface CollectionRow {
  id: string;
  /** ISO datetime of the receipt. */
  date: string;
  customer: string;
  ref: string;
  mode: string;
  amount: number;
  storeId: string;
  storeName: string;
  /**
   * Who recorded the collection. Null on rows imported by the legacy SJEP sync,
   * which have no Eclat user behind them. This is the field that makes a till
   * dispute answerable — without it a line is just an anonymous amount.
   */
  recordedBy?: string | null;
  recordedById?: string | null;
  reconciled?: boolean;
}

/** Mirrors the backend `PaymentMode` enum (snake-case enum values). */
export type PaymentMode =
  | "cash"
  | "card"
  | "upi"
  | "net_banking"
  | "online"
  | "cheque"
  | "gold_exchange"
  | "old_gold";


export interface RecordPaymentInput {
  storeId: string;
  amount: number;
  mode: PaymentMode;
  reference?: string;
  partyId?: string;
  saleId?: string;
  paidAt?: string;
}

export type ReconStatus = "Matched" | "Unmatched" | "Pending";

export interface ReconRow {
  id: string;
  date: string;
  mode: string;
  storeName: string;
  storeReported: number;
  /** Absent until the bank statement settles the line. */
  bankStatement?: number;
  status: ReconStatus;
}

/** GET /payments — collections ledger, store-scoped server-side. */
export function usePayments() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["payments", "list", storeId],
    queryFn: async () => {
      const { data } = await api.get<CollectionRow[]>("/payments");
      return data;
    },
  });
}

/** POST /payments — record a collection against the active store. */
export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordPaymentInput) => {
      const { data } = await api.post<CollectionRow>("/payments", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments", "list"] });
      qc.invalidateQueries({ queryKey: ["payments", "reconciliation"] });
    },
  });
}

/** GET /payments/reconciliation — store-reported vs bank-statement settlement. */
export function usePaymentReconciliation() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["payments", "reconciliation", storeId],
    queryFn: async () => {
      const { data } = await api.get<ReconRow[]>("/payments/reconciliation");
      return data;
    },
  });
}
