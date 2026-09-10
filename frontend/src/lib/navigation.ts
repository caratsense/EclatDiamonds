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
} from "lucide-react";

import type { Role } from "@/lib/types";

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
  /**
   * Roles allowed to see this item. Undefined = visible to everyone.
   * Drives role-aware nav visibility (never hardcode per-screen).
   */
  roles?: Role[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Single source of truth for navigation + section headers.
 * Grouped by domain. Every section is store-scoped + role-aware;
 * visibility filtering by role is layered on in Phase 2.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        module: 3,
        slug: "dashboards",
        title: "Dashboards",
        purpose:
          "Your store's key numbers and shared team tasks.",
        primaryAction: "New Task",
        icon: LayoutDashboard,
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 10,
        slug: "reporting",
        title: "Reporting & DSR",
        purpose:
          "Automated daily sales reports and store analytics.",
        primaryAction: "Generate DSR",
        icon: BarChart3,
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 10,
        slug: "store-comparison",
        title: "Store Comparison",
        purpose:
          "Revenue, orders and staff across all stores, side by side.",
        primaryAction: "",
        icon: GitCompare,
        roles: ["store_manager", "area_manager", "head_office"],
      },
    ],
  },
  {
    label: "Sales",
    items: [
      {
        module: 1,
        slug: "crm",
        title: "CRM & Leads",
        purpose:
          "Leads and follow-ups for every customer enquiry.",
        primaryAction: "New Lead",
        icon: Users,
      },
      {
        // CaratOS Phase A3 — the unified inbox. Channel-neutral: WhatsApp today,
        // any other channel once its adapter exists, with no change to this screen.
        module: 1,
        slug: "conversations",
        title: "Conversations",
        purpose:
          "Every customer message, on every channel, in one place.",
        primaryAction: "",
        icon: Inbox,
      },
      {
        module: 1,
        slug: "customers",
        title: "Customers",
        purpose:
          "Your store's customer directory — contacts, purchase history and key dates.",
        primaryAction: "",
        icon: Contact,
      },
      {
        module: 7,
        slug: "checkins",
        title: "Check-ins & Footfall",
        purpose:
          "Log walk-ins and assign each customer to a sales rep.",
        primaryAction: "Log Check-in",
        icon: DoorOpen,
      },
      {
        module: 1,
        slug: "reminders",
        title: "Reminders",
        purpose:
          "Today's and overdue lead follow-ups.",
        primaryAction: "",
        icon: BellRing,
      },
      {
        module: 2,
        slug: "quotation",
        title: "Quotation & Orders",
        purpose:
          "Build quotes and custom orders; custom orders route to production.",
        primaryAction: "New Quote",
        icon: FileText,
      },
      {
        module: 5,
        slug: "catalogue",
        title: "Catalogue",
        purpose:
          "Browse products across stores; search by photo.",
        primaryAction: "Add Product",
        icon: Gem,
      },
      {
        module: 14,
        slug: "returns",
        title: "Returns & Exchange",
        purpose:
          "Returns, exchanges, buyback, repairs and old-gold trade-ins.",
        primaryAction: "New Intake",
        icon: RotateCcw,
      },
      {
        module: 15,
        slug: "discounts",
        title: "Discounts",
        purpose: "Request and approve discounts with live margin checks.",
        primaryAction: "Request Discount",
        icon: Percent,
      },
      {
        module: 17,
        slug: "loyalty",
        title: "Loyalty & Referral",
        purpose:
          "Gold-savings schemes and the customer referral wallet.",
        primaryAction: "Enroll Customer",
        icon: PiggyBank,
      },
      {
        module: 6,
        slug: "sales-performance",
        title: "Sales Performance",
        purpose: "Sales leaderboard, commission and incentives.",
        primaryAction: "",
        icon: Trophy,
        roles: ["store_manager", "area_manager", "head_office"],
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        module: 9,
        slug: "inventory",
        title: "Inventory & Stock",
        purpose:
          "Stock levels, aging lines and scrap recovery.",
        primaryAction: "Stock Entry",
        icon: Boxes,
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
        // Salespeople have no actions here; store managers run the movements,
        // area/HO oversee + approve.
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 12,
        slug: "payments",
        title: "Sales & Payments",
        purpose:
          "Record sales with advance and balance, and track collections and bank reconciliation.",
        primaryAction: "New Sale",
        icon: Receipt,
        // Store-level collections ledger + reconciliation is a manager view
        // (matches Finance/Reporting/Targets gating). If salespeople need to
        // record direct sales at the counter, widen this — open product decision.
        roles: ["store_manager", "area_manager", "head_office"],
      },
    ],
  },
  {
    label: "People",
    items: [
      {
        module: 6,
        slug: "hrms",
        title: "HRMS & Attendance",
        purpose:
          "Geo-attendance, rosters, leave and regularization.",
        primaryAction: "Mark Attendance",
        icon: Fingerprint,
      },
    ],
  },
  {
    label: "Management",
    items: [
      {
        module: 4,
        slug: "finance",
        title: "Finance & Fund Planning",
        purpose:
          "Ledgers, budgets, cash flow and expansion costs.",
        primaryAction: "Add Entry",
        icon: Banknote,
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 11,
        slug: "new-store",
        title: "New-Store Setup",
        purpose:
          "Tasks and timelines for opening new stores.",
        primaryAction: "New Project",
        icon: Building2,
        roles: ["head_office"],
      },
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
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 16,
        slug: "marketing",
        title: "Marketing",
        purpose:
          "Plan campaigns and track agency deliverables.",
        primaryAction: "New Campaign",
        icon: Megaphone,
        roles: ["store_manager", "area_manager", "head_office"],
      },
    ],
  },
  {
    label: "Back-office",
    items: [
      {
        module: 3,
        slug: "approvals",
        title: "Approvals",
        purpose:
          "Discount, return and leave requests awaiting your approval.",
        primaryAction: "",
        icon: ClipboardCheck,
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
      },
      {
        module: 13,
        slug: "ticketing",
        title: "Ticketing",
        purpose:
          "Raise and track operational issues with the back office.",
        primaryAction: "New Ticket",
        icon: LifeBuoy,
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        // CaratOS Phase A11 — live setup state, not a one-time wizard.
        module: 11,
        slug: "settings/onboarding",
        title: "Getting Started",
        purpose:
          "What is set up and what is left — industry, locations, team, data and channels.",
        primaryAction: "",
        icon: ListChecks,
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
        roles: ["head_office"],
      },
      {
        module: 6,
        slug: "settings/team",
        title: "Team",
        purpose: "Add staff, assign roles and stores within your scope.",
        primaryAction: "Add Staff",
        icon: UsersRound,
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 2,
        slug: "settings/rates",
        title: "Gold Rate",
        purpose:
          "The live gold rate every new quote is priced from — auto-updates from the market; override it here if needed.",
        primaryAction: "",
        icon: Coins,
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 10,
        slug: "settings/targets",
        title: "Targets",
        purpose:
          "Set monthly sales targets per store and track achievement.",
        primaryAction: "",
        icon: Target,
        roles: ["store_manager", "area_manager", "head_office"],
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
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        // CaratOS Phase A5 — per-organisation connections and credentials.
        module: 11,
        slug: "settings/integrations",
        title: "Integrations",
        purpose:
          "Connect the systems and channels your business already uses.",
        primaryAction: "",
        icon: Plug,
        roles: ["head_office"],
      },
      {
        module: 3,
        slug: "settings/audit",
        title: "Audit Log",
        purpose:
          "A record of approvals, role changes and other sensitive actions.",
        primaryAction: "",
        icon: ScrollText,
        roles: ["store_manager", "area_manager", "head_office"],
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

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
  "reminders",
  "catalogue",
  "checkins",
  "hrms",
  "settings/onboarding",
  "settings/stores",
  "settings/team",
  "settings/configuration",
  "data",
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
