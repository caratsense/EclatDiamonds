"use client";

import { GlobalSearch } from "@/components/layout/global-search";
import { SEARCH_ENABLED } from "@/lib/features";
import { NotificationBell } from "@/components/layout/notification-bell";
import { StoreSwitcher } from "@/components/layout/store-switcher";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";

export function Topbar() {
  return (
    /*
      Flat white over a hairline, at the comp's 70.3px — not the translucent,
      blurred bar it was. The blur was spending a GPU layer on every screen to
      show a wash of whatever scrolled beneath it, which on a #f8f9fa ground is
      indistinguishable from the white it now simply is.

      The brand lockup the comp shows at the left end of this bar lives at the
      top of the rail instead, because the shell makes the rail this bar's
      sibling rather than its parent; both are 70.3px tall over the same
      hairline, so they read as one bar.
    */
    <header className="sticky top-0 z-30 flex h-[70px] items-center gap-2 border-b bg-card px-4 md:gap-3 md:px-6">
      {/* Mobile navigation is the bottom tab bar (see AppShell). */}

      {/* Record search — Ctrl/Cmd+K. Hidden until there is a search index behind
          it (see lib/features); the wrapper is sized so the trigger's own
          `w-full` resolves against something definite instead of its content,
          and keeps the md:hidden icon variant reachable on a phone. */}
      {SEARCH_ENABLED ? (
        <div className="min-w-0 md:w-[220px]">
          <GlobalSearch />
        </div>
      ) : null}

      {/* Multi-store context is always present. */}
      <StoreSwitcher />

      <div className="ml-auto flex items-center gap-1 md:gap-1.5">
        <NotificationBell />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
