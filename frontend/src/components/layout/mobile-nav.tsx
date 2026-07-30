"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NAV_ITEMS, visibleNavGroups } from "@/lib/navigation";
import { useSession } from "@/store/use-session";
import { useT } from "@/lib/i18n";

/**
 * Preferred order for the thumb-reachable bottom tabs; we render the first four
 * the current role can actually see (a salesperson has no Dashboards, so they
 * get Quotation instead). Everything else lives in "More".
 */
const PREFERRED_PRIMARY = [
  "dashboards",
  "crm",
  "quotation",
  "catalogue",
  "checkins",
  "reminders",
] as const;

function Tab({
  href,
  title,
  hint,
  Icon,
  active,
}: {
  href: string;
  title: string;
  hint?: string;
  Icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      title={hint}
      aria-current={active ? "page" : undefined}
      className={cn(
        // ≥44px tap target, one-handed reach
        "relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1",
        active ? "text-gold-strong" : "text-muted-foreground",
      )}
    >
      {/* gold light-catch marks the active tab (the signature, horizontal) */}
      {active ? (
        <span className="absolute inset-x-5 top-0 h-[2px] rounded-full bg-[var(--gold)]" />
      ) : null}
      <Icon className="h-5 w-5 shrink-0" />
      <span className="max-w-full truncate text-[10px] font-medium leading-none">
        {title}
      </span>
    </Link>
  );
}

/**
 * Mobile bottom navigation. Visible below md only; the desktop sidebar takes
 * over at md+. Four primary tabs + a "More" sheet listing every section,
 * grouped exactly like the sidebar. Thumb-reachable, 44px+ targets.
 */
export function MobileNav() {
  const pathname = usePathname();
  const t = useT();
  const [moreOpen, setMoreOpen] = React.useState(false);
  // Role-aware "More" sheet: HO-only sections stay hidden for other roles.
  const role = useSession((s) => s.role);
  const groups = visibleNavGroups(role);

  const isActive = (slug: string) => {
    const href = `/${slug}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // Role-aware primary tabs: keep only what this role can see, take the first 4.
  const visibleSlugs = new Set(
    groups.flatMap((g) => g.items.map((i) => i.slug)),
  );
  const primary = PREFERRED_PRIMARY.filter((s) => visibleSlugs.has(s))
    .slice(0, 4)
    .map((slug) => NAV_ITEMS.find((i) => i.slug === slug)!)
    .filter(Boolean);
  const primarySlugs = primary.map((i) => i.slug);

  const moreActive =
    !primarySlugs.some((s) => isActive(s)) && pathname !== "/login";

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex h-16 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {primary.map((item) => (
          <Tab
            key={item.slug}
            href={`/${item.slug}`}
            title={t(`nav.${item.slug}`, item.title).split(" ")[0]}
            hint={item.purpose}
            Icon={item.icon}
            active={isActive(item.slug)}
          />
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-current={moreActive ? "page" : undefined}
          className={cn(
            "relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1",
            moreActive ? "text-gold-strong" : "text-muted-foreground",
          )}
        >
          {moreActive ? (
            <span className="absolute inset-x-5 top-0 h-[2px] rounded-full bg-[var(--gold)]" />
          ) : null}
          <MoreHorizontal className="h-5 w-5 shrink-0" />
          <span className="text-[10px] font-medium leading-none">
            {t("nav.more", "More")}
          </span>
        </button>
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent className="max-h-[80dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-bold">
              All sections
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t(`group.${group.label}`, group.label)}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {group.items.map((item) => {
                    const active = isActive(item.slug);
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.slug}
                        href={`/${item.slug}`}
                        title={item.purpose}
                        onClick={() => setMoreOpen(false)}
                        className={cn(
                          "flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-lg border p-2 text-center transition-colors",
                          active
                            ? "border-[color-mix(in_srgb,var(--gold)_40%,transparent)] bg-[color-mix(in_srgb,var(--gold)_10%,transparent)] text-gold-strong"
                            : "border-border hover:bg-accent",
                        )}
                      >
                        <Icon className="h-5 w-5 shrink-0" />
                        <span className="text-[11px] font-medium leading-tight">
                          {t(`nav.${item.slug}`, item.title)}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
