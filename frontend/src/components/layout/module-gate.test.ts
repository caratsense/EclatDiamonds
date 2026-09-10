import { describe, expect, it } from "vitest";

import { gateDecision, navSlugForPath } from "./module-gate";
import { CORE_NAVIGATION, NAV_ITEMS } from "@/lib/navigation";

/**
 * The gate's decision table (MM4, MM3-03).
 *
 * These assert the policy, not the pixels: `gateDecision` is the whole of it,
 * and every case the work item names is a row below. The one that matters most
 * is "unresolved pack" — that is the state the gate used to render through.
 */

/** What a healthcare tenant's bootstrap actually returns (backend packs.ts). */
const CLINIC = [...CORE_NAVIGATION];

/** Eclat's list: the core plus its jewellery operations. */
const ECLAT = [
  ...CORE_NAVIGATION,
  "dashboards",
  "reporting",
  "marketing",
  "ticketing",
  "store-comparison",
  "quotation",
  "returns",
  "discounts",
  "loyalty",
  "sales-performance",
  "inventory",
  "stock-transfers",
  "payments",
  "finance",
  "new-store",
  "approvals",
  "requests",
  "settings/rates",
  "settings/targets",
];

describe("navSlugForPath", () => {
  it("resolves a module route, and the longest match wins", () => {
    expect(navSlugForPath("/finance")).toBe("finance");
    expect(navSlugForPath("/settings/rates")).toBe("settings/rates");
    expect(navSlugForPath("/crm/lead-123")).toBe("crm");
  });

  it("returns null for anything that is not a module", () => {
    for (const path of ["/", "", null, "/check-in", "/settings", "/nonsense"]) {
      expect(navSlugForPath(path)).toBeNull();
    }
  });
});

describe("gateDecision — bootstrap has not answered yet", () => {
  it("holds a vertical route rather than flashing it", () => {
    expect(gateDecision("/finance", undefined)).toBe("hold");
    expect(gateDecision("/loyalty", undefined)).toBe("hold");
    expect(gateDecision("/stock-transfers", undefined)).toBe("hold");
  });

  it("renders a universal route immediately — it can never be taken away", () => {
    for (const slug of CORE_NAVIGATION) {
      expect(gateDecision(`/${slug}`, undefined)).toBe("render");
    }
  });

  it("renders a non-module route immediately", () => {
    expect(gateDecision("/check-in", undefined)).toBe("render");
    expect(gateDecision("/settings", undefined)).toBe("render");
  });
});

describe("gateDecision — unresolved or missing pack", () => {
  /**
   * The regression this file exists for. When a tenant's pack cannot be
   * resolved, `useEnabledNavigation` returns the industry-neutral core; the
   * gate must then refuse the vertical modules, exactly as the server's
   * EntitlementGuard does. The previous implementation rendered them.
   */
  it("refuses every vertical module to a tenant left on the core list", () => {
    for (const slug of ["finance", "loyalty", "returns", "discounts", "quotation",
                        "inventory", "stock-transfers", "payments", "marketing",
                        "ticketing", "requests", "reporting", "dashboards",
                        "new-store", "settings/rates", "settings/targets"]) {
      expect(gateDecision(`/${slug}`, [...CORE_NAVIGATION])).toBe("refuse");
    }
  });

  it("still allows the whole universal suite", () => {
    for (const slug of CORE_NAVIGATION) {
      expect(gateDecision(`/${slug}`, [...CORE_NAVIGATION])).toBe("render");
    }
  });

  it("refuses rather than renders when the list is empty", () => {
    expect(gateDecision("/finance", [])).toBe("refuse");
  });
});

describe("gateDecision — a clinic with its real navigation", () => {
  it("refuses the jewellery modules", () => {
    expect(gateDecision("/finance", CLINIC)).toBe("refuse");
    expect(gateDecision("/loyalty/plans", CLINIC)).toBe("refuse");
    expect(gateDecision("/settings/rates", CLINIC)).toBe("refuse");
  });

  it("allows the product it actually bought", () => {
    expect(gateDecision("/crm", CLINIC)).toBe("render");
    expect(gateDecision("/catalogue", CLINIC)).toBe("render");
    expect(gateDecision("/hrms", CLINIC)).toBe("render");
    expect(gateDecision("/checkins", CLINIC)).toBe("render");
    expect(gateDecision("/settings/team", CLINIC)).toBe("render");
  });
});

describe("gateDecision — Eclat is unchanged", () => {
  it("renders every route in its navigation", () => {
    for (const slug of ECLAT) {
      expect(gateDecision(`/${slug}`, ECLAT)).toBe("render");
    }
  });

  it("renders every module the sidebar can actually show it", () => {
    // A stronger form of the same claim: nothing Eclat can click is refused.
    for (const item of NAV_ITEMS) {
      if (!ECLAT.includes(item.slug)) continue;
      expect(gateDecision(`/${item.slug}`, ECLAT)).toBe("render");
    }
  });

  it("never holds, because its navigation has resolved", () => {
    for (const slug of ECLAT) {
      expect(gateDecision(`/${slug}`, ECLAT)).not.toBe("hold");
    }
  });
});

describe("gateDecision — the fail-open branch is gone", () => {
  /**
   * There is no longer any input that renders a vertical module without the
   * tenant's list positively containing it. Enumerated over the real navigation
   * rather than asserted in prose.
   */
  const VERTICAL = NAV_ITEMS.map((i) => i.slug).filter(
    (slug) => !CORE_NAVIGATION.includes(slug),
  );

  it("has vertical modules to test", () => {
    expect(VERTICAL.length).toBeGreaterThan(10);
  });

  it("never renders a vertical module for an empty, core or undefined list", () => {
    for (const slug of VERTICAL) {
      expect(gateDecision(`/${slug}`, [])).toBe("refuse");
      expect(gateDecision(`/${slug}`, [...CORE_NAVIGATION])).toBe("refuse");
      expect(gateDecision(`/${slug}`, undefined)).toBe("hold");
    }
  });

  it("renders a vertical module only when it is listed", () => {
    for (const slug of VERTICAL) {
      expect(gateDecision(`/${slug}`, [...CORE_NAVIGATION, slug])).toBe("render");
    }
  });
});
