"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, getStoredToken } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";

/**
 * Notifications — a persisted, clearable feed plus the derived work-queue counts.
 *
 * Two endpoints that look similar and are not:
 *  - `GET /notifications`         the FEED: what happened, with per-user read and
 *                                 dismiss state. Clearable.
 *  - `GET /notifications/summary` the WORK QUEUE: what is still open, recomputed
 *                                 from the source tables on every call. Clearing
 *                                 a notification must never hide live work, which
 *                                 is exactly why these are kept apart.
 *
 * Delivery is push, over SSE — see {@link useNotificationStream}. The 60s poll
 * survives only as a safety net for a dropped connection.
 */

const KEY = "notifications";

export type NotificationKind =
  | "discount_request"
  | "return_request"
  | "leave_request"
  | "regularization_request"
  | "special_request"
  | "diamond_rate_request"
  | "order_delayed"
  | "attendance_review"
  | "reminder"
  | "system";

export interface FeedNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  storeId: string | null;
  entityType: string | null;
  entityId: string | null;
  /** "normal" | "high" — high renders with an accent. */
  priority: string;
  actorName: string | null;
  read: boolean;
  dismissed: boolean;
  createdAt: string;
}

export interface NotificationFeed {
  unreadCount: number;
  total: number;
  items: FeedNotification[];
}

export type NotificationType =
  | "discount"
  | "return"
  | "leave"
  | "reminder"
  | "store_pending"
  | "special_request";

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
  /** Unread count from the persisted feed — what the bell badge shows. */
  unreadCount: number;
}

/** GET /notifications/summary — open work, recomputed server-side each call. */
export function useNotifications() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: [KEY, "summary", storeId],
    queryFn: async (): Promise<NotificationSummary> => {
      const { data } = await api.get<NotificationSummary>("/notifications/summary");
      return data;
    },
    // Push keeps this fresh; the interval is only a fallback for a dropped stream.
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
}

/** GET /notifications — the caller's own feed, newest first. */
export function useNotificationFeed(options: { includeDismissed?: boolean } = {}) {
  const { includeDismissed = false } = options;
  return useQuery({
    queryKey: [KEY, "feed", includeDismissed],
    queryFn: async (): Promise<NotificationFeed> => {
      const { data } = await api.get<NotificationFeed>("/notifications", {
        params: includeDismissed ? { includeDismissed: true } : undefined,
      });
      return data;
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
}

/** Refresh both the feed and the work-queue counts after any state change. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: [KEY] });
}

/** PATCH /notifications/:id/read */
export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, read = true }: { id: string; read?: boolean }) => {
      const { data } = await api.patch<FeedNotification>(
        `/notifications/${id}/read`,
        { read },
      );
      return data;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

/** POST /notifications/read-all */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ marked: number }>("/notifications/read-all");
      return data;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

/** DELETE /notifications/:id — clear one (soft dismiss; history keeps it). */
export function useDismissNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<FeedNotification>(`/notifications/${id}`);
      return data;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

/**
 * DELETE /notifications — clear the bell.
 *
 * `onlyRead` is the safer default for a "Clear all" button: it cannot bury
 * something the user never actually looked at.
 */
export function useClearNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts: { onlyRead?: boolean } = {}) => {
      const { data } = await api.delete<{ cleared: number }>("/notifications", {
        params: opts.onlyRead ? { onlyRead: true } : undefined,
      });
      return data;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

/**
 * Subscribe to the live notification stream.
 *
 * Uses `fetch` + a `ReadableStream` reader rather than `EventSource`, for one
 * concrete reason: `EventSource` cannot set request headers, so authenticating it
 * would mean putting the JWT in the query string — where it lands in proxy and
 * platform logs. `fetch` sends the normal `Authorization` header.
 *
 * The trade-off is that auto-reconnect becomes ours to implement, hence the
 * capped exponential backoff below. Reconnecting also refetches the feed, so
 * anything that landed while the connection was down is picked up from the
 * persisted rows — the push is an optimisation, the row is the guarantee.
 *
 * @param onNotification fired for each pushed notification (e.g. to toast it).
 */
export function useNotificationStream(
  onNotification?: (n: FeedNotification) => void,
) {
  const qc = useQueryClient();
  // Held in a ref so a changing callback identity never tears down the stream.
  const handlerRef = useRef(onNotification);
  handlerRef.current = onNotification;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = getStoredToken();
    if (!token) return;

    const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    let cancelled = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function handleFrame(frame: string) {
      const lines = frame.split("\n");
      // The frame's discriminator is the `event:` line, NOT a field inside the
      // JSON. Nest's `@Sse()` maps a MessageEvent's `type` onto the SSE event
      // name and only its `data` onto the payload, so a client that looks for
      // `payload.type` silently ignores every frame.
      const eventName =
        lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      // Heartbeats only keep the connection warm; nothing to render.
      if (eventName !== "notification") return;

      const dataLine = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!dataLine) return;
      try {
        const n = JSON.parse(dataLine);
        qc.invalidateQueries({ queryKey: [KEY] });
        handlerRef.current?.({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body ?? null,
          href: n.href ?? null,
          storeId: n.storeId ?? null,
          entityType: n.entityType ?? null,
          entityId: n.entityId ?? null,
          priority: n.priority ?? "normal",
          actorName: n.actorName ?? null,
          read: false,
          dismissed: false,
          createdAt: n.createdAt,
        });
      } catch {
        // A malformed frame is not worth breaking the stream over.
      }
    }

    function scheduleReconnect() {
      // Capped exponential backoff: 1s, 2s, 4s … 30s. Without the cap a backend
      // restart would have every open tab hammering the API as it comes back up.
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    }

    async function connect() {
      if (cancelled) return;
      controller = new AbortController();
      try {
        const res = await fetch(`${base}/notifications/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        // Connected: reset the backoff and resync, in case anything landed
        // while we were away.
        attempt = 0;
        qc.invalidateQueries({ queryKey: [KEY] });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            handleFrame(buffer.slice(0, split));
            buffer = buffer.slice(split + 2);
            split = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Swallowed: a dropped stream is normal (sleep, tunnel, redeploy). The
        // reconnect is the recovery and the feed query is the backstop.
      }
      if (!cancelled) scheduleReconnect();
    }

    connect();

    return () => {
      cancelled = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [qc]);
}
