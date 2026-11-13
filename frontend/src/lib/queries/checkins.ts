"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { CheckIn, VisitPurpose } from "@/lib/mock/checkins";

/**
 * Module 7 — Customer Check-ins & Footfall (manual/tablet check-ins only;
 * CCTV analytics is DROPPED, see CLAUDE.md). Live hooks against `/checkins`.
 *
 * The backend shapes rows into the frontend `CheckIn` view model
 * (checkins.service.ts): `timeIn`/`timeOut` are HH:mm strings (or null while in
 * store), `partySize` defaults to 1 (not modelled), `returning` derives from a
 * linked CRM party. We type the response against the existing mock interface.
 */

const CHECKINS_KEY = "checkins";

/** Backend purpose enum values (CheckinPurpose) accepted by POST /checkins. */
export type CheckinPurposeInput =
  // The register's two purposes that had no value here before.
  | "purchase"
  | "return_exchange"
  | "bridal"
  | "investment"
  | "repair"
  | "quote_followup"
  | "browsing"
  | "scheme"
  | "other";

/** Backend outcome enum values (CheckinOutcome) accepted by PATCH /checkins/:id. */
export type CheckinOutcomeInput =
  | "in_store"
  /** Shown as "Direct Sale" — the client's wording. Stored value unchanged. */
  | "sale_closed"
  /** Billed now, made later: the only outcome that carries a delivery date. */
  | "custom_order"
  | "quote_given"
  | "follow_up"
  | "left";

export interface CreateCheckInInput {
  storeId: string;
  customerName: string;
  /* The register's own columns (walk-in review, Nov 2026). */
  visitDate?: string;
  managerName?: string;
  googleReviewTaken?: boolean;
  referralName?: string;
  referralPhone?: string;
  recommendedAction?: string;
  phone?: string;
  purpose?: CheckinPurposeInput;
  repId?: string;
  repName?: string;
  /* The New Customer Data survey (7 Oct). All optional; stored on the visit's
     metadata, with birthday/anniversary written to the customer record. */
  customerType?: "new" | "existing";
  birthday?: string;
  anniversary?: string;
  source?: string;
  occasion?: string;
  productCategory?: string;
  budgetRange?: string;
  nonPurchaseReason?: string;
  savingScheme?: "yes" | "no";
  savingSchemeReason?: string;
}

/** GET /checkins — footfall log (most recent first), store-scoped. */
export function useCheckins() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [CHECKINS_KEY, storeId],
    queryFn: async () => {
      const { data } = await api.get<CheckIn[]>("/checkins");
      return data;
    },
  });
}

/** POST /checkins — register a walk-in against the active store. */
export function useCreateCheckin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCheckInInput) => {
      const { data } = await api.post<CheckIn>("/checkins", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [CHECKINS_KEY] });
      // The dashboard's Footfall Today tile counts these same rows. Left out,
      // a walk-in registered at the door did not reach the manager's screen.
      qc.invalidateQueries({ queryKey: ["dashboard", "kpis"] });
    },
  });
}

/** PATCH /checkins/:id — check the customer out (records timeOut + outcome). */
export function useCheckoutCheckin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      outcome?: CheckinOutcomeInput;
      /** What the customer said. Lands on their timeline too. */
      remark?: string;
      /** yyyy-mm-dd. Creates a real follow-up on the calling queue. */
      followUpDate?: string;
      preferredAction?: "call" | "whatsapp" | "visit";
      /** "YYYY-MM-DDTHH:MM" at the branch. Omitted, the tenant's default applies. */
      reminderAt?: string;
    }) => {
      const { data } = await api.patch<CheckIn>(`/checkins/${id}`, body);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [CHECKINS_KEY] });
    },
  });
}

/** Map a frontend visit-purpose label to the backend enum for POST writes. */
export const PURPOSE_TO_ENUM: Record<VisitPurpose, CheckinPurposeInput> = {
  Purchase: "purchase",
  "Scheme Installments": "scheme",
  Repair: "repair",
  "Return/ Exchange": "return_exchange",
  Exploring: "browsing",
};
