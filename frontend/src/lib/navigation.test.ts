import { describe, expect, it } from "vitest";

import { CORE_NAVIGATION, NAV_ITEMS, getNavItem } from "./navigation";

/**
 * A slug entitled by the backend still needs an item here or it is invisible.
 *
 * NPS shipped without one. The slug was added to the backend MODULES, to the
 * role defaults, to the industry pack and to CORE_NAVIGATION below — but the
 * edit that was supposed to add the NAV_ITEMS entry matched nothing and
 * silently did nothing. Every check passed. The page rendered on a typed URL,
 * the API answered, and the sidebar simply never showed it.
 *
 * Nothing in the type system can catch that, because CORE_NAVIGATION is a list
 * of strings and NAV_ITEMS is a list of objects. This is the check.
 */
describe("navigation", () => {
  it("gives every core slug a nav item", () => {
    const missing = CORE_NAVIGATION.filter((slug) => !getNavItem(slug));
    expect(missing).toEqual([]);
  });

  it("has an item for NPS", () => {
    const item = getNavItem("nps");
    expect(item).toBeDefined();
    expect(item?.group).toBe("Customer Interactions");
  });

  it("never lists the same slug twice", () => {
    // Two entries for one slug renders it twice in the sidebar and makes the
    // access matrix offer the same screen on two rows.
    const seen = new Map<string, number>();
    for (const i of NAV_ITEMS) seen.set(i.slug, (seen.get(i.slug) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it("gives every item a group the sidebar renders", () => {
    const groups = new Set([
      "Command Centre",
      "Customer Interactions",
      "Showroom",
      "Stock Management",
      "HR & Teams",
      "Reports",
      "Setup",
    ]);
    const stray = NAV_ITEMS.filter((i) => !groups.has(i.group)).map((i) => i.slug);
    expect(stray).toEqual([]);
  });
});
