"use client";

import Link from "next/link";
import { Bell } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNotifications } from "@/lib/queries/notifications";

/**
 * Topbar notification bell. Shows a count badge (capped at 99+) for the
 * pending items the current user needs to act on across modules, and opens a
 * dropdown that deep-links to each. Empty state reads "You're all caught up."
 * Data is store-scoped + role-aware server-side (see useNotifications).
 */
export function NotificationBell() {
  const { data } = useNotifications();
  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const display = total > 99 ? "99+" : String(total);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={
            total > 0 ? `Notifications, ${total} pending` : "Notifications"
          }
        >
          <Bell className="h-5 w-5 text-muted-foreground" />
          {total > 0 ? (
            <span
              aria-hidden
              className="num absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--sidebar-primary)] px-1 text-[10px] font-semibold leading-none text-[var(--sidebar)]"
            >
              {display}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            You&apos;re all caught up.
          </p>
        ) : (
          items.map((item) => (
            <DropdownMenuItem key={item.type} asChild>
              <Link
                href={item.href}
                className="flex items-center justify-between gap-3"
              >
                <span className="truncate">{item.label}</span>
                <span className="num inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-secondary px-1.5 text-xs font-semibold text-secondary-foreground">
                  {item.count}
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
