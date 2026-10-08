import {
  Activity,
  type LucideIcon,
  Users,
  FileText,
  Gem,
  RotateCcw,
  Percent,
  PiggyBank,
  Bot,
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
  Clock,
  Images,
  PackageX,
  Receipt as ReceiptIcon,
  Gift,
  Radio,
  Route,
  ListTodo,
  ShieldCheck,
} from "lucide-react";

import type { AccessMap, Role } from "@/lib/types";

/**
 * Sidebar sections, in the order they are rendered.
 *
 * Grouped by the JOB somebody is doing, not by the module numbers in
 * MODULES.md. The previous shape had a fourteen-item "Sales" bucket holding the
 * unified inbox, the calling queue, the catalogue, returns, discounts, the
 * loyalty scheme and the leaderboard — seven different jobs done by four
 * different people. At fourteen items nobody scans a list; they hunt it.
 *
 * Ordered as the customer's journey runs: what needs you today, the people,
 * the showroom, the sale, what follows the sale, stock, the team, reports,
 * then setup. Putting Payments, Loyalty and Targets side by side under "After
 * the sale" makes it visible at a glance that one event feeds all of them.
 */
export const NAV_GROUP_ORDER = [
  "Today",
  "People",
  "Showroom",
  "Selling",
  "After the sale",
  "Stock",
  "Team",
  "Reports",
  "Setup",
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
   * Off the sidebar, still a real page: its header, its route and the access
   * matrix keep it. For screens nothing feeds yet; they come back with data.
   */
  hidden?: boolean;
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
    group: "Today",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "reporting",
    title: "Reporting & DSR",
    purpose: "Automated daily sales reports and store analytics.",
    primaryAction: "File DSR",
    icon: BarChart3,
    group: "Reports",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    // The drill-down behind the dashboard tiles: when the money came in, which
    // documents it came from, and what is still sitting unsold. A tile that only
    // changes its number cannot answer any of those.
    module: 10,
    slug: "activity",
    title: "Business Activity",
    purpose: "When it sold, what sold, and what is still sitting.",
    primaryAction: "",
    icon: Activity,
    group: "Today",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "store-comparison",
    title: "Store Comparison",
    purpose: "Revenue, orders and staff across all stores, side by side.",
    primaryAction: "",
    icon: GitCompare,
    group: "Reports",
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
    group: "People",
  },
  {
    /*
     * The bot's own script, next to the inbox it speaks into.
     *
     * It began life as a tab under Settings -> Business Configuration, which
     * read as a thing you configure once. It is not: it is the wording of the
     * conversations on the next screen up, and the person rewording it is
     * thinking about customers, not about settings. The client asked for it
     * here by position, and they were right.
     */
    module: 1,
    slug: "bot-script",
    title: "Bot Script",
    purpose: "The questions the bot asks a customer, in your own words.",
    primaryAction: "",
    icon: Bot,
    group: "People",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "crm",
    title: "CRM & Leads",
    purpose: "Leads and follow-ups for every customer enquiry.",
    primaryAction: "New Lead",
    icon: Users,
    group: "People",
  },
  {
    module: 1,
    slug: "calling",
    title: "Calling",
    purpose:
      "Every follow-up owed to a customer, oldest first, with the history on one screen before you dial.",
    primaryAction: "",
    icon: PhoneCall,
    group: "People",
    roles: ["salesperson", "store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "reminders",
    title: "Reminders",
    purpose: "Today's and overdue lead follow-ups.",
    primaryAction: "",
    icon: BellRing,
    group: "People",
  },
  {
    module: 1,
    slug: "customers",
    title: "Customers",
    purpose:
      "Your store's customer directory — contacts, purchase history and key dates.",
    primaryAction: "",
    icon: Contact,
    group: "People",
  },
  {
    module: 1,
    slug: "feedback",
    title: "Feedback",
    purpose:
      "Ask a customer how it went; an unhappy answer reaches a person, not a public review page.",
    primaryAction: "",
    icon: MessageSquareHeart,
    group: "People",
    roles: ["store_manager", "area_manager", "head_office"],
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
    group: "Showroom",
    roles: ["salesperson", "store_manager", "area_manager", "head_office"],
  },
  {
    module: 7,
    slug: "checkins",
    title: "Check-ins & Footfall",
    purpose: "Log walk-ins and assign each customer to a sales rep.",
    primaryAction: "Log Check-in",
    icon: DoorOpen,
    group: "Showroom",
  },

  /* ------------------------------------------- Commerce & Orders */
  {
    module: 5,
    slug: "catalogue",
    title: "Catalogue",
    purpose: "Browse products across stores; search by photo.",
    primaryAction: "Add Product",
    icon: Gem,
    group: "Showroom",
  },
  {
    module: 2,
    slug: "quotation",
    title: "Quotation & Orders",
    purpose:
      "Build quotes and custom orders; custom orders route to production.",
    primaryAction: "New Quote",
    icon: FileText,
    group: "Selling",
  },
  {
    module: 8,
    slug: "timelines",
    title: "Orders in Production",
    purpose: "Every order being made, booked here or imported from the factory, and its stage.",
    primaryAction: "New Order",
    icon: Route,
    group: "Selling",
  },
  {
    module: 12,
    slug: "payments",
    title: "Sales & Payments",
    purpose:
      "Record sales with advance and balance, and track collections and bank reconciliation.",
    primaryAction: "New Sale",
    icon: Receipt,
    group: "After the sale",
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
    group: "Selling",
  },
  {
    module: 14,
    slug: "returns",
    title: "Returns & Exchange",
    purpose: "Returns, exchanges, buyback, repairs and old-gold trade-ins.",
    primaryAction: "New Intake",
    icon: RotateCcw,
    group: "Selling",
  },
  {
    module: 17,
    slug: "loyalty",
    title: "Loyalty & Referral",
    purpose: "Gold-savings schemes and the customer referral wallet.",
    primaryAction: "Enroll Customer",
    icon: PiggyBank,
    group: "After the sale",
  },

  /* ------------------------------------------- Inventory & Supply */
  {
    module: 9,
    slug: "inventory",
    title: "Inventory & Stock",
    purpose: "Stock levels, aging lines and scrap recovery.",
    primaryAction: "Stock Entry",
    icon: Boxes,
    group: "Stock",
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
    group: "Stock",
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
    group: "Setup",
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
    group: "Setup",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 16,
    slug: "marketing",
    title: "Marketing",
    purpose: "Plan campaigns and track agency deliverables.",
    primaryAction: "New Campaign",
    icon: Megaphone,
    group: "Setup",
    hidden: true,
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
    group: "Team",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 6,
    slug: "hrms",
    title: "HRMS & Attendance",
    purpose: "Geo-attendance, rosters, leave and regularization.",
    primaryAction: "Mark Attendance",
    icon: Fingerprint,
    group: "Team",
  },
  {
    module: 6,
    slug: "sales-performance",
    title: "Sales Performance",
    purpose: "Sales leaderboard, commission and incentives.",
    primaryAction: "",
    icon: Trophy,
    group: "After the sale",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "settings/targets",
    title: "Targets",
    purpose: "Set monthly sales targets per store and track achievement.",
    primaryAction: "",
    icon: Target,
    group: "After the sale",
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
    group: "Today",
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
    group: "Today",
  },
  {
    module: 13,
    slug: "ticketing",
    title: "Ticketing",
    purpose: "Raise and track operational issues with the back office.",
    primaryAction: "New Ticket",
    icon: LifeBuoy,
    group: "Setup",
    hidden: true,
  },
  {
    module: 4,
    slug: "finance",
    title: "Finance & Fund Planning",
    purpose: "Ledgers, budgets, cash flow and expansion costs.",
    primaryAction: "Add Entry",
    icon: Banknote,
    group: "Reports",
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
    group: "Setup",
    roles: ["head_office"],
  },
  {
    module: 11,
    slug: "settings/access",
    title: "People & Access",
    purpose: "Choose, person by person, which screens they can open and how far.",
    primaryAction: "",
    icon: ShieldCheck,
    group: "Team",
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
    group: "Setup",
    roles: ["store_manager", "area_manager", "head_office"],
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
    group: "Setup",
    hidden: true,
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
    group: "Setup",
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
    group: "Setup",
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
    group: "Setup",
    roles: ["head_office"],
  },
  {
    /*
     * On the sidebar rather than three clicks inside Integrations.
     *
     * A template is the only thing a campaign is allowed to send to somebody
     * who did not write in first, and Meta takes about a day to approve one.
     * Burying the screen that writes them meant a reminder was a day away from
     * anybody who had not already found it.
     */
    module: 1,
    slug: "settings/integrations/templates",
    title: "Message Templates",
    purpose:
      "Write a WhatsApp message and put it to Meta for approval. Approved ones are what campaigns send.",
    primaryAction: "",
    icon: MessageSquarePlus,
    group: "Setup",
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
    group: "Setup",
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
    group: "Setup",
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
    group: "Reports",
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 10,
    slug: "reporting/scheduled",
    title: "Scheduled Reports",
    purpose: "Reports that send themselves at month-end, and what happened to the last one.",
    primaryAction: "New schedule",
    icon: CalendarClock,
    group: "Reports",
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
    group: "People",
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
    group: "People",
    hidden: true,
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "tasks",
    title: "Tasks",
    purpose: "Everything owed to a customer or a colleague, in one list.",
    primaryAction: "New Task",
    icon: ListTodo,
    group: "People",
  },
  {
    module: 9,
    slug: "inventory/dead-stock",
    title: "Dead Stock",
    purpose:
      "Pieces that have not moved, against thresholds you set per category rather than one number for everything.",
    primaryAction: "",
    icon: PackageX,
    group: "Stock",
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
    group: "After the sale",
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
    group: "Team",
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
    group: "Setup",
    hidden: true,
    roles: ["store_manager", "area_manager", "head_office"],
  },
  {
    module: 1,
    slug: "settings/lead-tags",
    title: "Lead Tags",
    purpose: "Your own labels for a lead, and what they mean.",
    primaryAction: "New tag",
    icon: Tags,
    group: "Setup",
    hidden: true,
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
    group: "Setup",
    hidden: true,
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
    group: "Setup",
    hidden: true,
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
    group: "Setup",
    hidden: true,
    roles: ["store_manager", "area_manager", "head_office"],
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
  "bot-script",
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
  "settings/integrations/templates",
  "settings/audit",
  "settings/access",
]);

