import type { BulkDeleteResult } from "@/lib/queries/parties";

/**
 * Saying what a bulk delete did, and what the ticks on screen actually cover.
 *
 * Both of these are about not overstating. A bulk delete of fifty customers
 * routinely comes back part done — the Gati-synced ones and anyone with a sale
 * are refused — so "Deleted" on its own would be a lie, and a bare count would
 * leave somebody re-ticking rows to find the survivors. And a tick box can only
 * ever select the rows this page loaded: "select all" has to say so, or a
 * manager who filtered to 248 customers will believe all 248 are going.
 *
 * Pure, and kept out of the page, so the wording is testable.
 */

/** How completely a bulk delete went through. */
export type BulkDeleteTone = "all" | "some" | "none";

export function bulkDeleteTone(result: BulkDeleteResult): BulkDeleteTone {
  if (!result.skipped.length) return "all";
  return result.deleted.length ? "some" : "none";
}

/** One line for the toast. The detail belongs to `skippedLines`. */
export function describeBulkDelete(result: BulkDeleteResult): string {
  const deleted = result.deleted.length;
  const kept = result.skipped.length;

  if (!kept) {
    return deleted === 1
      ? `${result.deleted[0].name} deleted.`
      : `${deleted} customers deleted.`;
  }
  if (!deleted) {
    return kept === 1 ? "That customer was kept." : `None deleted — all ${kept} were kept.`;
  }
  return `${deleted} of ${result.requested} deleted — ${kept} kept.`;
}

/**
 * Why each refused customer is still here, by name.
 *
 * A customer the caller may not see has no name to give, and inventing one
 * ("Customer abc123") would read as a record that exists somewhere.
 */
export function skippedLines(result: BulkDeleteResult): string[] {
  return result.skipped.map((s) => `${s.name ?? "A customer no longer in your list"} — ${s.reason}`);
}

/**
 * What the current selection covers, said plainly.
 *
 * `onPage` is how many rows this page loaded, `total` how many match the search
 * and filters. The second sentence appears only when they differ, because that
 * is the only time anybody can be misled.
 */
export function describeSelection(input: {
  selected: number;
  onPage: number;
  total: number;
}): string {
  const { selected, onPage, total } = input;
  const head = `${selected} selected`;
  if (total <= onPage) return head;
  return `${head} of ${onPage} on this page · ${total} match your filters`;
}
