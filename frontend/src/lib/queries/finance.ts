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

/** Full ledger-kind enum accepted by POST /finance/ledger. */
export type LedgerKind =
  | "AR"
  | "AP"
  | "expense"
  | "income"
  | "asset"
  | "liability";

export interface CreateLedgerEntryInput {
  storeId: string;
  kind: LedgerKind;
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

export interface ExpenseBreakdown {
  total: number;
  items: { account: string; amount: number }[];
}

/** GET /finance/expenses — operating-expense breakdown behind the OpEx KPI. */
export function useFinanceExpenses(enabled: boolean) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["finance", "expenses", storeId],
    enabled,
    queryFn: async () => {
      const { data } = await api.get<ExpenseBreakdown>("/finance/expenses");
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
      // A new entry shifts the ledger list, the MTD summary cards, and (for
      // budget/forecast/expense rows) the budget-variance and cash-flow charts.
      qc.invalidateQueries({ queryKey: ["finance", "ledger"] });
      qc.invalidateQueries({ queryKey: ["finance", "summary"] });
      qc.invalidateQueries({ queryKey: ["finance", "budget"] });
      qc.invalidateQueries({ queryKey: ["finance", "cashflow"] });
    },
  });
}