export function getNavItem(slug: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.slug === slug);
}

/**
 * Everything a storeperson sees: the branch's catalogue, stock, dead stock,
 * product photos and their own attendance and leave. Listed, not ranked — a
 * nav item with no `roles` means "every ladder role", and a storeperson is not
 * on the ladder, so they get nothing by omission.
 */
export const STOREPERSON_NAVIGATION: ReadonlySet<string> = new Set([
  "catalogue",
  "inventory",
  "inventory/dead-stock",
  "data/images",
  "hrms",
]);

/** Whether a role may see a nav item (undefined roles = every ladder role). */
export function canSeeNavItem(item: NavItem, role: Role, access?: AccessMap | null): boolean {
  // The server's word, once the session has it: the role's defaults with head
  // office's per-person changes (auth/access.ts).
  if (access) return item.slug in access;
  if (role === "storeperson") return STOREPERSON_NAVIGATION.has(item.slug);
  return !item.roles || item.roles.includes(role);
}

/**
 * Nav groups filtered to what `role` may see, with empty groups dropped.
 * Keeps the sidebar + mobile nav role-aware from a single source of truth.
 */
export function visibleNavGroups(
  role: Role,
  enabledNavigation?: readonly string[],
  access?: AccessMap | null,
): NavGroup[] {
  const enabled = enabledNavigation?.length
    ? new Set(enabledNavigation)
    : undefined;
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        !item.hidden &&
        canSeeNavItem(item, role, access) &&
        (!enabled || enabled.has(item.slug)),
    ),
  })).filter((group) => group.items.length > 0);
}

