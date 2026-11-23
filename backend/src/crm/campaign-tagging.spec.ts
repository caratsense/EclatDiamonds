import { partitionForTagging } from './campaign-tagging';

/**
 * Tagging people from a broadcast, and the two cases that must not be hidden.
 *
 * The tag goes on the CUSTOMER so the next broadcast's audience builder can
 * include or exclude by it, which means a recipient row with no customer behind
 * it has nothing to carry a tag. Reporting a smaller number with no explanation
 * is how somebody tags nine people, is told "tagged 9", and discovers next month
 * that two of them were never labelled.
 */

describe('which ticked rows can carry a tag', () => {
  it('tags the customer behind each ticked row', () => {
    const split = partitionForTagging(['r1', 'r2'], [
      { id: 'r1', partyId: 'p1' },
      { id: 'r2', partyId: 'p2' },
    ]);
    expect(split.partyIds).toEqual(['p1', 'p2']);
    expect(split.withoutCustomer).toEqual([]);
    expect(split.notOnThisBroadcast).toEqual([]);
  });

  it('counts one customer once when two of their numbers were messaged', () => {
    // The unique key is the campaign and the NUMBER, so a customer whose phone
    // and WhatsApp fields differ holds two rows on one broadcast. Counting them
    // twice would report "tagged 2" for one person.
    const split = partitionForTagging(['r1', 'r2'], [
      { id: 'r1', partyId: 'p1' },
      { id: 'r2', partyId: 'p1' },
    ]);
    expect(split.partyIds).toEqual(['p1']);
  });

  it('names the rows that have no customer record rather than dropping them', () => {
    const split = partitionForTagging(['r1', 'r2'], [
      { id: 'r1', partyId: null },
      { id: 'r2', partyId: 'p2' },
    ]);
    expect(split.partyIds).toEqual(['p2']);
    expect(split.withoutCustomer).toEqual(['r1']);
  });

  it('names ids that are not on this broadcast', () => {
    // A screen left open while the broadcast was re-expanded, or an id posted
    // by hand. Either way it is not a silent no-op.
    const split = partitionForTagging(['r1', 'ghost'], [{ id: 'r1', partyId: 'p1' }]);
    expect(split.partyIds).toEqual(['p1']);
    expect(split.notOnThisBroadcast).toEqual(['ghost']);
  });

  it('ignores a row ticked twice', () => {
    const split = partitionForTagging(['r1', 'r1'], [{ id: 'r1', partyId: 'p1' }]);
    expect(split.partyIds).toEqual(['p1']);
    expect(split.notOnThisBroadcast).toEqual([]);
  });

  it('tags nobody when nothing was ticked', () => {
    const split = partitionForTagging([], [{ id: 'r1', partyId: 'p1' }]);
    expect(split.partyIds).toEqual([]);
  });
});
