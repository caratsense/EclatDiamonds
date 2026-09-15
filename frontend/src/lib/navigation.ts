import {
  type LucideIcon,
  Users,
  FileText,
  Gem,
  RotateCcw,
  Percent,
  PiggyBank,
  Boxes,
  Fingerprint,
  DoorOpen,
  LayoutDashboard,
  Banknote,
  BarChart3,
  Building2,
  Megaphone,
  LifeBuoy,
  BellRing,
  Store,
  Trophy,
  ClipboardCheck,
  GitCompare,
  UsersRound,
  ScrollText,
  Target,
  MessageSquarePlus,
  Contact,
  Coins,
  ArrowLeftRight,
  Receipt,
  Inbox,
  SlidersHorizontal,
  Plug,
  Database,
  ListChecks,
  Send,
  Globe,
  Smartphone,
  PhoneCall,
  MessageSquareHeart,
  Timer,
  Archive,
  Tags,
  CalendarClock,
  Images,
  PackageX,
  Receipt as ReceiptIcon,
  Gift,
  Radio,
  Route,
  ListTodo,
} from "lucide-react";

import type { Role } from "@/lib/types";

/**
 * Sidebar sections, in the order they are rendered.
 *
 * Grouped by the JOB somebody is doing, not by the module numbers in
 * MODULES.md. The previous shape had a fourteen-item "Sales" bucket holding the
 * unified inbox, the calling queue, the catalogue, returns, discounts, the
 * loyalty scheme and the leaderboard — seven different jobs done by four
 * different people. At fourteen items nobody scans a list; they hunt it.
 *
 * Nine sections, none longer than seven, each one a role's actual working day.
 */
export const NAV_GROUP_ORDER = [
  "Overview & Analytics",
  "Omnichannel & CRM",
  "Showroom Floor",
  "Commerce & Orders",
  "Inventory & Supply",
  "Marketing & Inbound",
  "Team & Workforce",
  "Back-office & Approvals",
  "Administration",
] as const;

export type NavGroupLabel = (typeof NAV_GROUP_ORDER)[number];

export interface NavItem {
  /** Module number from MODULES.md. */
  module: number;
  /** Route segment under (app). */
  slug: string;
  title: string;
  /** One-line purpose, lifted from MODULES.md. */
  purpose: string;
  /** Label for the primary action on the section header. */
  primaryAction: string;
  icon: LucideIcon;
  /** Which sidebar section this belongs to. */
  group: NavGroupLabel;
  /**
   * Roles allowed to see this item. Undefined = visible to everyone.
   * Drives role-aware nav visibility (never hardcode per-screen).
   */
  roles?: Role[];
}

export interface NavGroup {
  label: NavGroupLabel;
  items: NavItem[];
}

/**
 * Single source of truth for navigation + section headers.
 *
 * ONE flat list, with each item naming its own section. `NAV_GROUPS` is derived
 * below, so an item can never be in two sections, or in none — which is what
 * happened every time the groups were separate arrays somebody had to move
 * entries between by hand.
 *
 * Every section is store-scoped + role-aware; role filtering is applied by
 * `visibleNavGroups`.
 */
