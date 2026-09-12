"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Paginated } from "@/lib/queries/products";

/**
 * GET /parties — the customer directory, server-paginated + store-scoped. Keyed
 * on the active store so a store switch refetches. Defaults to `type=customer`;
 * the page can widen to suppliers / staff / all.
 */

export type PartyTypeName =
  | "customer"
  | "supplier"
  | "staff"
  | "salesperson"
  | "branch"
  | "account";

export interface PartyRow {
  id: string;
  name: string;
  code: string | null;
  types: PartyTypeName[];
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
  birthday: string | null;
  anniversary: string | null;
  creditLimit: number | null;
  isBlacklisted: boolean;
  salesCount: number;
  createdAt: string | null;
  /** Set only on the archived list — who took them out of the directory, and why. */
  archivedAt: string | null;
  archivedByName: string | null;
  archiveReason: string | null;
}

export interface PartyListParams {
  page: number;
  pageSize: number;
  q?: string;
  type?: PartyTypeName | "all";
  /**
   * true = the Archived Contacts screen. There is deliberately no "both" mode:
   * a list mixing active and archived people is one somebody campaigns from by
   * mistake.
   */
  archived?: boolean;
}

export function useParties(params: PartyListParams) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["parties", storeId, params],
    queryFn: async () => {
      const { data } = await api.get<Paginated<PartyRow>>("/parties", { params });
      return data;
    },
    // Keep the previous page on screen while the next loads — no empty flash.
    placeholderData: (prev) => prev,
  });
}

export interface CreatePartyInput {
  storeId: string;
  name: string;
  phone: string;
  email?: string;
  city?: string;
}

/** POST /parties — add a customer (type=customer) against the target store. */
export function useCreateParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePartyInput) => {
      const { data } = await api.post<PartyRow>("/parties", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["parties"] });
    },
  });
}


/**
 * Archive a contact.
 *
 * This hides them from the directory, search, the counter lookup and every
 * campaign audience. It does NOT delete them, and it deliberately leaves the
 * consent record, the opt-out and the blacklist flag alone — those are the
 * evidence that somebody asked not to be contacted, and they have to outlive
 * the tidying up.
 */
export function useArchiveParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data } = await api.post<{ id: string; archived: true }>(
        `/parties/${id}/archive`,
        { reason },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["parties"] });
      void qc.invalidateQueries({ queryKey: ["search"] });
    },
  });
}

/**
 * Put a contact back in the working lists.
 *
 * Visible again is not the same as messageable again — a restored contact who
 * had opted out is still opted out, and the response says so.
 */
export function useRestoreParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ id: string; archived: false; isBlacklisted: boolean }>(
        `/parties/${id}/restore`,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["parties"] });
      void qc.invalidateQueries({ queryKey: ["search"] });
    },
  });
}