/**
 * The groups narrowed to screens whose name, section or purpose contains
 * `query` — the sidebar's "find a screen" box. `label` is the name as shown
 * (translated), so what someone reads is what they can type.
 */
export function filterNavGroups(
  groups: NavGroup[],
  query: string,
  label: (item: NavItem) => string = (item) => item.title,
): NavGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${label(item)} ${item.title} ${group.label} ${item.purpose}`.toLowerCase().includes(q),
      ),
    }))
    .filter((group) => group.items.length > 0);
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
export function homeForRole(
  role: Role,
  enabledNavigation?: readonly string[] | null,
  access?: AccessMap | null,
): string {
  const home =
    role === "storeperson"
      ? "/inventory"
      : role === "salesperson" || role === "marketing"
        ? "/crm"
        : enabledNavigation?.length && !enabledNavigation.includes("dashboards")
          ? "/crm"
          : "/dashboards";
  if (!access || home.slice(1) in access) return home;
  // Their access leaves out the role's usual home. Someone set to attendance
  // only (People & Access switches off every screen but HRMS) lives on the
  // punch screen: Check in, then Check out, with leave and regularisation one
  // link away. Anyone who still has other screens starts on attendance, the
  // one screen everybody keeps, and goes on from there as before.
  const slugs = Object.keys(access);
  return slugs.length === 1 && slugs[0] === "hrms" ? "/check-in" : "/hrms";
}

/**
 * The punch screen as a tab on a phone's bottom bar, for someone whose home it
 * is. It is not a module, so it is not in NAV_ITEMS and no list of screens
 * offers it. Without this tab a phone has no way back to Check in / Check out
 * from leave or the profile page: the logo that leads home is in the sidebar,
 * which a phone does not show.
 */
export function punchTab(
  home: string,
): Pick<NavItem, "slug" | "title" | "purpose" | "icon"> | null {
  if (home !== "/check-in") return null;
  return {
    slug: "check-in",
    title: "Attendance",
    purpose: "Check in and check out.",
    icon: Clock,
  };
}
