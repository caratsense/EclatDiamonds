import { describe, expect, it } from "vitest";

import {
  bulkDeleteTone,
  describeBulkDelete,
  describeSelection,
  skippedLines,
} from "./party-bulk-delete";
import type { BulkDeleteResult } from "@/lib/queries/parties";

const result = (over: Partial<BulkDeleteResult>): BulkDeleteResult => ({
  requested: 1,
  deleted: [],
  skipped: [],
  ...over,
});

/**
 * The client asked for bulk delete; the server answers part-done on real data,
 * because a Gati-synced customer and a customer with a sale are both refused.
 * These pin the wording that has to carry that.
 */
describe("reporting a bulk delete", () => {
  it("says so plainly when everything went", () => {
    const r = result({
      requested: 3,
      deleted: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
    });
    expect(bulkDeleteTone(r)).toBe("all");
    expect(describeBulkDelete(r)).toBe("3 customers deleted.");
  });

  it("never reports a part-done delete as done", () => {
    const r = result({
      requested: 3,
      deleted: [{ id: "c", name: "♥♥♥" }],
      skipped: [
        { id: "a", name: "Rajesh Agarwal", reason: "Synced from Gati — a delete would come straight back. Archive instead." },
        { id: "b", name: "Meera Shah", reason: "2 sales on record. Archive instead." },
      ],
    });
    expect(bulkDeleteTone(r)).toBe("some");
    expect(describeBulkDelete(r)).toBe("1 of 3 deleted — 2 kept.");
  });

  it("names each customer that was kept, and why", () => {
    const r = result({
      skipped: [{ id: "a", name: "Meera Shah", reason: "2 sales on record. Archive instead." }],
    });
    expect(bulkDeleteTone(r)).toBe("none");
    expect(skippedLines(r)).toEqual(["Meera Shah — 2 sales on record. Archive instead."]);
  });

  it("does not invent a name for a customer it was not allowed to see", () => {
    const r = result({
      skipped: [{ id: "x", name: null, reason: "No longer in the system." }],
    });
    expect(skippedLines(r)).toEqual([
      "A customer no longer in your list — No longer in the system.",
    ]);
  });
});

/**
 * "Select all" ticks the rows this page loaded and nothing else. The bar has to
 * say that whenever more customers match than are on screen.
 */
describe("what the selection covers", () => {
  it("spells out that the rest of the matches are not selected", () => {
    expect(describeSelection({ selected: 50, onPage: 50, total: 248 })).toBe(
      "50 selected of 50 on this page · 248 match your filters",
    );
  });

  it("stays quiet when this page IS every match", () => {
    expect(describeSelection({ selected: 2, onPage: 7, total: 7 })).toBe("2 selected");
  });
});
