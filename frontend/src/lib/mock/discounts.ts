/**
 * Module 15 — Discount Management + Approval Hierarchy.
 *
 * Business rules (from the client call, docs/CLIENT-CALL-2026-07.md §M15):
 *  - **Gold = NO discount, ever.** Only diamond % and making % are discountable.
 *  - Store manager has owner-set caps (default diamond ≤ 5% / making ≤ 10%).
 *    Within caps → auto-approved. Above → Area Manager. Much higher
 *    (diamond ≈ 30–40%) → Head Office.
 *  - **Cost price / margin are role-gated:** store manager & salesperson see
 *    ONLY the selling price — never cost or margin. Area Manager / Head Office
 *    see cost + margin to make the approval decision.
 *
 * These types back the react-query hooks in lib/queries/discounts.ts.
 */

import type { Role } from "@/lib/types";

export type DiscountStatus = "approved" | "escalated" | "pending" | "rejected";

export const DISCOUNT_STATUS_LABELS: Record<DiscountStatus, string> = {
  approved: "Approved",
  escalated: "Escalated",
  pending: "Pending",
  rejected: "Rejected",
};

/**
 * Owner-set store-manager caps. A request whose diamond % AND making % both sit
 * within these auto-approves; anything above escalates. Used for the request
 * dialog's live outcome hint — the server is always the source of truth.
 */
export interface DiscountCap {
  diamondPercent: number;
  makingPercent: number;
}

export const STORE_MANAGER_CAPS: DiscountCap = {
  diamondPercent: 5,
  makingPercent: 10,
};

/**
 * A discount request row as returned by the API. The shape is **role-aware**:
 * `costPrice` and `margin` / `marginImpact` are ONLY present for area_manager
 * and head_office responses — store managers and salespeople never receive
 * them. They are optional here, and the UI additionally gates them **purely on
 * the viewer's role** so a stray field can never leak to a store manager.
 */
export interface DiscountRecord {
  id: string;
  ref?: string;
  storeId: string;
  customerName: string;
  item?: string | null;
  productId?: string | null;
  /** Discount on the diamond component (%). */
  diamondPercent: number;
  /** Discount on the making charge (%). */
  makingPercent: number;
  /** Quoted selling price (₹) — visible to every role. */
  sellingPrice?: number | null;
  status: DiscountStatus;
  /** Role that must sign off. store_manager (or lower) ⇒ auto-approved. */
  requiredRole: Role;
  reason?: string | null;
  requestedRole?: Role;
  requestedBy?: string;
  approvedRole?: Role | null;
  approvedBy?: string | null;
  createdAt?: string;

  /* ---- Role-gated: area_manager / head_office ONLY. ---- */
  /** Landed cost (₹) — never sent to store manager / salesperson. */
  costPrice?: number;
  /** Absolute margin after the discount (₹). */
  margin?: number;
  /** Margin erosion caused by the discount (₹). */
  marginImpact?: number;
}
