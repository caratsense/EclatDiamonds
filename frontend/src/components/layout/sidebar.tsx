"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, DoorOpen, FileText, Plus, Search, UserPlus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  homeForRole,
  visibleNavGroups,
  type NavGroup,
  type NavItem,
} from "@/lib/navigation";
import { OPEN_SEARCH_EVENT } from "@/components/layout/global-search";
import { SEARCH_ENABLED } from "@/lib/features";
import { pendingDueCount, useReminders } from "@/lib/queries/reminders";
import {
  useConfigBootstrap,
  useEnabledNavigation,
} from "@/lib/queries/tenant-config";
import { useSession } from "@/store/use-session";
import { useQuickAction } from "@/store/use-quick-action";
import { brandingName, ECLAT_SLUG } from "@/lib/branding";
import { useT } from "@/lib/i18n";

export function Sidebar() {
  const pathname = usePathname();
  const t = useT();
  // Role-aware nav: HO-only sections (e.g. Store Setup) stay hidden otherwise.
  const role = useSession((s) => s.role);
  const { data: config } = useConfigBootstrap();
  // Derived from the applied industry pack, so changing industry moves the
  // sidebar immediately instead of leaving it on whatever was frozen at signup.
  const enabledNavigation = useEnabledNavigation();
  /*
   * Whose product this is.
   *
   * `slug` identifies the organisation that owns the Éclat artwork; every other
   * tenant is shown their own name. The tenant's chosen display name wins over
   * the legal organisation name when they have set one.
   */
  const brandName = brandingName(config?.organisation.settings) ?? config?.organisation.name ?? null;
  const isEclat = config?.organisation.slug === ECLAT_SLUG;
  const groups = visibleNavGroups(role, enabledNavigation);
  // Pending follow-ups due today or overdue → the Reminders nav badge.
  const { data: reminders } = useReminders("pending");
  const dueCount = pendingDueCount(reminders);

  const isActive = (slug: string) => {
    const href = `/${slug}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  /*
   * Which sections are open.
   *
   * Only the user's OWN toggles are stored. Everything else is derived from the
   * route, so walking into a section opens it with no effect, no listener and
   * nothing to keep in step with the URL. A section the user deliberately shut
   * stays shut, which is the whole point of letting them shut it.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const sectionOpen = (group: NavGroup) =>
    toggled[group.label] ?? group.items.some((item) => isActive(item.slug));

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      {/* Brand */}
      <div className="flex h-16 items-center border-b border-sidebar-border px-5">
        <Link
          href={homeForRole(role, enabledNavigation)}
          aria-label={brandName ?? "CaratSense"}
        >
          <Logo className="h-8 w-auto" name={brandName} isEclat={isEclat} />
        </Link>
      </div>

      <div className="space-y-2 border-b border-sidebar-border px-3 py-3">
        <QuickActionMenu />
        {/*
          Only when there is an index behind it. NEXT_PUBLIC_ENABLE_SEARCH is off
          by default because the search endpoint matches nothing yet, and a
          permanent "Search… Ctrl K" pill that finds nothing is a worse first
          impression than no pill at all. Flip the flag and rebuild and it
          appears — see lib/features.ts.
        */}
        {SEARCH_ENABLED ? <SearchPill /> : null}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {groups.map((group) => {
          const open = sectionOpen(group);
          const panelId = `nav-${group.label.replace(/\W+/g, "-").toLowerCase()}`;
          const activeInside = group.items.some((item) => isActive(item.slug));
          return (
            <div key={group.label} className="mb-1">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() =>
                  setToggled((prev) => ({ ...prev, [group.label]: !open }))
                }
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors",
                  activeInside
                    ? "text-sidebar-foreground/75"
                    : "text-sidebar-foreground/45 hover:text-sidebar-foreground/75",
                )}
              >
                <ChevronDown
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform duration-150",
                    open ? "" : "-rotate-90",
                  )}
                  aria-hidden
                />
                <span className="truncate">{t(`group.${group.label}`, group.label)}</span>
                {/* A closed section still has to say it holds where you are. */}
                {!open && activeInside ? (
                  <span
                    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sidebar-primary)]"
                    aria-hidden
                  />
                ) : null}
              </button>

              {open ? (
                <ul id={panelId} className="mb-3 space-y-0.5">
                  {group.items.map((item) => (
                    <NavRow
                      key={item.slug}
                      item={item}
                      active={isActive(item.slug)}
                      label={t(`nav.${item.slug}`, item.title)}
                      badgeCount={item.slug === "reminders" ? dueCount : 0}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border px-5 py-3">
        <p className="text-[11px] tracking-wide text-sidebar-foreground/50">
          {/*
            No tenant name as the fallback. The bootstrap is a network call, so
            on first paint and on any failure this line read "Eclat · CaratSense"
            in every tenant's sidebar — one customer's name shown to all the
            others. Until the real name arrives, show the product alone.
          */}
          {brandName ? `${brandName} · CaratSense` : "CaratSense"}
        </p>
      </div>
    </aside>
  );
}

function NavRow({
  item,
  active,
  label,
  badgeCount,
}: {
  item: NavItem;
  active: boolean;
  label: string;
  badgeCount: number;
}) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={`/${item.slug}`}
        title={item.purpose}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex items-center gap-3 rounded-lg py-2 pl-3 pr-2 text-sm transition-all duration-150",
          active
            ? "bg-white/[0.09] font-semibold text-white"
            : "text-sidebar-foreground hover:bg-white/[0.04] hover:text-white",
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4 shrink-0 transition-colors",
            active
              ? "text-[var(--sidebar-primary)]"
              : "text-sidebar-foreground/55 group-hover:text-white",
          )}
        />
        <span className="truncate">{label}</span>
        {badgeCount > 0 ? (
          <span
            aria-label={`${badgeCount} due`}
            className="num ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-primary)] px-1.5 text-[11px] font-semibold leading-none text-[var(--sidebar)]"
          >
            {badgeCount}
          </span>
        ) : null}
        {/* The micro indicator. On the right, after the badge, so the two never
            fight for the same pixels. */}
        {active ? (
          <span
            className={cn(
              "h-4 w-[3px] shrink-0 rounded-full bg-[var(--sidebar-primary)]",
              badgeCount > 0 ? "ml-1.5" : "ml-auto",
            )}
            aria-hidden
          />
        ) : null}
      </Link>
    </li>
  );
}

/**
 * Start the three things a floor team starts twenty times a day.
 *
 * Each one routes to the screen that OWNS the record and asks it to open its
 * own dialog (see store/use-quick-action). No second copy of the walk-in form
 * lives here — a duplicate form is a duplicate set of validation rules, and the
 * two drift the first time one of them is fixed.
 */
function QuickActionMenu() {
  const router = useRouter();
  const request = useQuickAction((s) => s.request);
  const role = useSession((s) => s.role);
  const enabledNavigation = useEnabledNavigation();
  const groups = visibleNavGroups(role, enabledNavigation);
  const allowed = new Set(groups.flatMap((g) => g.items.map((i) => i.slug)));

  const actions = [
    {
      slug: "checkins",
      label: "Log walk-in",
      icon: DoorOpen,
      run: () => {
        request("checkin");
        router.push("/checkins");
      },
    },
    {
      slug: "crm",
      label: "New lead",
      icon: UserPlus,
      run: () => {
        request("lead");
        router.push("/crm");
      },
    },
    {
      slug: "quotation",
      label: "Quick quote",
      icon: FileText,
      run: () => router.push("/quotation"),
    },
    // Nothing this role cannot reach. Offering a shortcut into a screen the
    // route guard then refuses is worse than not offering it.
  ].filter((a) => allowed.has(a.slug));

  if (!actions.length) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--sidebar-primary)] px-3 py-2 text-sm font-semibold text-[var(--sidebar)] transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4 shrink-0" aria-hidden />
          Quick Action
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {actions.map((a) => (
          <DropdownMenuItem key={a.slug} onSelect={a.run}>
            <a.icon className="mr-2 h-4 w-4" aria-hidden />
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Fires the same Ctrl/Cmd+K palette the topbar trigger opens. */
function SearchPill() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
      className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-sidebar-foreground/60 transition-colors hover:bg-white/[0.07] hover:text-white"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <span>Search…</span>
      <kbd className="ml-auto rounded border border-white/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide">
        Ctrl K
      </kbd>
    </button>
  );
}
