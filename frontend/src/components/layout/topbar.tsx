"use client";

import { GlobalSearch } from "@/components/layout/global-search";
import { SEARCH_ENABLED } from "@/lib/features";
import { NotificationBell } from "@/components/layout/notification-bell";
import { RoleBadge } from "@/components/layout/role-badge";
import { StoreSwitcher } from "@/components/layout/store-switcher";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";

export function Topbar() {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 md:px-6">
      {/* Mobile navigation is the bottom tab bar (see AppShell). */}

      {/* Multi-store context is always present. */}
      <StoreSwitcher />

      {/* Global search — Ctrl/Cmd+K. Hidden until there is a search index behind
          it (see lib/features). The spacer stays either way so the store
          switcher keeps its position and the right-hand cluster stays flush. */}
      <div className="flex flex-1 justify-center md:px-4">
        {SEARCH_ENABLED ? <GlobalSearch /> : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <NotificationBell />
        <RoleBadge />
        <div className="mx-1 hidden h-5 w-px bg-border sm:block" />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
