"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Boxes,
  CalendarCheck,
  DoorOpen,
  FileText,
  Gauge,
  PanelLeftClose,
  PanelLeftOpen,
  MessagesSquare,
  Plus,
  Search,
  Settings,
  Store,
  Upload,
  UserPlus,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";

import { GoldRateChip } from "@/components/layout/gold-rate-chip";
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
  type NavGroupLabel,
  type NavItem,
} from "@/lib/navigation";
import { SEARCH_ENABLED } from "@/lib/features";
import { pendingDueCount, useReminders } from "@/lib/queries/reminders";
import {
  useConfigBootstrap,
  useEnabledNavigation,
} from "@/lib/queries/tenant-config";
import { useSession } from "@/store/use-session";
import { useQuickAction } from "@/store/use-quick-action";
import { brandingName } from "@/lib/branding";
import { PRODUCT_NAME } from "@/lib/brand";
import { useT } from "@/lib/i18n";

/**
 * One mark per SECTION, which the comp does not supply: its ten rail items are
 * ten screens, and ours are seven doors onto forty-four. Each icon is the
 * plainest noun for the job a section does, chosen so none of them reads as one
 * of the screens inside it — Showroom is a shop, not a gem; Reports is a chart,
 * not a ledger.
 *
 * Typed against NavGroupLabel on purpose: adding a group to NAV_GROUP_ORDER
 * without an icon is then a build failure rather than a blank rail tile.
 */
