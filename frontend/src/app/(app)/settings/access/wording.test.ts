import { describe, expect, it } from "vitest";

import { bulkAttendanceOnlyPrompt, startingPointLine } from "./wording";

/**
 * What People & Access says when a workspace starts its sales staff on
 * attendance only (backend auth/access.ts, ATTENDANCE_ONLY_SALES_ORGS).
 *
 * There the starting point is not the role's, and "Role defaults" no longer
 * brings the sales screens back, so the two sentences that said otherwise
 * change. Everywhere else they read as before.
 */
describe("People & Access wording", () => {
  it("says where a person's starting point comes from", () => {
    expect(startingPointLine({ name: "Riya Shah", role: "salesperson", startsAttendanceOnly: true })).toBe(
      "Sales staff in this workspace start with attendance only. Switch on what this person needs.",
    );
    expect(startingPointLine({ name: "Riya Shah", role: "salesperson", startsAttendanceOnly: false })).toBe(
      "Starts from what a salesperson gets. Changes apply to Riya Shah only.",
    );
    expect(startingPointLine({ name: "Mohan", role: "store_manager", startsAttendanceOnly: false })).toBe(
      "Starts from what a store manager gets. Changes apply to Mohan only.",
    );
  });

  it("offers \"Role defaults\" as the undo only where it still undoes it", () => {
    const usual = bulkAttendanceOnlyPrompt(12, false);
    expect(usual).toContain("Set all 12 sales staff to attendance only?");
    expect(usual).toContain('Undo it for any one person with "Role defaults".');

    const alreadyTheStart = bulkAttendanceOnlyPrompt(12, true);
    expect(alreadyTheStart).toContain("Set all 12 sales staff to attendance only?");
    expect(alreadyTheStart).not.toContain("Role defaults");
    expect(alreadyTheStart).toContain("takes away the screens that were switched on");
  });
});
