import { describe, expect, it } from "vitest";

import {
  CORE_NAVIGATION,
  NAV_GROUPS,
  NAV_GROUP_ORDER,
  NAV_ITEMS,
  getNavItem,
  homeForRole,
  visibleNavGroups,
} from "@/lib/navigation";
import type { Role } from "@/lib/types";

/**
 * The sidebar was regrouped from six buckets into nine, and a regrouping is the
 * one edit that can silently DELETE a working screen: an item moved out of one
 * array and not into another still compiles, still typechecks, and simply
 * stops existing in the product.
 *
 * `NAV_GROUPS` is now derived from a single flat list by the item's own `group`
 * field, which makes that class of mistake impossible — and these tests pin
 * that property rather than the particular arrangement, so a future regrouping
 * is free but a lost screen is not.
 */

/** Every route the previous six-group arrangement showed. */
const ROUTES_BEFORE_THE_REGROUPING = [
  "dashboards",
  "reporting",
  "store-comparison",
  "crm",
  "conversations",
  "customers",
  "checkins",
  "feedback",
  "calling",
  "instore",
  "reminders",
  "quotation",
  "catalogue",
  "returns",
  "discounts",
  "loyalty",
  "sales-performance",
  "inventory",
  "stock-transfers",
  "payments",
  "hrms",
  "finance",
  "new-store",
  "campaigns",
  "lead-forms",
  "marketing",
  "approvals",
  "requests",
  "ticketing",
  "settings/onboarding",
  "settings/stores",
  "settings/team",
  "settings/rates",
  "settings/targets",
  "settings/configuration",
  "data",
  "settings/integrations",
  "settings/audit",
];

const ROLES: Role[] = ["salesperson", "store_manager", "area_manager", "head_office"];

describe("navigation", () => {
  it("still has every screen the old grouping had", () => {
    const slugs = new Set(NAV_ITEMS.map((i) => i.slug));
    const lost = ROUTES_BEFORE_THE_REGROUPING.filter((s) => !slugs.has(s));
    // `new-store` is the one the brief's section list did not place. Losing it
    // here would have removed a working head-office screen from the product.
    expect(lost).toEqual([]);
  });

  it("puts every item in exactly one section", () => {
    const seen = NAV_GROUPS.flatMap((g) => g.items);
    expect(seen).toHaveLength(NAV_ITEMS.length);
    expect(new Set(seen.map((i) => i.slug)).size).toBe(NAV_ITEMS.length);
  });

  it("declares no empty section, and no section outside the declared order", () => {
    for (const group of NAV_GROUPS) {
      expect([group.label, group.items.length > 0]).toEqual([group.label, true]);
      expect(NAV_GROUP_ORDER).toContain(group.label);
    }
  });

  it("renders sections in the declared order", () => {
    const rendered = NAV_GROUPS.map((g) => g.label);
    expect(rendered).toEqual(NAV_GROUP_ORDER.filter((l) => rendered.includes(l)));
  });

  it("has a unique slug per item", () => {
    const slugs = NAV_ITEMS.map((i) => i.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps every core-navigation route in the sidebar", () => {
    // CORE_NAVIGATION is the fallback surface for a tenant with no resolvable
    // industry pack. A route listed there but missing from the nav is a screen
    // the fallback promises and cannot show.
    for (const slug of CORE_NAVIGATION) {
      expect([slug, Boolean(getNavItem(slug))]).toEqual([slug, true]);
    }
  });

  describe("role filtering", () => {
    it.each(ROLES)("gives %s a non-empty sidebar with no empty sections", (role) => {
      const groups = visibleNavGroups(role);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
    });

    it("shows a salesperson only what they are allowed", () => {
      const slugs = visibleNavGroups("salesperson").flatMap((g) =>
        g.items.map((i) => i.slug),
      );
      // The floor roles they work in.
      expect(slugs).toContain("crm");
      expect(slugs).toContain("instore");
      expect(slugs).toContain("calling");
      // Management screens their role bars them from.
      expect(slugs).not.toContain("dashboards");
      expect(slugs).not.toContain("finance");
      expect(slugs).not.toContain("settings/stores");
    });

    it("lands every role somewhere they can actually see", () => {
      for (const role of ROLES) {
        const home = homeForRole(role).replace(/^\//, "");
        const slugs = visibleNavGroups(role).flatMap((g) => g.items.map((i) => i.slug));
        expect([role, slugs.includes(home)]).toEqual([role, true]);
      }
    });

    it("drops a section entirely when the pack disables every item in it", () => {
      // A tenant whose pack enables only CRM keeps one section, not nine empty
      // headings.
      const groups = visibleNavGroups("head_office", ["crm"]);
      expect(groups).toHaveLength(1);
      expect(groups[0].items.map((i) => i.slug)).toEqual(["crm"]);
    });
  });
});
