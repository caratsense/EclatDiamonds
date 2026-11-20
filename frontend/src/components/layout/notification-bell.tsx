"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bell, Check, CheckCheck, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  useClearNotifications,
  useDismissNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationFeed,
  useNotifications,
  useNotificationStream,
  type FeedNotification,
} from "@/lib/queries/notifications";

/** "just now" / "12m" / "3h" / "5d" — compact enough for a dropdown row. */
function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Topbar notification bell.
 *
 * Two things live here and they are deliberately separate:
 *
 *  - **Notifications** — the persisted feed. Individually readable, individually
 *    clearable, with "Mark all read" and "Clear read".
 *  - **Needs your action** — live counts recomputed from the source tables. These
 *    are NOT clearable on purpose: clearing a notification must never make open
 *    work disappear from the queue. A cleared bell with three approvals still
 *    outstanding would be worse than no bell at all.
 *
 * Delivery is push over SSE, so a new item lands here immediately rather than on
 * the next poll.
 */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const { data: summary } = useNotifications();
  const { data: feed } = useNotificationFeed();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const dismiss = useDismissNotification();
  const clearAll = useClearNotifications();

  // Live push. A high-priority item toasts so it is not missed while the user is
  // deep in another screen; normal ones just update the badge quietly.
  useNotificationStream((n) => {
    if (n.priority === "high") {
      toast(n.title, {
        description: n.body ?? undefined,
        action: n.href
          ? { label: "Open", onClick: () => router.push(n.href as string) }
          : undefined,
      });
    }
  });

  const items = feed?.items ?? [];
  const unread = feed?.unreadCount ?? summary?.unreadCount ?? 0;
  const actionItems = summary?.items ?? [];
  const badge = unread > 99 ? "99+" : String(unread);

  function openNotification(n: FeedNotification) {
    if (!n.read) markRead.mutate({ id: n.id });
    if (n.href) {
      setOpen(false);
      router.push(n.href);
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-5 w-5 text-muted-foreground" />
          {unread > 0 ? (
            <span
              aria-hidden
              className="num absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--sidebar-primary)] px-1 text-[10px] font-semibold leading-none text-[var(--sidebar)]"
            >
              {badge}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={unread === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Mark all read
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={items.length === 0 || clearAll.isPending}
              // Clears only what has been READ — a blanket clear could bury
              // something the user never looked at.
              onClick={() =>
                clearAll.mutate(
                  { onlyRead: true },
                  {
                    onSuccess: (r) =>
                      toast.success(
                        r.cleared > 0
                          ? `Cleared ${r.cleared} notification${r.cleared === 1 ? "" : "s"}`
                          : "Nothing read to clear yet",
                      ),
                  },
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear read
            </Button>
          </div>
        </div>
        <Separator />

        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              You&apos;re all caught up.
            </p>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={cn(
                  "group flex gap-2 border-b px-3 py-2.5 last:border-0",
                  !n.read && "bg-accent/40",
                )}
              >
                <button
                  type="button"
                  onClick={() => openNotification(n)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "truncate text-sm",
                        !n.read && "font-medium",
                        n.priority === "high" && "text-warning",
                      )}
                    >
                      {n.title}
                    </span>
                    <span className="num shrink-0 text-[11px] text-muted-foreground">
                      {ago(n.createdAt)}
                    </span>
                  </div>
                  {n.body ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {n.body}
                    </p>
                  ) : null}
                </button>
                <div className="flex shrink-0 flex-col items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  {!n.read ? (
                    <button
                      type="button"
                      aria-label="Mark read"
                      title="Mark read"
                      className="rounded p-1 text-muted-foreground hover:bg-accent"
                      onClick={() => markRead.mutate({ id: n.id })}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Clear"
                    title="Clear"
                    className="rounded p-1 text-muted-foreground hover:bg-accent"
                    onClick={() => dismiss.mutate(n.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {actionItems.length > 0 ? (
          <>
            <Separator />
            <div className="px-3 py-2">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Needs your action
              </p>
              {/* Live counts, not clearable — see the component doc comment. */}
              {actionItems.map((item) => (
                <Link
                  key={item.type}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between gap-3 rounded px-1 py-1.5 text-sm hover:bg-accent"
                >
                  <span className="truncate">{item.label}</span>
                  <span className="num inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-secondary px-1.5 text-xs font-semibold text-secondary-foreground">
                    {item.count}
                  </span>
                </Link>
              ))}
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
