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
  /**
   * The name this customer arrived with, kept the first time somebody renamed
   * them. Null until then — most customers have never been renamed.
   */
  originalName: string | null;
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
  /**
   * The branch this customer belongs to — null for both when they have none.
   *
   * A customer with no branch is visible to head office alone (client, 23 Nov),
   * so for everyone else these are always set; for head office, a null is a
   * customer still waiting to be handed to a shop.
   */
  storeId: string | null;
  storeName: string | null;
  salesCount: number;
  /** The customer's tags — chips on the directory row (client, 10 Oct). */
  tags: { id: string; name: string; colour: string | null }[];
  /**
   * Came from Gati, which rewrites the name on every sync — so the rename is
   * not offered here at all, rather than offered and then undone overnight.
   */
  isSynced: boolean;
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
  /** Show only customers wearing this tag. */
  tagId?: string;
  /**
   * Head office's triage queue: only the customers with no branch yet. Anyone
   * else asking gets an empty list — the unbranched are not in their scope.
   */
  unbranched?: boolean;
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

/**
 * How many customers are still waiting for a branch.
 *
 * The number is the whole point of the filter: hiding the unbranched from
 * branch staff is only safe while head office cannot miss them, and seventeen
 * customers among eight hundred are missed unless something says "seventeen".
 * Asks for one row and reads the total off the envelope.
 *
 * `enabled` is the caller's role check — nobody below head office has an
 * unbranched customer in scope, so the request would always answer zero.
 */
export function useUnbranchedCustomerCount(enabled: boolean) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["parties", "unbranched-count", storeId],
    queryFn: async () => {
      const { data } = await api.get<Paginated<PartyRow>>("/parties", {
        params: { page: 1, pageSize: 1, type: "customer", unbranched: true },
      });
      return data.total;
    },
    enabled,
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
 * Rename a customer.
 *
 * The client's ask (19 Nov): the customers Meta identified are called things
 * like "♥♥♥" and nobody can tell who they are. The reply carries the whole row
 * back, including `originalName`, so the screen can keep showing what they were
 * called on WhatsApp without a refetch.
 */
export function useRenameParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const { data } = await api.patch<PartyRow>(`/parties/${id}`, { name });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["parties"] });
      // The name is what search and Customer 360 show too.
      void qc.invalidateQueries({ queryKey: ["search"] });
      void qc.invalidateQueries({ queryKey: ["crm", "customer360"] });
    },
  });
}

/**
 * Hand a customer to a branch, or move them to another one.
 *
 * The way out of head office's "no branch yet" queue (client, 23 Nov): a
 * customer nobody's shop owns is invisible to the branch staff who would
 * recognise them, so the queue is only defensible with this beside it. Head
 * office only, and refused for a Gati-synced customer — the sync writes the
 * branch on every run and would take them off the shop's list again.
 *
 * The reply carries the whole row, so the open dialog shows the new branch
 * without a refetch.
 */
export function useAssignPartyBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, storeId }: { id: string; storeId: string }) => {
      const { data } = await api.post<PartyRow>(`/parties/${id}/branch`, { storeId });
      return data;
    },
    onSuccess: () => {
      // The directory, the queue's count and Customer 360 all show the branch.
      void qc.invalidateQueries({ queryKey: ["parties"] });
      void qc.invalidateQueries({ queryKey: ["crm", "customer360"] });
    },
  });
}

/** One customer's outcome in a bulk delete — deleted, or skipped with a reason. */
export interface BulkDeleteResult {
  requested: number;
  deleted: { id: string; name: string }[];
  skipped: { id: string; name: string | null; reason: string }[];
}

/**
 * Delete the ticked customers.
 *
 * The server applies the single-delete rules one customer at a time, so a
 * selection that includes Gati-synced customers or customers with history comes
 * back PART done: the reply names who went and who did not, and the screen
 * reports that instead of a success toast. Head office only.
 */
export function useBulkDeleteParties() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post<BulkDeleteResult>("/parties/bulk-delete", { ids });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["parties"] });
      void qc.invalidateQueries({ queryKey: ["search"] });
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
 * Ask for a customer to be removed.
 *
 * Nobody below head office may do it outright, so this raises an approval
 * instead: a salesperson's ask goes to their manager, a manager's to head
 * office. The reply says which outcome was requested — a customer with any
 * history is archived rather than deleted, because deleting would take their
 * sales and payments with them.
 */
export function useRequestPartyDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data } = await api.post<{
        request: { ref: string; requiredRoleLabel?: string };
        outcome: "delete" | "archive";
        held: string | null;
      }>(`/parties/${id}/deletion-request`, { reason });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["requests"] });
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
