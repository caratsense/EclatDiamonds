"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { homeForRole, visibleNavGroups } from "@/lib/navigation";
import { pendingDueCount, useReminders } from "@/lib/queries/reminders";
import { useSession } from "@/store/use-session";

export function Sidebar() {
  const pathname = usePathname();
  // Role-aware nav: HO-only sections (e.g. Store Setup) stay hidden otherwise.
  const role = useSession((s) => s.role);
  const groups = visibleNavGroups(role);
  // Pending follow-ups due today or overdue → the Reminders nav badge.
  const { data: reminders } = useReminders("pending");
  const dueCount = pendingDueCount(reminders);

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      {/* Brand */}
      <div className="flex h-16 items-center border-b border-sidebar-border px-5">
        <Link href={homeForRole(role)} aria-label="Éclat Diamonds">
          <Logo className="h-8 w-auto" />
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5">
        {groups.map((group) => (
          <div key={group.label} className="mb-5">
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/45">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const href = `/${item.slug}`;
                const active =
                  pathname === href || pathname.startsWith(`${href}/`);
                const Icon = item.icon;
                const badgeCount =
                  item.slug === "reminders" ? dueCount : 0;
                return (
                  <li key={item.slug}>
                    <Link
                      href={href}
                      title={item.purpose}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150",
                        active
                          ? "bg-white/[0.07] font-medium text-white"
                          : "text-sidebar-foreground hover:bg-white/[0.04] hover:text-white",
                      )}
                    >
                      {active && (
                        <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-[var(--sidebar-primary)]" />
                      )}
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors",
                          active
                            ? "text-[var(--sidebar-primary)]"
                            : "text-sidebar-foreground/55 group-hover:text-white",
                        )}
                      />
                      <span className="truncate">{item.title}</span>
                      {badgeCount > 0 ? (
                        <span
                          aria-label={`${badgeCount} due`}
                          className="num ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-primary)] px-1.5 text-[11px] font-semibold leading-none text-[var(--sidebar)]"
                        >
                          {badgeCount}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-5 py-3">
        <div className="flex items-center gap-2 text-[11px] text-sidebar-foreground/55">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" />
          All systems live
        </div>
      </div>
    </aside>
  );
}
