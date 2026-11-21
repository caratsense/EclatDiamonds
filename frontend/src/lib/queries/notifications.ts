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
  | "lead_assigned"
  /** A branch is below its reorder level on a design it sells. */
  | "low_stock"
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

/** Where the tabs of one browser agree which of them holds the stream. */
const STREAM_CHANNEL = "caratspace:notification-stream";
const STREAM_LOCK_KEY = "caratspace:notification-stream-leader";
const STREAM_HEARTBEAT_MS = 2_000;
/** A lock older than this belonged to a tab that is gone. */
const STREAM_LOCK_STALE_MS = 7_000;

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

    /*
     * ONE STREAM PER BROWSER, NOT PER TAB.
     *
     * This stream is a connection held open for as long as the tab is. A
     * browser allows six per origin over HTTP/1.1, so six CaratSpace tabs —
     * an ordinary morning for somebody working the floor — used all six on
     * notifications and the seventh request, an actual page load, simply
     * queued until one was closed. The app looked frozen for no reason a
     * person could see.
     *
     * So the tabs elect one leader, which holds the only connection and
     * repeats what arrives to the rest over a BroadcastChannel. The lock is a
     * timestamp in localStorage: the leader refreshes it on a heartbeat, and
     * a lock that has gone stale (the tab was closed, crashed, or the machine
     * slept) is taken over by whoever notices first.
     *
     * A follower is not a degraded tab. It re-renders from the same cache and
     * fires the same callback; it simply does not hold a socket to do it. And
     * the pushed row was never the guarantee anyway — the feed query is, which
     * is why a browser with no BroadcastChannel at all can safely fall through
     * to the old behaviour of connecting on its own.
     */
    const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(STREAM_CHANNEL) : null;
    let leading = false;
    let lockTimer: ReturnType<typeof setInterval> | null = null;

    function deliver(n: FeedNotification) {
      qc.invalidateQueries({ queryKey: [KEY] });
      handlerRef.current?.(n);
    }

    if (channel) {
      channel.onmessage = (e: MessageEvent) => {
        if (cancelled) return;
        const msg = e.data as { type?: string; payload?: FeedNotification } | null;
        if (msg?.type === "notification" && msg.payload) deliver(msg.payload);
        // The leader is standing down (its tab is closing). Try to take over
        // now rather than wait for the lock to go stale.
        if (msg?.type === "leader-released") takeLeadIfFree();
      };
    }

    function lockHolder(): { id: string; at: number } | null {
      try {
        const raw = window.localStorage.getItem(STREAM_LOCK_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown };
        return typeof parsed.id === "string" && typeof parsed.at === "number"
          ? { id: parsed.id, at: parsed.at }
          : null;
      } catch {
        // A corrupt or unreadable lock is treated as no lock: the worst case
        // is a second connection, which is what every tab had before.
        return null;
      }
    }

    function writeLock() {
      try {
        window.localStorage.setItem(
          STREAM_LOCK_KEY,
          JSON.stringify({ id: tabId, at: Date.now() }),
        );
      } catch {
        // Private mode, or storage full. Carry on leading; the lock simply
        // cannot be seen by anyone else.
      }
    }

    function takeLeadIfFree() {
      if (cancelled || leading) return;
      const held = lockHolder();
      const stale = !held || Date.now() - held.at > STREAM_LOCK_STALE_MS;
      if (!stale && held.id !== tabId) return;
      writeLock();
      // Re-read before committing. Two tabs can decide to claim in the same
      // instant; the one whose write landed last owns it, and the other sees
      // that here and stays a follower.
      if (lockHolder()?.id !== tabId) return;
      leading = true;
      attempt = 0;
      connect();
    }

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
        const notification: FeedNotification = {
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
        };
        deliver(notification);
        // Every other tab of this browser is listening instead of connecting.
        channel?.postMessage({ type: "notification", payload: notification });
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

    // Without BroadcastChannel there is nobody to follow, so behave exactly as
    // this hook always did rather than leave the tab with no live updates.
    if (!channel) {
      leading = true;
      connect();
    } else {
      takeLeadIfFree();
      lockTimer = setInterval(() => {
        if (cancelled) return;
        if (leading) writeLock();
        else takeLeadIfFree();
      }, STREAM_HEARTBEAT_MS);
    }

    return () => {
      cancelled = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (lockTimer) clearInterval(lockTimer);
      if (leading) {
        // Hand over deliberately instead of leaving the next tab to wait out a
        // stale lock, which would be several seconds with no live updates for
        // anybody.
        try {
          if (lockHolder()?.id === tabId) window.localStorage.removeItem(STREAM_LOCK_KEY);
        } catch {
          // Nothing to do: the lock expires on its own.
        }
        channel?.postMessage({ type: "leader-released" });
      }
      channel?.close();
    };
  }, [qc]);
}
