import type { CampaignRecipientRow } from "@/lib/queries/campaigns";

/**
 * Which recipient rows can be ticked, and what "select everyone on this page"
 * means.
 *
 * The tag the client asked for goes on the CUSTOMER — that is the whole point
 * of it, since the next broadcast's audience builder includes and excludes by
 * tag — so a recipient row that is not linked to a customer record has nothing
 * to carry one. A broadcast can hold such rows: a number messaged from a thread
 * that never matched a customer.
 *
 * Kept out of the page so the rule can be tested without rendering a table,
 * and so "select all" can never quietly mean a different set from the tick
 * boxes beside it.
 */

/** Rows on this page with a customer behind them. */
export function taggableRows(rows: CampaignRecipientRow[]): CampaignRecipientRow[] {
  return rows.filter((r) => Boolean(r.partyId));
}

/**
 * Is every taggable row on this page ticked?
 *
 * False for a page with nothing taggable on it: a header tick box that reads as
 * "all selected" over an empty selection is a lie, and pressing it would do
 * nothing.
 */
export function allTaggableSelected(
  rows: CampaignRecipientRow[],
  selected: ReadonlySet<string>,
): boolean {
  const taggable = taggableRows(rows);
  return taggable.length > 0 && taggable.every((r) => selected.has(r.id));
}

/**
 * Tick or untick every taggable row on this page, leaving the rest of the
 * selection alone.
 *
 * Rows ticked on other pages survive: a page holds ten rows, and the client
 * asked to "select multiple people at a time and then give them a custom tag" —
 * a selection that emptied itself on every page turn would make tagging thirty
 * people thirty decisions.
 */
export function withPageSelected(
  selected: ReadonlySet<string>,
  rows: CampaignRecipientRow[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const row of taggableRows(rows)) {
    if (on) next.add(row.id);
    else next.delete(row.id);
  }
  return next;
}
