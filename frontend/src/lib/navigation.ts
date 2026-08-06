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
        roles: ["area_manager", "head_office"],
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
        roles: ["area_manager", "head_office"],
      },
      {
        module: 11,
        slug: "new-store",
        title: "New-Store Setup",
        purpose:
          "Tasks and timelines for opening new stores.",
        primaryAction: "New Project",
        icon: Building2,
        roles: ["area_manager", "head_office"],
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
        module: 11,
        slug: "settings/stores",
        title: "Store Setup",
        purpose:
          "Add store branches, review new branches from Gati, and assign logins.",
        primaryAction: "Add Store",
        icon: Store,
        roles: ["area_manager", "head_office"],
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
        roles: ["area_manager", "head_office"],
      },
      {
        module: 3,
        slug: "settings/audit",
        title: "Audit Log",
        purpose:
          "A record of approvals, role changes and other sensitive actions.",
        primaryAction: "",
        icon: ScrollText,
        roles: ["area_manager", "head_office"],
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

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
export function visibleNavGroups(role: Role): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canSeeNavItem(item, role)),
  })).filter((group) => group.items.length > 0);
}

/**
 * Landing route per role. A salesperson has no Dashboards/Reporting in their
 * nav, so sending them there lands on a mostly-empty (or forbidden) screen —
 * they start on CRM (their funnel). Managers+ get the Dashboards home.
 * Also used by the sidebar logo so "home" always points somewhere visible.
 */
export function homeForRole(role: Role): string {
  return role === "salesperson" ? "/crm" : "/dashboards";
}
