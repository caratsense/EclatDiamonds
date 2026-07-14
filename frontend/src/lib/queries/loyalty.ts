"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useSession } from "@/store/use-session";
import type {
  PayoutType,
  Referral,
  ReferralCode,
  SchemeMember,
  SchemePlan,
} from "@/lib/mock/loyalty";

/**
 * Module 17 — Loyalty & Gold Savings Scheme.
 * Plans are global templates; members are store-scoped recurring-deposit
 * accounts with derived paid/missed installment counts. The members query is
 * keyed on the active store id for store-switcher refetch.
 */

export const loyaltyKeys = {
  all: ["loyalty"] as const,
  plans: ["loyalty", "plans"] as const,
  members: (storeId: string) => ["loyalty", "members", storeId] as const,
};

/** GET /loyalty/plans — scheme-plan templates (not store-scoped). */
export function useSchemePlans() {
  return useQuery({
    queryKey: loyaltyKeys.plans,
    queryFn: async () => {
      const { data } = await api.get<SchemePlan[]>("/loyalty/plans");
      return data;
    },
  });
}

/** GET /loyalty/members — enrolled accounts with paid/missed + maturity. */
export function useSchemeMembers() {
  const storeId = useSession((s) => s.currentStore.id);
  return useQuery({
    queryKey: loyaltyKeys.members(storeId),
    queryFn: async () => {
      const { data } = await api.get<SchemeMember[]>("/loyalty/members");
      return data;
    },
  });
}

export interface EnrollMemberInput {
  storeId: string;
  customerName: string;
  phone?: string;
  planId: string;
  /** Monthly installment amount (INR). */
  installment: number;
}

/** POST /loyalty/members — enroll a member; server generates the schedule. */
export function useEnrollMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EnrollMemberInput) => {
      const { data } = await api.post<SchemeMember>("/loyalty/members", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: loyaltyKeys.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  "Earn with Éclat" referral / commission program                       */
/* -------------------------------------------------------------------------- */

export const referralKeys = {
  codes: ["referral-codes"] as const,
  referrals: (codeId: string) => ["referrals", codeId] as const,
  wallet: (codeId: string) => ["referral-wallet", codeId] as const,
};

/** GET /loyalty/referral-codes — all referrer coupon codes + balances. */
export function useReferralCodes() {
  return useQuery({
    queryKey: referralKeys.codes,
    queryFn: async () => {
      const { data } = await api.get<ReferralCode[]>("/loyalty/referral-codes");
      return data;
    },
  });
}

export interface CreateReferralCodeInput {
  referrerName: string;
  referrerPhone?: string;
  /** Usage cap; omit for an uncapped code. */
  maxUses?: number;
  storeId?: string;
}

/** POST /loyalty/referral-codes — mint a coupon code for a referrer. */
export function useCreateReferralCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateReferralCodeInput) => {
      const { data } = await api.post<ReferralCode>(
        "/loyalty/referral-codes",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: referralKeys.codes });
    },
  });
}

/** GET /loyalty/referrals?codeId= — redemptions for one code (its ledger). */
export function useReferrals(codeId: string | null) {
  return useQuery({
    queryKey: referralKeys.referrals(codeId ?? ""),
    queryFn: async () => {
      const { data } = await api.get<Referral[]>("/loyalty/referrals", {
        params: { codeId },
      });
      return data;
    },
    enabled: !!codeId,
  });
}

export interface ApplyReferralInput {
  code: string;
  refereeName: string;
  refereePhone?: string;
  /** Referee's total bill (₹). */
  billAmount: number;
  storeId?: string;
  /** Round-2 — the sale's invoice number. */
  invoiceNo?: string;
  /** Round-2 — bill date, yyyy-mm-dd. */
  billDate?: string;
}

/* -------------------------------------------------------------------------- */
/*  Referrer wallet (detailed ledger)                                          */
/* -------------------------------------------------------------------------- */

export interface ReferralWallet {
  code: {
    id: string;
    code: string;
    referrerName: string;
    referrerPhone: string;
    commissionBalance: number;
  };
  referrals: {
    id: string;
    refereeName: string;
    billDate: string | null;
    invoiceNo: string | null;
    billAmount: number;
    commissionAmount: number;
    createdAt: string;
  }[];
  payouts: {
    id: string;
    type: PayoutType;
    invoiceNo: string | null;
    amount: number;
    createdAt: string;
  }[];
  totals: {
    totalWallet: number;
    redeemed: number;
    balance: number;
  };
}

/** GET /loyalty/referral-codes/:id/wallet — a code's full wallet (newest first). */
export function useReferralWallet(codeId: string | null) {
  return useQuery({
    queryKey: referralKeys.wallet(codeId ?? ""),
    enabled: !!codeId,
    queryFn: async () => {
      const { data } = await api.get<ReferralWallet>(
        `/loyalty/referral-codes/${codeId}/wallet`,
      );
      return data;
    },
  });
}

/**
 * POST /loyalty/referrals — apply a code at a sale. Computes the referee's 5%
 * diamond discount and credits the referrer 5% of the total bill. The API
 * returns 400 when the code's usage limit is reached — callers surface the
 * message inline. Invalidates both the codes list and that code's ledger.
 */
export function useApplyReferral() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApplyReferralInput) => {
      const { data } = await api.post<Referral>("/loyalty/referrals", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: referralKeys.codes });
      qc.invalidateQueries({ queryKey: ["referrals"] });
      qc.invalidateQueries({ queryKey: ["referral-wallet"] });
    },
  });
}

export interface PayoutInput {
  codeId: string;
  amount: number;
  type: PayoutType;
  /** Round-2 — invoice the commission was redeemed against. */
  invoiceNo?: string;
}

/**
 * POST /loyalty/referral-codes/:id/payout — redeem or cash out accrued
 * commission. The API returns 400 when `amount` exceeds the balance.
 */
export function usePayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ codeId, amount, type, invoiceNo }: PayoutInput) => {
      const { data } = await api.post<{ balanceAfter: number }>(
        `/loyalty/referral-codes/${codeId}/payout`,
        { amount, type, invoiceNo },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: referralKeys.codes });
      qc.invalidateQueries({ queryKey: ["referral-wallet"] });
    },
  });
}
