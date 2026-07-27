"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useSession } from "@/store/use-session";
import type {
  ChosenOption,
  ReturnRecord,
  ReturnType,
} from "@/lib/mock/returns";

/**
 * Module 14 — Returns / Exchange / Buyback.
 *
 * The store manager enters the ORIGINAL bill (gold + diamond + making) and the
 * server values it at TODAY's rates: gold at 100% for both options, diamond at
 * 100% for exchange but 80% for buyback (cash). Making & GST are never returned.
 *
 * Gold rate is daily/auto; the diamond rate table is maintained by Head Office
 * (`/returns/diamond-rates`). Every list query is keyed on the active store id
 * so switching the store in the topbar auto-refetches.
 */

export const returnKeys = {
  all: ["returns"] as const,
  list: (storeId: string) => ["returns", "list", storeId] as const,
  rates: ["returns", "rates"] as const,
  diamondRates: ["returns", "diamond-rates"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Rates                                                                      */
/* -------------------------------------------------------------------------- */

export interface GoldRate {
  karat: number;
  ratePerGram: number;
}

export interface DiamondRate {
  spec: string;
  ratePerCarat: number;
}

export interface RatesResponse {
  gold: GoldRate[];
  diamond: DiamondRate[];
}

/** GET /returns/rates — today's gold rates + the current diamond rate table. */
export function useRates() {
  return useQuery({
    queryKey: returnKeys.rates,
    queryFn: async () => {
      const { data } = await api.get<RatesResponse>("/returns/rates");
      return data;
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Live valuation (no persist)                                               */
/* -------------------------------------------------------------------------- */

export interface ValuateInput {
  goldWtG?: number;
  goldRateAtPurchase?: number;
  diaCarat?: number;
  diaSpec?: string;
  diaRateAtPurchase?: number;
  making?: number;
  /** Optional overrides — normally the server supplies today's rates. */
  todayGoldRate?: number;
  todayDiaRate?: number;
  /** How the piece was entered. Default 'manual'; 'invoice' requires invoiceNo. */
  entryMode?: "invoice" | "manual";
  invoiceNo?: string;
  purchaseDiscountType?: string;
  purchaseDiscountValue?: number;
}

export interface ValuationResult {
  todayGoldRate: number;
  todayDiaRate: number;
  goldValueToday: number;
  diaValueToday: number;
  exchangeValue: number;
  buybackValue: number;
  breakdown: {
    makingReturned: number;
    gstReturned: number;
  };
}

/** POST /returns/valuate — a live preview; never persisted. */
export async function valuateReturn(
  input: ValuateInput,
): Promise<ValuationResult> {
  const { data } = await api.post<ValuationResult>("/returns/valuate", input);
  return data;
}

/**
 * useValuate — thin mutation wrapper around POST /returns/valuate. The calculator
 * calls `mutate(input)` on a debounce and reads back `data` / `isPending`.
 */
export function useValuate() {
  return useMutation({
    mutationFn: valuateReturn,
  });
}

/* -------------------------------------------------------------------------- */
/*  List + create                                                             */
/* -------------------------------------------------------------------------- */

/** GET /returns — returns / exchanges / buybacks for the active store. */
export function useReturns() {
  const storeId = useSession((s) => s.currentStore.id);
  return useQuery({
    queryKey: returnKeys.list(storeId),
    queryFn: async () => {
      const { data } = await api.get<ReturnRecord[]>("/returns");
      return data;
    },
  });
}

export interface CreateReturnInput {
  storeId: string;
  customerName: string;
  phone?: string;
  type: ReturnType;
  item?: string;
  goldWtG?: number;
  goldRateAtPurchase?: number;
  diaCarat?: number;
  diaSpec?: string;
  diaRateAtPurchase?: number;
  making?: number;
  chosenOption: ChosenOption;
  reason?: string;
  /** How the piece was entered. Default 'manual'; 'invoice' requires invoiceNo. */
  entryMode?: "invoice" | "manual";
  invoiceNo?: string;
  purchaseDiscountType?: string;
  purchaseDiscountValue?: number;
}

/**
 * POST /returns — raise a return/exchange. The server re-values at today's rates
 * and creates the record as `pending_approval` (Head Office must approve).
 */
export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateReturnInput) => {
      const { data } = await api.post<ReturnRecord>("/returns", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: returnKeys.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Head-Office approval                                                       */
/* -------------------------------------------------------------------------- */

/** PATCH /returns/:id/approve — Head Office only. */
export function useApproveReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.patch<ReturnRecord>(`/returns/${id}/approve`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: returnKeys.all });
    },
  });
}

/**
 * PATCH /returns/:id/reject — Head Office only. Accepts an optional `note`
 * (reason) that populates the "Note from approver" line on the record.
 */
export function useRejectReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note?: string }) => {
      const { data } = await api.patch<ReturnRecord>(
        `/returns/${id}/reject`,
        note ? { note } : {},
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: returnKeys.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Diamond-rate admin (Head Office)                                          */
/* -------------------------------------------------------------------------- */

/** GET /returns/diamond-rates — the HO-maintained diamond rate table. */
export function useDiamondRates() {
  return useQuery({
    queryKey: returnKeys.diamondRates,
    queryFn: async () => {
      const { data } = await api.get<DiamondRate[]>("/returns/diamond-rates");
      return data;
    },
  });
}

export interface AddDiamondRateInput {
  spec: string;
  ratePerCarat: number;
}

/** POST /returns/diamond-rates — add / update a diamond rate (HO only). */
export function useAddDiamondRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddDiamondRateInput) => {
      const { data } = await api.post<DiamondRate>(
        "/returns/diamond-rates",
        input,
      );
      return data;
    },
    onSuccess: () => {
      // Refresh both the rate table and the /rates readout that feeds the calc.
      qc.invalidateQueries({ queryKey: returnKeys.diamondRates });
      qc.invalidateQueries({ queryKey: returnKeys.rates });
    },
  });
}
