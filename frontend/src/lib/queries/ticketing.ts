"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useSession } from "@/store/use-session";
import type {
  RecurringPattern,
  TicketCategory,
  TicketMessage,
  TicketPriority,
  TicketStatus,
} from "@/lib/mock/ticketing";

/**
 * Module 13 — Ticketing & Issue Management.
 * GET /tickets returns { tickets, patterns }; the per-ticket message thread is
 * only on GET /tickets/:id, so the list rows carry no `thread`.
 *
 * All list queries are keyed on the active store id so switching the store in
 * the topbar auto-refetches (React Query treats it as a fresh key).
 */

/** A ticket as returned by the list endpoint (no message thread). */
export interface TicketListItem {
  id: string;
  ref: string;
  subject: string;
  store: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignee: string;
  reporter: string;
  createdAt: string;
  updatedAt: string;
  patternTag?: string;
}

/** GET /tickets/:id adds the conversation thread. */
export interface TicketDetail extends TicketListItem {
  thread: TicketMessage[];
}

export interface TicketListResponse {
  tickets: TicketListItem[];
  patterns: RecurringPattern[];
}

export const ticketKeys = {
  all: ["tickets"] as const,
  list: (storeId: string) => ["tickets", "list", storeId] as const,
  detail: (id: string) => ["tickets", "detail", id] as const,
};

/** GET /tickets — store-scoped issue list + recurring-pattern clusters. */
export function useTickets() {
  const storeId = useSession((s) => s.currentStore.id);
  return useQuery({
    queryKey: ticketKeys.list(storeId),
    queryFn: async () => {
      const { data } = await api.get<TicketListResponse>("/tickets");
      return data;
    },
  });
}

/** GET /tickets/:id — one ticket with its message thread. */
export function useTicket(id: string | null) {
  return useQuery({
    queryKey: ticketKeys.detail(id ?? "none"),
    enabled: !!id,
    queryFn: async () => {
      const { data } = await api.get<TicketDetail>(`/tickets/${id}`);
      return data;
    },
  });
}

export interface CreateTicketInput {
  storeId?: string;
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  reporterName?: string;
  patternTag?: string;
}

/** POST /tickets — raise a ticket; auto-routes by category server-side. */
export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTicketInput) => {
      const { data } = await api.post<TicketListItem>("/tickets", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ticketKeys.all });
    },
  });
}

/** PATCH /tickets/:id — update status / priority / assignee. */
export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: {
      id: string;
      status?: TicketStatus;
      priority?: TicketPriority;
      assigneeId?: string;
      assigneeName?: string;
    }) => {
      const { data } = await api.patch<TicketListItem>(`/tickets/${id}`, patch);
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: ticketKeys.detail(vars.id) });
    },
  });
}

/** POST /tickets/:id/messages — append a reply; returns the refreshed detail. */
export function useReplyToTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      const { data } = await api.post<TicketDetail>(`/tickets/${id}/messages`, {
        body,
      });
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: ticketKeys.detail(vars.id) });
    },
  });
}
