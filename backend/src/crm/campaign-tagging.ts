/**
 * Tagging the people on a broadcast's recipient list.
 *
 * The client's words: "I can select multiple people at a time and then I can
 * give them a custom tag. So next time when I create a broadcast I can include
 * or exclude those people through tags."
 *
 * The tag lands on the CUSTOMER, not on the recipient row — the row belongs to
 * one broadcast and is finished, and a tag whose whole purpose is to shape the
 * next broadcast has to outlive this one. Which means a recipient row with no
 * linked customer has nothing to tag, and the only honest thing to do is say
 * so by name rather than quietly tag fewer people than were ticked.
 */

export interface RecipientForTagging {
  id: string;
  partyId: string | null;
}

export interface TaggingPartition {
  /** The customers to tag, each one once. */
  partyIds: string[];
  /** Ticked rows that are not linked to a customer record. */
  withoutCustomer: string[];
  /** Ids asked for that are not on this broadcast at all. */
  notOnThisBroadcast: string[];
}

/**
 * Split the ticked rows into the ones that can carry a tag and the ones that
 * cannot.
 *
 * `partyIds` is de-duplicated because one customer can hold two recipient rows
 * on the same broadcast: the unique key is the campaign and the NUMBER, so a
 * customer whose phone and WhatsApp fields differ appears twice. Counting them
 * twice would report "tagged 14" for 13 people.
 */
export function partitionForTagging(
  requestedIds: string[],
  rows: RecipientForTagging[],
): TaggingPartition {
  const found = new Map(rows.map((r) => [r.id, r]));
  const partyIds: string[] = [];
  const seen = new Set<string>();
  const withoutCustomer: string[] = [];
  const notOnThisBroadcast: string[] = [];

  for (const id of new Set(requestedIds)) {
    const row = found.get(id);
    if (!row) {
      notOnThisBroadcast.push(id);
      continue;
    }
    if (!row.partyId) {
      withoutCustomer.push(id);
      continue;
    }
    if (seen.has(row.partyId)) continue;
    seen.add(row.partyId);
    partyIds.push(row.partyId);
  }

  return { partyIds, withoutCustomer, notOnThisBroadcast };
}
