"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { LeadSource } from "@/lib/mock/crm";
import type { FollowUpDoneBody } from "@/lib/reminder";

/**
 * Module 1 — Reminders (SOP follow-ups).
 *
 * In-app ONLY: no WhatsApp to the customer, no push / OS notifications
 * (see docs/CLIENT-CALL-2026-07.md § Module 1). A follow-up stays *pending*
 * until the store manager marks it done from the Reminders section.
 *
 * Live hooks against the backend the CRM agent is building:
 *   GET   /leads/reminders?scope=today|overdue|upcoming|pending|all
 *   PATCH /leads/reminders/:id  { dueDate?, done?, note?, stopReminders?, nextDueDate? }
 */

export type ReminderScope =
  | "today"
  | "overdue"
  | "upcoming"
  | "pending"
  | "all";

/** A single follow-up row, denormalised with its lead/store context. */
export interface ReminderItem {
  id: string;
  leadId: string;
  /** Human-friendly lead reference, e.g. LD-2041. */
  leadRef: string;
  customer: string;
  phone: string;
  storeId: string;
  storeName: string;
  /** 1 = the +7-day follow-up, 2 = the +30-day follow-up. */
  seq: number;
  /** Due date, yyyy-mm-dd. */
  dueDate: string;
  done: boolean;
  interest: string;
  source: LeadSource;
  /** When the owner is reminded, at the branch, and whether it has gone out. */
  reminder?: import("@/lib/reminder").ReminderView | null;
}

const REMINDERS_KEY = "reminders";

/**
 * GET /leads/reminders — store-scoped + role-filtered server-side.
 * Ordered by dueDate. Keyed on the active store so switching stores refetches.
 */
export function useReminders(scope: ReminderScope) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [REMINDERS_KEY, scope, storeId],
    queryFn: async () => {
      const { data } = await api.get<ReminderItem[]>("/leads/reminders", {
        params: { scope },
      });
      return data;
    },
  });
}

/**
 * PATCH /leads/reminders/:id — mark a follow-up done.
 *
 * The remark is mandatory, and the body also carries what should happen to the
 * rest of the schedule: nothing, stop reminding this customer, or book the next
 * follow-up (which replaces the pending one). Built by `followUpDoneBody`.
 */
export function useCompleteFollowUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & FollowUpDoneBody) => {
      const { data } = await api.patch<ReminderItem>(`/leads/reminders/${id}`, body);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [REMINDERS_KEY] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

/** PATCH /leads/reminders/:id — reschedule a follow-up to a custom date. */
export function useEditFollowUpDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, dueDate }: { id: string; dueDate: string }) => {
      const { data } = await api.patch<ReminderItem>(
        `/leads/reminders/${id}`,
        { dueDate },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [REMINDERS_KEY] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

/** Bucket a due date relative to today (local). */
export type ReminderBucket = "overdue" | "today" | "upcoming";

export function todayISO(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function bucketFor(dueDate: string, today = todayISO()): ReminderBucket {
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "upcoming";
}

/** Count of pending follow-ups due today or already overdue (sidebar badge). */
export function pendingDueCount(items: ReminderItem[] | undefined): number {
  if (!items) return 0;
  const today = todayISO();
  return items.filter((r) => !r.done && r.dueDate <= today).length;
}
