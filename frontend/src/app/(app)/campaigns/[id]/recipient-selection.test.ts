import { describe, expect, it } from "vitest";

import type { CampaignRecipientRow } from "@/lib/queries/campaigns";
import {
  allTaggableSelected,
  taggableRows,
  withPageSelected,
} from "./recipient-selection";

/**
 * The rule these pin: a tag from the broadcast screen lands on the CUSTOMER,
 * because that is the only way the next broadcast's audience builder can
 * include or exclude those people by it. So a recipient row with no customer
 * record has nothing to tag, and "select everyone on this page" must mean the
 * same set as the tick boxes beside it — a header tick that selected rows the
 * row ticks refuse would report tagging people it never tagged.
 */

function row(id: string, partyId: string | null): CampaignRecipientRow {
  return {
    id,
    partyId,
    contact: "+919820000000",
    status: "failed",
    exclusionReason: null,
    lastError: null,
    sentAt: null,
  };
}

describe("which rows can be tagged", () => {
  it("keeps the rows that have a customer behind them", () => {
    expect(taggableRows([row("r1", "p1"), row("r2", null)]).map((r) => r.id)).toEqual(["r1"]);
  });

  it("keeps nothing on a page of numbers no customer claims", () => {
    expect(taggableRows([row("r1", null), row("r2", null)])).toEqual([]);
  });
});

describe("select everyone on this page", () => {
  it("ticks only the rows that can carry a tag", () => {
    const next = withPageSelected(new Set(), [row("r1", "p1"), row("r2", null)], true);
    expect([...next]).toEqual(["r1"]);
  });

  it("leaves rows ticked on other pages alone", () => {
    // A page holds ten rows and the client asked to tag several people at a
    // time; a selection that emptied itself on every page turn would make
    // tagging thirty people thirty decisions.
    const next = withPageSelected(new Set(["elsewhere"]), [row("r1", "p1")], true);
    expect([...next].sort()).toEqual(["elsewhere", "r1"]);
  });

  it("unticks this page without touching the others", () => {
    const next = withPageSelected(new Set(["elsewhere", "r1"]), [row("r1", "p1")], false);
    expect([...next]).toEqual(["elsewhere"]);
  });

  it("reads as fully selected once every taggable row is ticked", () => {
    const rows = [row("r1", "p1"), row("r2", null)];
    expect(allTaggableSelected(rows, new Set(["r1"]))).toBe(true);
  });

  it("does not read as fully selected when a taggable row is missing", () => {
    const rows = [row("r1", "p1"), row("r2", "p2")];
    expect(allTaggableSelected(rows, new Set(["r1"]))).toBe(false);
  });

  it("is never 'all selected' on a page with nothing taggable", () => {
    // `every` on an empty list is true, which would show a ticked header box
    // over an empty selection and do nothing when pressed.
    expect(allTaggableSelected([row("r1", null)], new Set())).toBe(false);
    expect(allTaggableSelected([], new Set())).toBe(false);
  });
});
