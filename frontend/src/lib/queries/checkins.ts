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
  | "sale_closed"
  | "quote_given"
  | "follow_up"
  | "left";

export interface CreateCheckInInput {
  storeId: string;
  customerName: string;
  phone?: string;
  purpose?: CheckinPurposeInput;
  repId?: string;
  repName?: string;
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
  Browsing: "browsing",
  Bridal: "bridal",
  "Gold Coin / Investment": "investment",
  "Repair / Service": "repair",
  "Gold Scheme": "scheme",
  Exchange: "other",
  "Quote Follow-up": "quote_followup",
};