export const NAV_ITEMS: NavItem[] = [
  /* ------------------------------------------- Overview & Analytics */
  {
    module: 3,
    slug: "dashboards",
    title: "Dashboards",
    purpose: "Your store's key numbers and shared team tasks.",
    primaryAction: "New Task",
    icon: LayoutDashboard,
    group: "Overview & Analytics",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "reporting",
    title: "Reporting & DSR",
    purpose: "Automated daily sales reports and store analytics.",
    primaryAction: "Generate DSR",
    icon: BarChart3,
    group: "Overview & Analytics",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "store-comparison",
    title: "Store Comparison",
    purpose: "Revenue, orders and staff across all stores, side by side.",
    primaryAction: "",
    icon: GitCompare,
    group: "Overview & Analytics",
    roles: ["store_manager", "area_manager", "head_office"],
  },

  /* ------------------------------------------- Omnichannel & CRM */
  {
    // CaratOS Phase A3 — the unified inbox. Channel-neutral: WhatsApp today,
    // any other channel once its adapter exists, with no change to this screen.
    module: 1,
    slug: "conversations",
    title: "Conversations",
    purpose: "Every customer message, on every channel, in one place.",
    primaryAction: "",
    icon: Inbox,
    group: "Omnichannel & CRM",
  },
  {
    module: 1,
    slug: "crm",
    title: "CRM & Leads",
    purpose: "Leads and follow-ups for every customer enquiry.",
    primaryAction: "New Lead",
    icon: Users,
    group: "Omnichannel & CRM",
  },
  {
    module: 1,
    slug: "calling",
    title: "Calling",
    purpose:
      "Every follow-up owed to a customer, oldest first, with the history on one screen before you dial.",
    primaryAction: "",
    icon: PhoneCall,
    group: "Omnichannel & CRM",
    roles: ["salesperson", "store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "reminders",
    title: "Reminders",
    purpose: "Today's and overdue lead follow-ups.",
    primaryAction: "",
    icon: BellRing,
    group: "Omnichannel & CRM",
  },
  {
    module: 1,
    slug: "customers",
    title: "Customers",
    purpose:
      "Your store's customer directory — contacts, purchase history and key dates.",
    primaryAction: "",
    icon: Contact,
    group: "Omnichannel & CRM",
  },
  {
    module: 1,
    slug: "feedback",
    title: "Feedback",
    purpose:
      "Ask a customer how it went; an unhappy answer reaches a person, not a public review page.",
    primaryAction: "",
    icon: MessageSquareHeart,
    group: "Omnichannel & CRM",
    roles: ["salesperson", "store_manager", "area_manager", "head_office"],
  },

  /* ------------------------------------------- Showroom Floor */
  {
    module: 7,
    slug: "instore",
    title: "In-Store App",
    purpose:
      "Find a walk-in, see what they came for, and record the visit from a phone.",
    primaryAction: "",
    icon: Smartphone,
    group: "Showroom Floor",
    roles: ["salesperson", "store_manager", "area_manager", "head_office"],
  },
  {
    module: 7,
    slug: "checkins",
    title: "Check-ins & Footfall",
    purpose: "Log walk-ins and assign each customer to a sales rep.",
    primaryAction: "Log Check-in",
    icon: DoorOpen,
    group: "Showroom Floor",
  },

  /* ------------------------------------------- Commerce & Orders */
  {
    module: 5,
    slug: "catalogue",
    title: "Catalogue",
    purpose: "Browse products across stores; search by photo.",
    primaryAction: "Add Product",
    icon: Gem,
    group: "Commerce & Orders",
  },
  {
    module: 2,
    slug: "quotation",
    title: "Quotation & Orders",
    purpose:
      "Build quotes and custom orders; custom orders route to production.",
    primaryAction: "New Quote",
    icon: FileText,
    group: "Commerce & Orders",
  },
  {
    module: 12,
    slug: "payments",
    title: "Sales & Payments",
    purpose:
      "Record sales with advance and balance, and track collections and bank reconciliation.",
    primaryAction: "New Sale",
    icon: Receipt,
    group: "Commerce & Orders",
    // Store-level collections ledger + reconciliation is a manager view
    // (matches Finance/Reporting/Targets gating). If salespeople need to
    // record direct sales at the counter, widen this — open product decision.
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 15,
    slug: "discounts",
    title: "Discounts",
    purpose: "Request and approve discounts with live margin checks.",
    primaryAction: "Request Discount",
    icon: Percent,
    group: "Commerce & Orders",
  },
  {
    module: 14,
    slug: "returns",
    title: "Returns & Exchange",
    purpose: "Returns, exchanges, buyback, repairs and old-gold trade-ins.",
    primaryAction: "New Intake",
    icon: RotateCcw,
    group: "Commerce & Orders",
  },
  {
    module: 17,
    slug: "loyalty",
    title: "Loyalty & Referral",
    purpose: "Gold-savings schemes and the customer referral wallet.",
    primaryAction: "Enroll Customer",
    icon: PiggyBank,
    group: "Commerce & Orders",
  },

  /* ------------------------------------------- Inventory & Supply */
  {
    module: 9,
    slug: "inventory",
    title: "Inventory & Stock",
    purpose: "Stock levels, aging lines and scrap recovery.",
    primaryAction: "Stock Entry",
    icon: Boxes,
    group: "Inventory & Supply",
    // Store managers see their own store's stock; area/HO see all stores.
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 9,
    slug: "stock-transfers",
    title: "Stock Transfers",
    purpose:
      "Move stock between branches — request, Head-Office approval, dispatch and receipt.",
    primaryAction: "New Transfer",
    icon: ArrowLeftRight,
    group: "Inventory & Supply",
    // Salespeople have no actions here; store managers run the movements,
    // area/HO oversee + approve.
    roles: ["store_manager", "area_manager", "head_office"],
  },

  /* ------------------------------------------- Marketing & Inbound */
  {
    /*
     * Module 1 (CRM), not 16 (Marketing). Campaigns are outreach to the
     * CRM's own customers and are enabled for every industry pack;
     * "Marketing" below is Eclat's agency-planning module and stays
     * jewellery-gated.
     */
    module: 1,
    slug: "campaigns",
    title: "Campaigns",
    purpose:
      "Send one approved message to a group of customers, with consent checked per person.",
    primaryAction: "New Campaign",
    icon: Send,
    group: "Marketing & Inbound",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "lead-forms",
    title: "Enquiry Forms",
    purpose:
      "Publish a form for your own website that files enquiries straight into a branch.",
    primaryAction: "Publish Form",
    icon: Globe,
    group: "Marketing & Inbound",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 16,
    slug: "marketing",
    title: "Marketing",
    purpose: "Plan campaigns and track agency deliverables.",
    primaryAction: "New Campaign",
    icon: Megaphone,
    group: "Marketing & Inbound",
    roles: ["store_manager", "area_manager", "head_office"],
  },

  /* ------------------------------------------- Team & Workforce */
  {
    module: 6,
    slug: "settings/team",
    title: "Team",
    purpose: "Add staff, assign roles and stores within your scope.",
    primaryAction: "Add Staff",
    icon: UsersRound,
    group: "Team & Workforce",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 6,
    slug: "hrms",
    title: "HRMS & Attendance",
    purpose: "Geo-attendance, rosters, leave and regularization.",
    primaryAction: "Mark Attendance",
    icon: Fingerprint,
    group: "Team & Workforce",
  },
  {
    module: 6,
    slug: "sales-performance",
    title: "Sales Performance",
    purpose: "Sales leaderboard, commission and incentives.",
    primaryAction: "",
    icon: Trophy,
    group: "Team & Workforce",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "settings/targets",
    title: "Targets",
    purpose: "Set monthly sales targets per store and track achievement.",
    primaryAction: "",
    icon: Target,
    group: "Team & Workforce",
    roles: ["store_manager", "area_manager", "head_office"],
  },

  /* ------------------------------------------- Back-office & Approvals */
  {
    module: 3,
    slug: "approvals",
    title: "Approvals",
    purpose: "Discount, return and leave requests awaiting your approval.",
    primaryAction: "",
    icon: ClipboardCheck,
    group: "Back-office & Approvals",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 3,
    slug: "requests",
    title: "Branch Requests",
    // Visible to every role: a salesperson at the counter is often the one
    // who needs a diamond rate approved, and their view is filtered to their
    // own requests server-side.
    purpose:
      "Ask your manager, area office or head office for a decision — diamond rates, price overrides, transfers and more.",
    primaryAction: "New Request",
    icon: MessageSquarePlus,
    group: "Back-office & Approvals",
  },
  {
    module: 13,
    slug: "ticketing",
    title: "Ticketing",
    purpose: "Raise and track operational issues with the back office.",
    primaryAction: "New Ticket",
    icon: LifeBuoy,
    group: "Back-office & Approvals",
  },
  {
    module: 4,
    slug: "finance",
    title: "Finance & Fund Planning",
    purpose: "Ledgers, budgets, cash flow and expansion costs.",
    primaryAction: "Add Entry",
    icon: Banknote,
    group: "Back-office & Approvals",
    roles: ["store_manager", "area_manager", "head_office"],
  },

  /* ------------------------------------------- Administration */
  {
    // CaratOS Phase A11 — live setup state, not a one-time wizard.
    module: 11,
    slug: "settings/onboarding",
    title: "Getting Started",
    purpose:
      "What is set up and what is left — industry, locations, team, data and channels.",
    primaryAction: "",
    icon: ListChecks,
    group: "Administration",
    roles: ["head_office"],
  },
  {
    module: 11,
    slug: "settings/stores",
    title: "Store Setup",
    // "Gati" is one jewellery tenant's ERP connector, and naming it here put
    // a vendor no other industry has ever heard of in front of every tenant.
    // The sentence says what the screen does; which system a branch arrived
    // from is the connector's business, not the navigation's.
    purpose:
      "Add branches, review the ones a connected system has sent through, and assign logins.",
    primaryAction: "Add Store",
    icon: Store,
    group: "Administration",
    roles: ["head_office"],
  },
  {
    /*
     * Opening a branch is administration, not day-to-day management.
     *
     * It sits beside Store Setup because that is where somebody goes when a new
     * location is happening, and it is the one item the section list in the
     * brief did not place — leaving it out of the file entirely would have
     * deleted a working screen from the product, which a regrouping must not do.
     */
    module: 11,
    slug: "new-store",
    title: "New-Store Setup",
    purpose: "Tasks and timelines for opening new stores.",
    primaryAction: "New Project",
    icon: Building2,
    group: "Administration",
    roles: ["head_office"],
  },
  {
    // CaratOS Phase A2 — the screen that makes the product industry-neutral.
    module: 11,
    slug: "settings/configuration",
    title: "Business Configuration",
    purpose:
      "Your industry, what your business calls things, and which fields your team fills in.",
    primaryAction: "",
    icon: SlidersHorizontal,
    group: "Administration",
    roles: ["head_office"],
  },
  {
    module: 2,
    slug: "settings/rates",
    title: "Gold Rate",
    purpose:
      "The live gold rate every new quote is priced from — auto-updates from the market; override it here if needed.",
    primaryAction: "",
    icon: Coins,
    group: "Administration",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    // CaratOS Phase A5 — per-organisation connections and credentials.
    module: 11,
    slug: "settings/integrations",
    title: "Integrations",
    purpose: "Connect the systems and channels your business already uses.",
    primaryAction: "",
    icon: Plug,
    group: "Administration",
    roles: ["head_office"],
  },
  {
    // CaratOS Phase A7 — bring existing records in, and see what each
    // source has actually delivered. store_manager+ because onboarding data
    // is a management action (matches ImportController's own guard).
    module: 11,
    slug: "data",
    title: "Data & Imports",
    purpose:
      "Import your existing records and check what each connected system has delivered.",
    primaryAction: "",
    icon: Database,
    group: "Administration",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 3,
    slug: "settings/audit",
    title: "Audit Log",
    purpose:
      "A record of approvals, role changes and other sensitive actions.",
    primaryAction: "",
    icon: ScrollText,
    group: "Administration",
    roles: ["store_manager", "area_manager", "head_office"],
  },

  /* ----------------------------------------------------------------------
   * Screens that existed but could not be reached.
   *
   * Each of these was built, tested and deployed, and then discoverable only
   * by somebody typing its address. A feature nobody can find is a feature
   * nobody uses, and "it is in the product" stops being true in any way the
   * customer would recognise.
   *
   * They are sub-routes of the sections they belong to rather than new
   * sections, so the nine-section shape holds and each one sits next to the
   * screen a person would have been looking at when they wanted it.
   * -------------------------------------------------------------------- */
  {
    module: 3,
    slug: "management",
    title: "Management View",
    purpose:
      "Leads, conversations, follow-ups, the floor, quotes and feedback across every branch, over a period you choose.",
    primaryAction: "",
    icon: BarChart3,
    group: "Overview & Analytics",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "reporting/scheduled",
    title: "Scheduled Reports",
    purpose: "Reports that send themselves at month-end, and what happened to the last one.",
    primaryAction: "New schedule",
    icon: CalendarClock,
    group: "Overview & Analytics",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "conversations/sla",
    title: "Response SLA",
    purpose:
      "The promise to answer within five minutes, measured — who is late, and who was told.",
    primaryAction: "",
    icon: Timer,
    group: "Omnichannel & CRM",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "customers/archived",
    title: "Archived Contacts",
    purpose:
      "People taken out of the working lists. Their consent history is kept, which is what stops them being messaged again.",
    primaryAction: "",
    icon: Archive,
    group: "Omnichannel & CRM",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "tasks",
    title: "Tasks",
    purpose: "Everything owed to a customer or a colleague, in one list.",
    primaryAction: "New Task",
    icon: ListTodo,
    group: "Omnichannel & CRM",
  },
  {
    module: 9,
    slug: "inventory/dead-stock",
    title: "Dead Stock",
    purpose:
      "Pieces that have not moved, against thresholds you set per category rather than one number for everything.",
    primaryAction: "",
    icon: PackageX,
    group: "Inventory & Supply",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 17,
    slug: "loyalty/programme",
    title: "Points Programme",
    purpose:
      "What a purchase earns, what a point is worth, and the key your own website signs in with.",
    primaryAction: "",
    icon: Gift,
    group: "Commerce & Orders",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 6,
    slug: "hrms/payroll",
    title: "Roster & Pay",
    purpose:
      "Each person's own weekly off, and a payslip counted from the attendance register.",
    primaryAction: "",
    icon: ReceiptIcon,
    group: "Team & Workforce",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "settings/staff-digest",
    title: "Morning Digest",
    purpose:
      "The message that tells somebody what they owe a customer today, and exactly what it would say.",
    primaryAction: "",
    icon: BellRing,
    group: "Administration",
  },
  {
    module: 1,
    slug: "settings/lead-tags",
    title: "Lead Tags",
    purpose: "Your own labels for a lead, and what they mean.",
    primaryAction: "New tag",
    icon: Tags,
    group: "Administration",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 11,
    slug: "data/images",
    title: "Product Images",
    purpose:
      "Match a folder of photographs to the products you already have, and reuse the column mapping you worked out last month.",
    primaryAction: "",
    icon: Images,
    group: "Administration",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "settings/messaging-routes",
    title: "Messaging Routes",
    purpose:
      "Which of your numbers each branch answers on, so a customer is replied to by the shop they wrote to.",
    primaryAction: "",
    icon: Route,
    group: "Administration",
    roles: ["head_office"],
  },
  {
    module: 1,
    slug: "settings/channels",
    title: "Channels",
    purpose:
      "What can actually reach a customer today, and what is missing where it cannot.",
    primaryAction: "",
    icon: Radio,
    group: "Administration",
  },
];


/** Sections in render order, derived — never maintained by hand. */
export const NAV_GROUPS: NavGroup[] = NAV_GROUP_ORDER.map((label) => ({
  label,
  items: NAV_ITEMS.filter((item) => item.group === label),
})).filter((group) => group.items.length > 0);

/**
 * The independently sellable, industry-neutral product surface. Keep this in
 * step with the backend industry-pack CORE_NAVIGATION list. It is also the safe
 * UI fallback while a tenant has no resolvable pack: vertical modules stay
 * hidden, while CRM, catalogue, attendance and administration remain usable.
 */
export const CORE_NAVIGATION: readonly string[] = Object.freeze([
  "crm",
  "conversations",
  "customers",
  "customers/archived",
  "conversations/sla",
  "tasks",
  "reminders",
  "catalogue",
  "checkins",
  "hrms",
  "hrms/payroll",
  "settings/onboarding",
  "settings/stores",
  "settings/team",
  "settings/configuration",
  "settings/staff-digest",
  "settings/lead-tags",
  "settings/messaging-routes",
  "settings/channels",
  "data",
  "data/images",
  "settings/integrations",
  "settings/audit",
]);

export function getNavItem(slug: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.slug === slug);
}

