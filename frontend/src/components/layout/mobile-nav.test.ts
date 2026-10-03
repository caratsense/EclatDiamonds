import { describe, expect, it } from "vitest";

import { primaryTabSlugs } from "./mobile-nav";
import { visibleNavGroups } from "@/lib/navigation";
import type { AccessMap, Role } from "@/lib/types";

/**
 * The phone's bottom tabs: the first four screens of a preferred order that the
 * person can open, then "More".
 *
 * Sales staff on attendance only can open none of the sales screens in that
 * order, so their bar used to be a lone "More" button with their one screen
 * behind it. Attendance is now the last in the order, so it fills a bar that
 * has room and changes nothing for a bar that is already full.
 */
const tabs = (role: Role, access?: AccessMap) =>
  primaryTabSlugs(
    new Set(visibleNavGroups(role, undefined, access).flatMap((g) => g.items.map((i) => i.slug))),
  );

describe("the phone's bottom tabs", () => {
  it("gives somebody on attendance only their one screen", () => {
    expect(tabs("salesperson", { hrms: "own" })).toEqual(["hrms"]);
  });

  it("leaves a bar that was already full as it was", () => {
    expect(tabs("salesperson")).toEqual(["crm", "quotation", "catalogue", "checkins"]);
    expect(tabs("store_manager")).toEqual(["dashboards", "crm", "quotation", "catalogue"]);
  });

  it("adds attendance where there is room, after the screens that were there", () => {
    // Marketing, or a salesperson given one screen back.
    expect(tabs("marketing", { crm: "store", reminders: "store", hrms: "own" })).toEqual([
      "crm",
      "reminders",
      "hrms",
    ]);
    expect(tabs("salesperson", { crm: "own", hrms: "own" })).toEqual(["crm", "hrms"]);
  });
});
