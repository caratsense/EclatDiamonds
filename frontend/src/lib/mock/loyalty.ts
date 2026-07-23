/**
 * Mock seed data for Module 17 — Loyalty & Gold Savings Scheme.
 * Recurring monthly-deposit accounts with maturity bonus + default flags.
 * Replace with react-query hooks against the NestJS API in a later phase.
 */

export type SchemeStatus = "active" | "matured" | "defaulted" | "closed";

export const SCHEME_STATUS_LABELS: Record<SchemeStatus, string> = {
  active: "Active",
  matured: "Matured",
  defaulted: "Defaulted",
  closed: "Closed",
};

/**
 * Savings-plan templates. `bonusMonths` is the store's contribution —
 * e.g. pay 11, get 12 months' worth of buying power.
 */
export interface SchemePlan {
  id: string;
  name: string;
  /** Total tenure in months. */
  tenureMonths: number;
  /** Store-funded bonus expressed as extra installments at maturity. */
  bonusMonths: number;
  /** Equivalent maturity discount, shown to the customer. */
  bonusLabel: string;
  /** Suggested monthly amount, pre-filled at enrollment (null = per member). */
  defaultInstallment?: number | null;
  /** Retired plans stay for history but are hidden from new enrollments. */
  isActive?: boolean;
}

export const SCHEME_PLANS: SchemePlan[] = [
  {
    id: "plan-11p1",
    name: "11+1 Gold Scheme",
    tenureMonths: 11,
    bonusMonths: 1,
    bonusLabel: "Pay 11, get 12 — one month free",
  },
  {
    id: "plan-11p2",
    name: "11+2 Gold Scheme",
    tenureMonths: 11,
    bonusMonths: 2,
    bonusLabel: "Pay 11, get 13 — two months bonus",
  },
  {
    id: "plan-24p3",
    name: "24+3 Gold Scheme",
    tenureMonths: 24,
    bonusMonths: 3,
    bonusLabel: "24 months + 3 bonus installments",
  },
];

export interface SchemeMember {
  id: string;
  ref: string;
  storeId: string;
  customer: string;
  phone: string;
  planId: string;
  /** Monthly installment amount (₹). */
  installment: number;
  /** Tenure in months for this account (snapshot of plan). */
  tenureMonths: number;
  /** Bonus installments funded by the store at maturity. */
  bonusMonths: number;
  /** Months paid so far. */
  paidMonths: number;
  /** Of the months that were due, how many were missed. */
  missedMonths: number;
  enrolledAt: string;
  status: SchemeStatus;
}

