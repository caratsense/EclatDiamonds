"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Quick replies: the words a salesperson sends from the inbox with one tap.
 *
 * Two queries that look similar and must not be merged. `useQuickReplyChips`
 * asks "what can be sent to THIS customer right now" and the answer depends on
 * the 24-hour window, on which branch the thread belongs to and on whether Meta
 * still approves the template behind each one — so the server resolves it and
 * the browser renders what it is given. `useQuickReplies` asks "what are the
 * quick replies", which is a different question with a different audience: a
 * manager arranging them, who needs to see the broken ones too.
 */

export type QuickReplyKind = "free_text" | "template";

/** One chip in the inbox. Only replies that can actually be used are returned. */
export interface QuickReplyChip {
  id: string;
  label: string;
  kind: QuickReplyKind;
  /** Placeholders already filled by the server. */
  text: string;
  /** Template-backed: pressing it SENDS, it does not fill the composer. */
  sends: boolean;
}

export interface QuickReplyChips {
  windowOpen: boolean;
  chips: QuickReplyChip[];
  /** Whether to offer this person the link to the management screen. */
  canManage: boolean;
}

/** One row on the management screen. */
export interface QuickReplyRow {
  id: string;
  label: string;
  kind: QuickReplyKind;
  body: string | null;
  templateAssetId: string | null;
  templateName: string | null;
  storeId: string | null;
  storeName: string | null;
  sortOrder: number;
  isActive: boolean;
  /** Why this one reaches nobody at the moment, in words. Null when it is fine. */
  warning: string | null;
}

export interface QuickReplyPlaceholder {
  token: string;
  what: string;
  standIn: string;
}

export interface QuickReplyList {
  rows: QuickReplyRow[];
  /** The documented set, from the server — never a second list typed here. */
  placeholders: QuickReplyPlaceholder[];
  /** Only head office may write a reply every branch reads. */
  canWriteEveryBranch: boolean;
}

const KEY = ["quick-replies"] as const;

export function useQuickReplyChips(conversationId: string | null) {
  return useQuery({
    queryKey: [...KEY, "conversation", conversationId],
    enabled: Boolean(conversationId),
    queryFn: async () => {
      const { data } = await api.get<QuickReplyChips>(
        `/crm/quick-replies/conversation/${conversationId}`,
      );
      return data;
    },
    /*
     * Short, not zero. The window closes while somebody has the thread open —
     * a manager working an inbox all afternoon — and the set of chips changes
     * when it does, so a list cached for the session would keep offering free
     * text that the server has already started refusing.
     */
    staleTime: 60_000,
  });
}

/** Send a template-backed chip. Free text never comes here; it fills the composer. */
export function useSendQuickReply(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{
        messageId: string;
        status: string;
        label: string;
        sentText: string;
      }>(`/crm/quick-replies/conversation/${conversationId}/${id}/send`);
      return data;
    },
    onSuccess: () => {
      // The thread has a new outbound message in it, and the list's preview
      // line and ordering move with it.
      void qc.invalidateQueries({ queryKey: ["crm", "conversation", conversationId] });
      void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
    },
  });
}

export function useQuickReplies() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data } = await api.get<QuickReplyList>("/crm/quick-replies");
      return data;
    },
  });
}

export interface QuickReplyInput {
  label: string;
  kind: QuickReplyKind;
  body?: string;
  templateAssetId?: string;
  /** null is a real value: every branch. */
  storeId?: string | null;
}

export function useCreateQuickReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: QuickReplyInput) => {
      const { data } = await api.post<QuickReplyRow>("/crm/quick-replies", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateQuickReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: Partial<QuickReplyInput> & { id: string; isActive?: boolean }) => {
      const { data } = await api.patch<QuickReplyRow>(`/crm/quick-replies/${id}`, input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteQuickReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ deleted: true; label: string }>(
        `/crm/quick-replies/${id}`,
      );
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * The whole order, not a swap.
 *
 * Two managers arranging the row at once then converge on a state instead of
 * racing to increment, which is the same reason lead tags are set rather than
 * added.
 */
export function useReorderQuickReplies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.put<QuickReplyRow[]>("/crm/quick-replies/order", { ids });
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