/** Whether a role may see a nav item (undefined roles = everyone). */
export function canSeeNavItem(item: NavItem, role: Role): boolean {
  return !item.roles || item.roles.includes(role);
}

/**
 * Nav groups filtered to what `role` may see, with empty groups dropped.
 * Keeps the sidebar + mobile nav role-aware from a single source of truth.
 */
export function visibleNavGroups(
  role: Role,
  enabledNavigation?: readonly string[],
): NavGroup[] {
  const enabled = enabledNavigation?.length
    ? new Set(enabledNavigation)
    : undefined;
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => canSeeNavItem(item, role) && (!enabled || enabled.has(item.slug)),
    ),
  })).filter((group) => group.items.length > 0);
}

/** Read the fresh-tenant feature profile defensively from Organisation.settings. */
export function navigationFromSettings(
  settings: Record<string, unknown> | undefined,
): string[] | undefined {
  const profile = settings?.featureProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return undefined;
  }
  const value = (profile as Record<string, unknown>).enabledNavigation;
  if (!Array.isArray(value)) return undefined;
  const routes = value.filter((item): item is string => typeof item === "string");
  return routes.length ? routes : undefined;
}

/**
 * Landing route per role. A salesperson has no Dashboards/Reporting in their
 * nav, so sending them there lands on a mostly-empty (or forbidden) screen —
 * they start on CRM (their funnel). Managers+ get the Dashboards home.
 * Also used by the sidebar logo so "home" always points somewhere visible.
 */
export function homeForRole(role: Role, enabledNavigation?: readonly string[] | null): string {
  if (role === "salesperson") return "/crm";
  return enabledNavigation?.length && !enabledNavigation.includes("dashboards")
    ? "/crm"
    : "/dashboards";
}