export const MOCK_SCHEME_MEMBERS: SchemeMember[] = [
  {
    id: "gss-3001",
    ref: "GSS-2026-3001",
    storeId: "surat-main",
    customer: "Priya Sharma",
    phone: "+91 98250 11223",
    planId: "plan-11p1",
    installment: 10000,
    tenureMonths: 11,
    bonusMonths: 1,
    paidMonths: 7,
    missedMonths: 0,
    enrolledAt: "2025-11-05T00:00:00+05:30",
    status: "active",
  },
  {
    id: "gss-3002",
    ref: "GSS-2026-3002",
    storeId: "surat-main",
    customer: "Vikram Joshi",
    phone: "+91 98980 22110",
    planId: "plan-11p2",
    installment: 25000,
    tenureMonths: 11,
    bonusMonths: 2,
    paidMonths: 4,
    missedMonths: 2,
    enrolledAt: "2025-12-01T00:00:00+05:30",
    status: "active",
  },
  {
    id: "gss-3003",
    ref: "GSS-2026-3003",
    storeId: "mumbai-bandra",
    customer: "Fatima Khan",
    phone: "+91 98191 77889",
    planId: "plan-24p3",
    installment: 15000,
    tenureMonths: 24,
    bonusMonths: 3,
    paidMonths: 23,
    missedMonths: 0,
    enrolledAt: "2024-07-10T00:00:00+05:30",
    status: "active",
  },
  {
    id: "gss-3004",
    ref: "GSS-2026-3004",
    storeId: "ahmedabad-cg",
    customer: "Sneha Patel",
    phone: "+91 97250 33445",
    planId: "plan-11p1",
    installment: 5000,
    tenureMonths: 11,
    bonusMonths: 1,
    paidMonths: 3,
    missedMonths: 3,
    enrolledAt: "2025-10-18T00:00:00+05:30",
    status: "defaulted",
  },
  {
    id: "gss-3005",
    ref: "GSS-2026-3005",
    storeId: "mumbai-bandra",
    customer: "Rohan Gupta",
    phone: "+91 99670 88221",
    planId: "plan-11p1",
    installment: 20000,
    tenureMonths: 11,
    bonusMonths: 1,
    paidMonths: 11,
    missedMonths: 0,
    enrolledAt: "2025-06-20T00:00:00+05:30",
    status: "matured",
  },
  {
    id: "gss-3006",
    ref: "GSS-2026-3006",
    storeId: "surat-main",
    customer: "Tanvi Bhatt",
    phone: "+91 98765 43210",
    planId: "plan-11p2",
    installment: 12000,
    tenureMonths: 11,
    bonusMonths: 2,
    paidMonths: 2,
    missedMonths: 1,
    enrolledAt: "2026-02-14T00:00:00+05:30",
    status: "active",
  },
];

export function getPlan(planId: string): SchemePlan | undefined {
  return SCHEME_PLANS.find((p) => p.id === planId);
}

/* -------------------------------------------------------------------------- */
/*  Module 17 — "Earn with Éclat" referral / commission program           */
/* -------------------------------------------------------------------------- */

/**
 * Referrer **X** gets a coupon `code`; referee **Y** using it gets 5% off the
 * diamond value, and X earns 5% commission on Y's total bill — accrued into
 * `commissionBalance` and redeemable / cashable. A code may be usage-capped
 * (`maxUses`) so a leaked code can't be milked indefinitely.
 */
export const REFERRAL_DIAMOND_DISCOUNT_PCT = 5;
export const REFERRAL_COMMISSION_PCT = 5;

/** A referrer's coupon code and its accrued commission. */
export interface ReferralCode {
  id: string;
  /** Shareable coupon code, e.g. "RTL-PRIYA-8F2A". */
  code: string;
  referrerName: string;
  /** Empty string when not captured. */
  referrerPhone: string;
  /** Usage cap; `null` when uncapped. */
  maxUses: number | null;
  /** Times the code has been redeemed so far. */
  uses: number;
  /** Accrued, unredeemed commission (₹). */
  commissionBalance: number;
  storeId?: string;
}

/** A single redemption of a code against a referee's bill. */
export interface Referral {
  id: string;
  refereeName: string;
  /** Present when the API echoes it back; optional per contract. */
  refereePhone?: string;
  /** Referee's total bill (₹). */
  billAmount: number;
  /** Always 5 — referee's diamond discount. */
  diamondDiscountPct: number;
  diamondDiscountAmount: number;
  /** Always 5 — referrer's commission on the total bill. */
  commissionPct: number;
  commissionAmount: number;
  /** Code's commission balance right after this referral. */
  codeBalanceAfter: number;
  /** Code's use count right after this referral. */
  usesAfter: number;
  /** ISO timestamp when the API records it; optional per contract. */
  createdAt?: string;
}

/** Payout of accrued commission — either redeemed in-store or cashed out. */
export type PayoutType = "redeem" | "cashout";

export const PAYOUT_TYPE_LABELS: Record<PayoutType, string> = {
  redeem: "Redeem",
  cashout: "Cash out",
};

/** True once a capped code has been fully used up. */
export function isCapReached(code: Pick<ReferralCode, "maxUses" | "uses">): boolean {
  return code.maxUses != null && code.uses >= code.maxUses;
}
