import { describe, expect, it } from "vitest";

import { primaryTabSlugs } from "./mobile-nav";
import { visibleNavGroups } from "@/lib/navigation";
import type { AccessMap, Role } from "@/lib/types";

/**
 * The phone's bottom tabs: three screens from a preferred order, HR in the last
 * slot, then "More".
 *
 * HR used to be seventh in that order and cut by the four-tab limit, so the one
 * screen every role holds — punch in, punch out, apply for leave, read the
 * roster — was the only one a phone could not reach without opening "More". It
 * now takes the last slot whenever the person holds it, which is also what keeps
 * somebody on attendance only from facing a bar that is just "More".
 */
const tabs = (role: Role, access?: AccessMap) =>
  primaryTabSlugs(
    new Set(visibleNavGroups(role, undefined, access).flatMap((g) => g.items.map((i) => i.slug))),
  );

describe("the phone's bottom tabs", () => {
  it("gives somebody on attendance only their one screen", () => {
    expect(tabs("salesperson", { hrms: "own" })).toEqual(["hrms"]);
  });

  it("keeps the HR entry on the bar for the staff whose work it is", () => {
    // Four tabs either way; the fourth sales screen (Check-ins, Catalogue) is
    // one tap away under "More" and is not an action on a clock.
    expect(tabs("salesperson")).toEqual(["crm", "quotation", "catalogue", "hrms"]);
    expect(tabs("store_manager")).toEqual(["dashboards", "crm", "quotation", "hrms"]);
    for (const role of ["salesperson", "store_manager", "area_manager", "head_office"] as Role[]) {
      expect([role, tabs(role).includes("hrms")]).toEqual([role, true]);
    }
  });

  it("never draws more tabs than fit", () => {
    for (const role of ["salesperson", "store_manager", "area_manager", "head_office", "marketing"] as Role[]) {
      expect(tabs(role).length).toBeLessThanOrEqual(4);
    }
  });

  it("leaves a bar with room to spare as it was", () => {
    // Marketing, or a salesperson given one screen back.
    expect(tabs("marketing", { crm: "store", reminders: "store", hrms: "own" })).toEqual([
      "crm",
      "reminders",
      "hrms",
    ]);
    expect(tabs("salesperson", { crm: "own", hrms: "own" })).toEqual(["crm", "hrms"]);
  });

  it("drops the HR tab for somebody who does not hold the screen", () => {
    expect(tabs("marketing", { crm: "store", reminders: "store" })).toEqual(["crm", "reminders"]);
  });
});
