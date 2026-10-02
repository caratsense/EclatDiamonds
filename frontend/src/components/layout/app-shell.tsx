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
            {/*
              `flex min-h-full flex-col` lets a screen CHOOSE to fill the
              viewport instead of growing past it.

              Most pages are documents: they stack, they run long, and `main`
              scrolls them. The inbox is not a document. It is three panes that
              each scroll on their own, and when the page ALSO scrolled you got
              a scrollbar that moved the whole three-pane layout out from under
              the cursor while you were reading a conversation inside it.

              `min-h-full` rather than `h-full`: at least the viewport, never
              capped. A long page grows and scrolls exactly as before, so this
              changes nothing for the other screens. A page that wants to fill
              adds `flex-1 min-h-0` to its own root and gets the leftover height
              without anybody having to hard-code what the topbar is worth.
            */}
            <div
              className="mx-auto flex min-h-full w-full max-w-7xl flex-col px-4 py-6 pb-24 md:px-6 md:py-8 md:pb-8"
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
