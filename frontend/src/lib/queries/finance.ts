"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  BudgetActual,
  CashFlowPoint,
  LedgerEntry,
  MisCard,
} from "@/lib/mock/finance";

export interface CreateLedgerEntryInput {
  storeId: string;
  kind: "AR" | "AP";
  side: "debit" | "credit";
  amount: number;
  entryDate?: string;
  narration?: string;
  partyId?: string;
  status?: string;
}

/**
 * Module 4 — Finance & Fund Planning query hooks.
 * Every query is keyed on the active store id (via useStoreKey) so switching
 * the store in the topbar refetches automatically; the api interceptor sends
 * the matching X-Store-Id header. Query keys are defined locally on purpose.
 */

/** GET /finance/summary — P&L / MIS summary cards (MTD), store-scoped. */
export function useFinanceSummary() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["finance", "summary", storeId],
    queryFn: async () => {
      const { data } = await api.get<MisCard[]>("/finance/summary");
      return data;
    },
  });
}

/** GET /finance/budget — budget-vs-actual per store/region (MTD). */
export function useFinanceBudget() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["finance", "budget", storeId],
    queryFn: async () => {
      const { data } = await api.get<BudgetActual[]>("/finance/budget");
      return data;
    },
  });
}

/** GET /finance/cashflow — 6-month inflow vs outflow forecast. */
export function useFinanceCashflow() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["finance", "cashflow", storeId],
    queryFn: async () => {
      const { data } = await api.get<CashFlowPoint[]>("/finance/cashflow");
      return data;
    },
  });
}

/** GET /finance/ledger — AP/AR general-ledger rows, store-scoped. */
export function useFinanceLedger() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["finance", "ledger", storeId],
    queryFn: async () => {
      const { data } = await api.get<LedgerEntry[]>("/finance/ledger");
      return data;
    },
  });
}

/** POST /finance/ledger — record a new AP/AR ledger entry against the active store. */
export function useAddLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateLedgerEntryInput) => {
      const { data } = await api.post<LedgerEntry>("/finance/ledger", input);
      return data;
    },
    onSuccess: () => {
      // New entry shifts the ledger list and the MTD summary cards.
      qc.invalidateQueries({ queryKey: ["finance", "ledger"] });
      qc.invalidateQueries({ queryKey: ["finance", "summary"] });
    },
  });
}
