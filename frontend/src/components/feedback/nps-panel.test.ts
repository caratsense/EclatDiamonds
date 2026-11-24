import { describe, expect, it } from "vitest";

import { nothingAskedYet } from "@/components/feedback/nps-panel";
import type { NpsUpdateRow } from "@/lib/queries/nps";

/**
 * When NPS Updates owes the reader an explanation (client, on her first look at
 * the screen: "also in updates why have u put that sheet").
 *
 * The sheet upload came off Updates, which leaves the register showing what it
 * is: one visit and eight columns of dashes, because production has never sent
 * an ask and never had a workbook uploaded. Whether that gets explained is
 * decided here, and it fails silently either way — a register that has started
 * filling would keep insisting nobody was asked, and an untouched one would go
 * on showing dashes with no reason given.
 */

const visit = (over: Partial<NpsUpdateRow> = {}): NpsUpdateRow => ({
  checkInId: "ci_1",
  partyId: null,
  customerName: "Asha",
  phone: "+919820000000",
  store: "Surat — Main",
  visitAt: "2026-08-10T09:50:19.777Z",
  visitDate: "2026-08-10",
  salesperson: "Head Office",
  manager: null,
  stage: "pending_initial",
  stageLabel: "Pending initial message",
  replyState: "none",
  initialSentAt: null,
  reminderDueAt: null,
  reminderSentAt: null,
  repliedAt: null,
  submittedAt: null,
  score: null,
  scoreAnswer: null,
  failureNote: null,
  attempts: 0,
  followups: [],
  ...over,
});

describe("whether NPS Updates explains its dashes", () => {
  it("explains them when no visit has been asked or has answered", () => {
    expect(nothingAskedYet([visit(), visit({ checkInId: "ci_2" })])).toBe(true);
  });

  /*
   * No rows is a different screen — the "No visits yet" empty state already
   * says what fills it. Claiming nobody was asked on top of that would be two
   * explanations for one blank page.
   */
  it("says nothing when there are no visits at all", () => {
    expect(nothingAskedYet([])).toBe(false);
  });

  it("stops once a single ask has gone out", () => {
    expect(
      nothingAskedYet([visit(), visit({ checkInId: "ci_2", initialSentAt: "2026-08-11T05:00:00Z" })]),
    ).toBe(false);
  });

  /*
   * Each of the five facts counts on its own. A reminder sent without a first
   * send, or a follow-up typed by a colleague with no ask on record, are both
   * real rows in the client's register — and either one means the table is no
   * longer blank.
   */
  it("counts a reminder, a reply, a submission or a follow-up as activity", () => {
    expect(nothingAskedYet([visit({ reminderSentAt: "2026-08-14T05:00:00Z" })])).toBe(false);
    expect(nothingAskedYet([visit({ repliedAt: "2026-08-12T05:00:00Z" })])).toBe(false);
    expect(nothingAskedYet([visit({ submittedAt: "2026-08-13T05:00:00Z" })])).toBe(false);
    expect(
      nothingAskedYet([
        visit({
          followups: [{ id: "fu_1", at: "2026-08-15T05:00:00Z", date: null, response: "Called" }],
        }),
      ]),
    ).toBe(false);
  });
});