const GROUP_ICONS: Record<NavGroupLabel, LucideIcon> = {
  "Command Centre": Gauge,
  "Customer Interactions": MessagesSquare,
  Showroom: Store,
  "Stock Management": Boxes,
  "HR & Teams": UsersRound,
  Reports: BarChart3,
  Setup: Settings,
};

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
  // Pending follow-ups due today or overdue → the Reminders nav badge, and the
  // dot on the rail tab of whichever section holds Reminders.
  const { data: reminders } = useReminders("pending");
  const dueCount = pendingDueCount(reminders);

  const isActive = (slug: string) => {
    const href = `/${slug}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  /*
   * Which section the second column is showing.
   *
   * The route decides it, so a link followed from anywhere — a notification, a
   * dashboard tile, a bookmark — always lands with its own section open. A rail
   * click is an override that lasts only while the route does: `at` records the
   * path it was made on, so navigating away hands the choice back to the route
   * without an effect that re-renders to reset state.
   */
  const [picked, setPicked] = useState<{ label: NavGroupLabel; at: string } | null>(null);
  /*
   * The secondary panel folds away, leaving the 96px rail.
   *
   * The rail answers "which section am I in" on its own, so on a laptop the
   * 176px list of screens is often just spent width — and the people who want
   * it back want it for one lookup, not permanently. Kept in component state
   * rather than persisted: a collapse is a working posture, and someone
   * returning tomorrow should get the full navigation back rather than a
   * sidebar they folded once and forgot.
   */
  const [panelOpen, setPanelOpen] = useState(true);
  const routeGroup = groups.find((g) => g.items.some((item) => isActive(item.slug)))?.label;
  const openLabel =
    (picked?.at === pathname && groups.some((g) => g.label === picked.label)
      ? picked.label
      : routeGroup) ?? groups[0]?.label;

  /*
   * Searching reaches across every section, not just the open one — otherwise
   * "/" could only find a quarter of the product, which is the whole reason the
   * box exists.
   */
  const searching = find.trim() !== "";
  const listed = searching ? shown : shown.filter((group) => group.label === openLabel);
  const panelId = "sidebar-section-panel";

  const cleanBrandDisplay =
    brandName && !/eclat|éclat/i.test(brandName)
      ? `${brandName} · ${PRODUCT_NAME}`
      : `${PRODUCT_NAME} Platform`;

  return (
    /*
      The comp's rail is 119.5px of centred icons with no room for a label like
      "Business Configuration", and its ten items are ten screens. Ours are
      seven sections holding forty-four, so the rail carries the SECTIONS and a
      second column lists the section's screens — the comp's treatment applied
      one level up. It is a column rather than a hover flyout because a flyout
      has no home for the screen-finder or the Quick Action, and because
      forty-four destinations behind a hover delay is a worse product than
      sixty-three pixels of width.
    */
    <aside /*
      272px total — the width of the single column this replaced.
      
      The rail-plus-panel came out at 327px, which is 55px MORE than the one
      column it was meant to tighten: a redesign that reads as cleaner while
      taking more of the screen is just a bigger sidebar. 96 for the rail and
      176 for the panel comes back to the original footprint, and the panel
      still fits the longest item label ("Message Templates") without wrapping.
    */
    className={cn(
      "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex",
      panelOpen ? "w-[272px]" : "w-24",
    )}>
      {/* The comp's header runs the full width of the screen with the lockup at
          its left end; our shell makes the top bar a sibling of the rail rather
          than its parent, so the lockup keeps the comp's position by sitting in
          a block of the header's own 70.3px height. The two read as one bar. */}
      <div className={cn("flex h-[70px] shrink-0 items-center gap-1 border-b border-sidebar-border", panelOpen ? "px-4" : "justify-center px-2")}>
        <Link
          href={homeForRole(role, enabledNavigation, access)}
          aria-label={brandName ?? PRODUCT_NAME}
          className="flex min-w-0 items-center"
        >
          {/* At 96px the two-line lockup clips to "NIBH…" — the mark alone is
              the conventional collapsed state and stays legible. */}
          <Logo className="h-8 w-auto" name={brandName} markOnly={!panelOpen} />
        </Link>

        {/*
          The fold control, in the header rather than at the foot of the rail.

          It belongs to the RAIL and not to the panel — a button that lives
          inside the thing it hides cannot bring it back — but "in the rail"
          had put it last, under seven 95x72 section tiles, where `mt-auto` in
          a column that had run out of room squashed it to 44x30 and it read as
          an eighth, smaller nav item. It was working the whole time; nobody
          could find it. Up here it sits where this control conventionally does,
          it is the only other thing in the header, and `shrink-0` means a full
          rail can no longer compress it.
        */}
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          aria-controls={panelId}
          title={panelOpen ? "Collapse the section list" : "Expand the section list"}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-sidebar-border text-sidebar-foreground transition-colors hover:bg-accent hover:text-foreground",
            panelOpen && "ml-auto",
          )}
        >
          {panelOpen ? (
            <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden />
          ) : (
            <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden />
          )}
          <span className="sr-only">
            {panelOpen ? "Collapse the section list" : "Expand the section list"}
          </span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Sections"
          /*
            96px, not the comp's 119.5.
            
            That width was measured from a rail of single words — Orders,
            Products, Finance. Ours carries two-word group names, so the same
            box reads broad and the sidebar came out at 327px total against the
            272px single column it replaced: the navigation got WIDER while
            looking like it had been tightened. 96px still clears the longest
            unbreakable word ("Interactions", 12 characters at 11px) on one
            line, so nothing hyphenates.
          */
          className="flex w-24 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border py-1.5 scrollbar-thin"
        >
          {/*
            The one action, at the top of the one rail.
            
            It sat in the secondary panel, which meant the app's primary verb
            disappeared whenever that panel was collapsed — and it is the only
            control on the sidebar that creates something rather than navigating
            to it. A compact tile keeps it reachable from every section without
            spending a 176px-wide bar of accent colour on it.
          */}
          <div className="mb-1 flex justify-center px-2 pb-1.5">
            <QuickActionMenu />
          </div>
          <ul>
            {groups.map((group) => (
              <GroupTab
                key={group.label}
                group={group}
                label={t(`group.${group.label}`, group.label)}
                // Stays marked while somebody types in the finder, which is
                // showing matches from every section: the rail has to keep
                // answering "where am I" through the two seconds of search.
                open={group.label === openLabel}
                panelId={panelId}
                // The dot survives the section being closed, which is the point
                // of it: work owed to a customer should be visible from the rail
                // while somebody is three sections away in Stock Management.
                pending={group.items.some((item) => item.slug === "reminders") ? dueCount : 0}
                onOpen={() => {
                  setPicked({ label: group.label, at: pathname });
                  setFind("");
                }}
              />
            ))}
          </ul>

        </nav>

        {panelOpen ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-col gap-2 border-b border-sidebar-border px-3 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/50" aria-hidden />
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
                className="w-full rounded-[8.438px] border border-input bg-background py-2 pl-8.5 pr-7 text-[13px] text-foreground placeholder:text-sidebar-foreground/60 outline-none transition-colors focus:border-sidebar-ring [&::-webkit-search-cancel-button]:hidden"
              />
              {find ? (
                <button
                  type="button"
                  onClick={() => setFind("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-sidebar-foreground/60 hover:text-sidebar-accent-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                  <span className="sr-only">Clear</span>
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/50">
                  /
                </kbd>
              )}
            </div>
          </div>

          <div id={panelId} className="flex-1 overflow-y-auto px-2.5 py-2 scrollbar-thin">
            {searching && !listed.length ? (
              <p className="px-2 py-2 text-xs text-sidebar-foreground/70">
                No screen matches &ldquo;{find.trim()}&rdquo;.
              </p>
            ) : null}
            {listed.map((group) => (
              <div key={group.label} className="mb-2">
                <div className="flex items-baseline gap-1.5 px-2 pb-1.5 pt-1">
                  <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-foreground/70">
                    {t(`group.${group.label}`, group.label)}
                  </span>
                  <span className="num ml-auto shrink-0 text-[10px] font-medium text-sidebar-foreground/45">
                    {group.items.length}
                  </span>
                </div>
                <ul className="space-y-0.5">
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
              </div>
            ))}
          </div>

          {/* System info & Footer */}
          <div className="border-t border-sidebar-border px-3 py-2.5">
            {/* The gold rate moved here from the top bar (client, 7 Oct): a rail
                item rather than a number broadcast at the top of every screen. */}
            <div className="mb-2">
              <GoldRateChip />
            </div>
            <div className="flex items-center justify-between gap-2 rounded-[9.844px] bg-accent px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <p className="truncate text-[11px] font-medium text-sidebar-foreground">
                  {cleanBrandDisplay}
                </p>
              </div>
              <span className="num shrink-0 text-[10px] text-sidebar-foreground/50">v2.4</span>
            </div>
          </div>
        </div>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * A rail tile, at the comp's dimensions: a 25.3px icon over a 14px label in an
 * ~82px tile, washed #f9eded behind a 5.6px maroon left border when it is the open
 * one. The border is declared on every tile and only coloured on the open one,
 * so opening a section cannot nudge its neighbours' labels sideways.
 */
function GroupTab({
  group,
  label,
  open,
  panelId,
  pending,
  onOpen,
}: {
  group: NavGroup;
  label: string;
  open: boolean;
  panelId: string;
  pending: number;
  onOpen: () => void;
}) {
  const Icon = GROUP_ICONS[group.label];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        aria-controls={panelId}
        title={label}
        /*
          The comp's 82px is built out of the parts — 9 + 25 + 4 + 35 + 9 — and
          not asked for with `min-h-[82px]`, because the `pointer: coarse` touch
          floor in globals.css is deliberately unlayered and so outranks any
          min-height utility written here. A tile that relied on one would
          collapse to its content on exactly the showroom tablets the floor is
          for, and one- and two-line labels would then sit at different heights.
          The label box is fixed and clamped for the same reason: a long
          translation shortens to two lines instead of growing the tile.
        */
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1 border-l-4 px-1 py-2 text-center transition-colors",
          open
            ? "border-l-[var(--sidebar-primary)] bg-sidebar-accent text-sidebar-accent-foreground"
            : "border-l-transparent text-sidebar-foreground hover:bg-accent",
        )}
      >
        <span className="relative">
          <Icon className="h-[22px] w-[22px]" aria-hidden />
          {pending > 0 ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-[var(--sidebar-primary)] ring-2 ring-sidebar"
            />
          ) : null}
        </span>
        <span className="flex h-[30px] items-center">
          <span className="line-clamp-2 text-[11px] font-medium leading-[1.25]">{label}</span>
        </span>
        <span className="sr-only">
          {group.items.length} screens{pending > 0 ? `, ${pending} due` : ""}
        </span>
      </button>
    </li>
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
          "group flex items-center gap-2 rounded-[8.438px] py-1.5 pl-2 pr-1.5 text-[13px] transition-colors",
          active
            ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
            : "font-medium text-sidebar-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4 shrink-0 transition-colors",
            active ? "text-[var(--sidebar-primary)]" : "text-sidebar-foreground/70",
          )}
        />
        <span className="truncate">{label}</span>
        {badgeCount > 0 ? (
          <span
            aria-label={`${badgeCount} due`}
            className="num ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-primary)] px-1 text-[10px] font-semibold leading-none text-[var(--sidebar-primary-foreground)]"
          >
            {badgeCount}
          </span>
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
    {
      // Gated on the hrms slug (visible to every ladder role) because the
      // self-punch screen /check-in deliberately has no nav entry of its own.
      // A manager lands on HRMS with the marking dialog already open; everyone
      // else goes to their own punch screen.
      slug: "hrms",
      label: "Mark attendance",
      icon: CalendarCheck,
      run: () => {
        if (role === "store_manager" || role === "area_manager") {
          request("attendance");
          router.push("/hrms");
        } else if (role === "head_office") {
          router.push("/hrms");
        } else {
          router.push("/check-in");
        }
      },
    },
    {
      // Manager-and-above by the data slug's own nav roles, which mirror the
      // import endpoints' guard — a salesperson never sees this shortcut.
      slug: "data",
      label: "Customer Data & Imports",
      icon: Upload,
      run: () => {
        request("import");
        router.push("/data");
      },
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
          /*
            Sized to its label, not to the rail.
            
            `w-full` made this a 272px slab of solid red — by some margin the
            largest block of accent colour on any screen, and sitting directly
            above a full-width search box it read as a banner rather than a
            button. The accent is supposed to mark the one thing worth pressing;
            at that size it marks the furniture.
          */
          title="Quick action"
          aria-label="Quick action"
          /*
            A 44px square in a 96px rail: the icon alone, with the label carried
            by `aria-label` and the tooltip. The rail is 96px and the words
            "Quick Action" need about 88 of them at 13px, which would leave the
            tile edge-to-edge and heavier than the section tiles beneath it.
            44px is also the touch floor, so the showroom tablets keep a real
            target.
          */
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--sidebar-primary)] text-[var(--sidebar-primary-foreground)] transition-opacity hover:opacity-90"
        >
          <Plus className="h-5 w-5 shrink-0" aria-hidden />
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
