import {
  type LucideIcon,
  Users,
  FileText,
  Gem,
  RotateCcw,
  Percent,
  PiggyBank,
  GitBranch,
  Boxes,
  Wallet,
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
        title: "Quotation & Pricing",
        purpose:
          "Consistent pricing across digital and physical touchpoints with portable quotes.",
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
          "Standardize returns, exchanges, repairs and old-gold trade-ins.",
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
        title: "Loyalty & Gold Scheme",
        purpose: "Manage recurring gold-savings accounts and monthly deposits.",
        primaryAction: "Enroll Customer",
        icon: PiggyBank,
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        module: 8,
        slug: "timelines",
        title: "Timelines & Status",
        purpose:
          "Real-time progress engine for custom orders and stock movements.",
        primaryAction: "New Workflow",
        icon: GitBranch,
      },
      {
        module: 9,
        slug: "inventory",
        title: "Inventory & Stock",
        purpose:
          "Inventory optimization, aging-stock control and scrap recycling.",
        primaryAction: "Stock Entry",
        icon: Boxes,
      },
      {
        module: 12,
        slug: "payments",
        title: "Payments",
        purpose:
          "Centralized payment-collection ledger with bank reconciliation.",
        primaryAction: "Record Payment",
        icon: Wallet,
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
          "Staff rosters, geo-tagged attendance and sales incentives.",
        primaryAction: "Mark Attendance",
        icon: Fingerprint,
      },
      {
        module: 7,
        slug: "checkins",
        title: "Check-ins & Footfall",
        purpose:
          "Track customer traffic and sales-rep allocation via check-ins.",
        primaryAction: "Log Check-in",
        icon: DoorOpen,
      },
    ],
  },
  {
    label: "Management",
    items: [
      {
        module: 3,
        slug: "dashboards",
        title: "Dashboards",
        purpose:
          "Role-specific dashboards and cross-department collaboration.",
        primaryAction: "New Task",
        icon: LayoutDashboard,
      },
      {
        module: 4,
        slug: "finance",
        title: "Finance & Fund Planning",
        purpose:
          "End-to-end finance: ledgers, budgets, cash-flow and expansion costs.",
        primaryAction: "Add Entry",
        icon: Banknote,
      },
      {
        module: 10,
        slug: "reporting",
        title: "Reporting & DSR",
        purpose:
          "Automated daily sales reports and store analytics.",
        primaryAction: "Generate DSR",
        icon: BarChart3,
      },
      {
        module: 11,
        slug: "new-store",
        title: "New-Store Setup",
        purpose:
          "Project management for launching new store locations.",
        primaryAction: "New Project",
        icon: Building2,
      },
      {
        module: 16,
        slug: "marketing",
        title: "Marketing",
        purpose:
          "Coordinate external campaigns and agency deliverables.",
        primaryAction: "New Campaign",
        icon: Megaphone,
      },
    ],
  },
  {
    label: "Back-office",
    items: [
      {
        module: 13,
        slug: "ticketing",
        title: "Ticketing",
        purpose:
          "Internal helpdesk for operational issues with auto-routing.",
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
