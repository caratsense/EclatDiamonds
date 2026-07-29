import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { PendingAssignmentGate } from "@/components/layout/pending-assignment-gate";

/**
 * App shell: persistent sidebar (desktop) + bottom tab bar (mobile) + topbar,
 * wrapping every (app) route. Role/store-aware via the session store.
 *
 * PendingAssignmentGate wraps the shell: a user who is authenticated but not
 * yet linked to a store sees a friendly "not assigned yet" card instead of an
 * empty, store-scoped app. Users with a store (or head office) pass through.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <PendingAssignmentGate>
      <div className="flex h-dvh overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 overflow-y-auto">
            {/* extra bottom padding on mobile so content clears the tab bar.
                `--tour-inset` is published by the welcome guide while it is on
                screen (0 otherwise) so the page scrolls clear of it — the card
                is a fixed overlay and was covering page controls outright on a
                phone, swallowing the clicks meant for them. */}
            <div
              className="mx-auto w-full max-w-7xl px-4 py-6 pb-24 md:px-6 md:py-8 md:pb-8"
              style={{ scrollPaddingBottom: "var(--tour-inset, 0px)" }}
            >
              {children}
              <div
                aria-hidden="true"
                style={{ height: "var(--tour-inset, 0px)" }}
                className="transition-[height] duration-200"
              />
            </div>
          </main>
        </div>
        <MobileNav />
      </div>
    </PendingAssignmentGate>
  );
}
