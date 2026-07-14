"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";

/**
 * Cross-module notification summary for the topbar bell.
 *
 * GET /notifications/summary — store-scoped + role-aware server-side: a store
 * manager sees discount/return/leave requests awaiting their sign-off, a
 * salesperson sees their own reminders, etc. Only nonzero buckets are returned.
 * Polls every 60s and on window focus so the badge stays fresh without a manual
 * refresh. Keyed on the active store so switching the store refetches.
 */

export type NotificationType = "discount" | "return" | "leave" | "reminder";

export interface NotificationItem {
  type: NotificationType;
  label: string;
  count: number;
  /** In-app route the item deep-links to. */
  href: string;
}

export interface NotificationSummary {
  total: number;
  items: NotificationItem[];
}

export function useNotifications() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["notifications", storeId],
    queryFn: async (): Promise<NotificationSummary> => {
      const { data } = await api.get<NotificationSummary>(
        "/notifications/summary",
      );
      return data;
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
}
