import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileNav } from "@/components/layout/mobile-nav";

/**
 * App shell: persistent sidebar (desktop) + bottom tab bar (mobile) + topbar,
 * wrapping every (app) route. Role/store-aware via the session store.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          {/* extra bottom padding on mobile so content clears the tab bar */}
          <div className="mx-auto w-full max-w-7xl px-4 py-6 pb-24 md:px-6 md:py-8 md:pb-8">
            {children}
          </div>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
