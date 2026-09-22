"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, DoorOpen, FileText, Plus, Search, UserPlus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  filterNavGroups,
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
import { brandingName } from "@/lib/branding";
import { useT } from "@/lib/i18n";

export function Sidebar() {
  const pathname = usePathname();
  const t = useT();
  // Role-aware nav: HO-only sections (e.g. Store Setup) stay hidden otherwise.
  const role = useSession((s) => s.baseRole);
  const access = useSession((s) => s.access);
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
  const groups = visibleNavGroups(role, enabledNavigation, access);

  /*
   * Find a screen by typing its name. "/" jumps here from anywhere that is not
   * a text field, and so does Ctrl/Cmd+K while the record search is switched
   * off. Enter opens the first match, Esc clears.
   */
  const router = useRouter();
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const shown = filterNavGroups(groups, find, (item) => t(`nav.${item.slug}`, item.title));
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const ctrlK = !SEARCH_ENABLED && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      if (ctrlK || (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // Pending follow-ups due today or overdue → the Reminders nav badge.
  const { data: reminders } = useReminders("pending");
  const dueCount = pendingDueCount(reminders);

  const isActive = (slug: string) => {
    const href = `/${slug}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  /*
   * Sections default to open so features are easily discoverable and the
   * full vertical sidebar space is utilized gracefully. Users can toggle
   * individual sections closed as preferred.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const sectionOpen = (group: NavGroup) =>
    find.trim() !== "" || (toggled[group.label] ?? true);

  const toggleAll = (openState: boolean) => {
    const next: Record<string, boolean> = {};
    for (const g of groups) {
      next[g.label] = openState;
    }
    setToggled(next);
  };

  const isAllCollapsed = groups.every((g) => toggled[g.label] === false);

  const cleanBrandDisplay =
    brandName && !/eclat|éclat/i.test(brandName)
      ? `${brandName} · CaratOS`
      : "CaratOS Platform";

  return (
    <aside className="hidden w-68 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      {/* Brand */}
      <div className="flex h-16 items-center border-b border-sidebar-border px-5">
        <Link
          href={homeForRole(role, enabledNavigation)}
          aria-label={brandName ?? "CaratOS"}
          className="flex items-center"
        >
          <Logo className="h-8 w-auto" name={brandName} />
        </Link>
      </div>

      <div className="space-y-2 border-b border-sidebar-border px-3.5 py-3">
        <QuickActionMenu />
        {SEARCH_ENABLED ? <SearchPill /> : null}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-sidebar-foreground/50" aria-hidden />
          <input
            ref={findRef}
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              const first = shown[0]?.items[0];
              if (e.key === "Enter" && first) {
                router.push(`/${first.slug}`);
                setFind("");
                findRef.current?.blur();
              } else if (e.key === "Escape") {
                setFind("");
                findRef.current?.blur();
              }
            }}
            placeholder="Find a screen…"
            aria-label="Find a screen"
            className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2 pl-9 pr-8 text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/50 outline-none transition-colors focus:border-white/25 focus:bg-white/[0.07] [&::-webkit-search-cancel-button]:hidden"
          />
          {find ? (
            <button
              type="button"
              onClick={() => setFind("")}
              className="absolute right-2 top-2 rounded p-0.5 text-sidebar-foreground/60 hover:text-white"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Clear</span>
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2.5 top-2 rounded border border-white/15 px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/50">
              /
            </kbd>
          )}
        </div>
      </div>

      {/* Nav section controls header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[11px] font-medium text-sidebar-foreground/50">
        <span className="uppercase tracking-wider font-semibold">Workspace</span>
        <button
          type="button"
          onClick={() => toggleAll(isAllCollapsed)}
          className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/[0.06] hover:text-sidebar-foreground/80 transition-colors"
          title={isAllCollapsed ? "Expand all sections" : "Collapse all sections"}
        >
          {isAllCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
        {find.trim() && !shown.length ? (
          <p className="px-2.5 py-2 text-xs text-sidebar-foreground/60">No screen matches &ldquo;{find.trim()}&rdquo;.</p>
        ) : null}
        {shown.map((group) => {
          const open = sectionOpen(group);
          const panelId = `nav-${group.label.replace(/\W+/g, "-").toLowerCase()}`;
          const activeInside = group.items.some((item) => isActive(item.slug));
          return (
            <div key={group.label} className="mb-2">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() =>
                  setToggled((prev) => ({ ...prev, [group.label]: !open }))
                }
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-bold uppercase tracking-wider transition-colors",
                  activeInside
                    ? "text-sidebar-foreground font-bold bg-white/[0.04]"
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground/90 hover:bg-white/[0.02]",
                )}
              >
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 transition-transform duration-200 text-sidebar-foreground/50",
                    open ? "" : "-rotate-90",
                  )}
                  aria-hidden
                />
                <span className="truncate">{t(`group.${group.label}`, group.label)}</span>
                <span className="ml-auto text-[10px] font-mono font-medium text-sidebar-foreground/35">
                  {group.items.length}
                </span>
                {!open && activeInside ? (
                  <span
                    className="ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sidebar-primary)]"
                    aria-hidden
                  />
                ) : null}
              </button>

              {open ? (
                <ul id={panelId} className="mt-1 mb-2.5 space-y-1">
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

      {/* System info & Footer */}
      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center justify-between rounded-lg bg-white/[0.025] px-2.5 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            <p className="truncate text-xs font-medium text-sidebar-foreground/80">
              {cleanBrandDisplay}
            </p>
          </div>
          <span className="text-[10px] font-mono text-sidebar-foreground/40 shrink-0">v2.4</span>
        </div>
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
          "group relative flex items-center gap-3 rounded-lg py-2.5 pl-3.5 pr-3 text-sm font-medium transition-all duration-150",
          active
            ? "bg-white/[0.09] font-semibold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.09),0_0_18px_-6px_var(--sidebar-primary)]"
            : "text-sidebar-foreground/80 hover:bg-white/[0.04] hover:text-white",
        )}
      >
        <Icon
          className={cn(
            "h-4.5 w-4.5 shrink-0 transition-colors",
            active
              ? "text-[var(--sidebar-primary)]"
              : "text-sidebar-foreground/60 group-hover:text-white",
          )}
        />
        <span className="truncate text-[13.5px]">{label}</span>
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
  const role = useSession((s) => s.baseRole);
  const access = useSession((s) => s.access);
  const enabledNavigation = useEnabledNavigation();
  const groups = visibleNavGroups(role, enabledNavigation, access);
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
