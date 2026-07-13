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
          "Role-specific dashboards and cross-department collaboration.",
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
          "Compare every store side by side — revenue, orders and staff — without switching stores.",
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
          "Single source of truth for all potential customers across every channel.",
        primaryAction: "New Lead",
        icon: Users,
      },
      {
        module: 7,
        slug: "checkins",
        title: "Check-ins & Footfall",
        purpose:
          "Track customer traffic and sales-rep allocation via check-ins (part of CRM).",
        primaryAction: "Log Check-in",
        icon: DoorOpen,
      },
      {
        module: 1,
        slug: "reminders",
        title: "Reminders",
        purpose:
          "Today's and overdue lead follow-ups, assigned to each store's manager.",
        primaryAction: "",
        icon: BellRing,
      },
      {
        module: 2,
        slug: "quotation",
        title: "Quotation & Orders",
        purpose:
          "Create a quote or a custom order in one place; custom orders route to the back office and appear on the production timeline.",
        primaryAction: "New Quote",
        icon: FileText,
      },
      {
        module: 5,
        slug: "catalogue",
        title: "Catalogue",
        purpose:
          "Unified product index across locations with AI image-based search.",
        primaryAction: "Add Product",
        icon: Gem,
      },
      {
        module: 14,
        slug: "returns",
        title: "Returns & Exchange",
        purpose:
          "Standardize returns, exchanges, buyback, repairs and old-gold trade-ins.",
        primaryAction: "New Intake",
        icon: RotateCcw,
      },
      {
        module: 15,
        slug: "discounts",
        title: "Discounts",
        purpose: "Control and audit discount approvals with margin previews.",
        primaryAction: "Request Discount",
        icon: Percent,
      },
      {
        module: 17,
        slug: "loyalty",
        title: "Loyalty & Referral",
        purpose:
          "Gold-savings schemes plus the referral wallet (5% pre-GST credit).",
        primaryAction: "Enroll Customer",
        icon: PiggyBank,
      },
      {
        module: 6,
        slug: "sales-performance",
        title: "Sales Performance",
        purpose: "Sales leaderboard and editable commission/incentives.",
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
          "Inventory optimization, aging-stock control and scrap recycling.",
        primaryAction: "Stock Entry",
        icon: Boxes,
        roles: ["area_manager", "head_office"],
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
          "Self-service geo attendance, rosters, leave and regularization.",
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
          "End-to-end finance: ledgers, budgets, cash-flow and expansion costs.",
        primaryAction: "Add Entry",
        icon: Banknote,
        roles: ["area_manager", "head_office"],
      },
      {
        module: 11,
        slug: "new-store",
        title: "New-Store Setup",
        purpose:
          "Project management for launching new store locations.",
        primaryAction: "New Project",
        icon: Building2,
        roles: ["area_manager", "head_office"],
      },
      {
        module: 16,
        slug: "marketing",
        title: "Marketing",
        purpose:
          "Coordinate external campaigns and agency deliverables.",
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
          "One queue for everything waiting on you — discount, return and leave requests.",
        primaryAction: "",
        icon: ClipboardCheck,
        roles: ["store_manager", "area_manager", "head_office"],
      },
      {
        module: 13,
        slug: "ticketing",
        title: "Ticketing",
        purpose:
          "Internal helpdesk for operational issues, routed to the back office.",
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
          "Add store branches and assign each a store-manager login. Every store gets its own scoped system via the store switcher.",
        primaryAction: "Add Store",
        icon: Store,
        roles: ["head_office"],
      },
      {
        module: 6,
        slug: "settings/team",
        title: "Team",
        purpose: "Manage staff and assign roles.",
        primaryAction: "Add Staff",
        icon: UsersRound,
        roles: ["head_office"],
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
