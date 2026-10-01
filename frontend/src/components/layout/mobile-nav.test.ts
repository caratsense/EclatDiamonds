import { describe, expect, it } from "vitest";

import { primaryTabs } from "./mobile-nav";
import { homeForRole, visibleNavGroups } from "@/lib/navigation";
import type { AccessMap, Role } from "@/lib/types";

/** The bottom bar's tabs as the phone builds them for one person. */
const tabsFor = (role: Role, access?: AccessMap) =>
  primaryTabs(
    new Set(visibleNavGroups(role, undefined, access).flatMap((g) => g.items.map((i) => i.slug))),
    homeForRole(role, undefined, access),
  ).map((tab) => tab.slug);

describe("the phone's bottom bar", () => {
  it("gives someone set to attendance only a tab for the punch screen", () => {
    // Their one screen in the navigation is HRMS, which sits under More. Without
    // this tab a phone had no way back to Check in / Check out once leave was
    // open: the logo that leads home is in the sidebar, and a phone has none.
    expect(tabsFor("salesperson", { hrms: "own" })).toEqual(["check-in"]);
    expect(tabsFor("store_manager", { hrms: "store" })).toEqual(["check-in"]);
  });

  it("leaves everyone else's tabs as they were", () => {
    expect(tabsFor("salesperson")).toEqual(["crm", "quotation", "catalogue", "checkins"]);
    expect(tabsFor("store_manager")).toEqual(["dashboards", "crm", "quotation", "catalogue"]);
    // CRM off but other screens kept is not attendance only: no punch tab.
    expect(tabsFor("salesperson", { hrms: "own", catalogue: "own", quotation: "own" })).toEqual([
      "quotation",
      "catalogue",
    ]);
  });
});
