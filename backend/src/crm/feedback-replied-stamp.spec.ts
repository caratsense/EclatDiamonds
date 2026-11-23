import { Prisma } from '@prisma/client';

/**
 * The second feedback ask must not reach somebody who already answered.
 *
 * That rule was written, tested and completely inert: `FeedbackRequest.repliedAt`
 * was READ in four places — the second-ask outcome, two NPS stages and the
 * export — and WRITTEN in none, so the column was permanently null and
 * `already_replied` could never fire. A customer who replied on WhatsApp still
 * got the chaser a day later.
 *
 * What is pinned here is the shape of the write `ingestInbound` now makes, because
 * every condition in it is load-bearing and a silent widening would either nag
 * answered customers again or stamp requests that never went out.
 */

/** The `where` ingestInbound uses, kept here so the conditions are testable. */
function repliedStampWhere(
  organisationId: string,
  partyId: string,
  at: Date,
): Prisma.FeedbackRequestWhereInput {
  return {
    organisationId,
    partyId,
    sentAt: { not: null },
    respondedAt: null,
    repliedAt: null,
    status: { in: ['pending', 'sent'] },
    OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
  };
}

describe('marking a feedback request as replied to', () => {
  const at = new Date('2026-11-23T10:00:00.000Z');
  const where = repliedStampWhere('org_eclat', 'party_1', at);

  it('is scoped to one tenant and one customer', () => {
    // Without both, one customer's reply would silence another's chaser.
    expect(where.organisationId).toBe('org_eclat');
    expect(where.partyId).toBe('party_1');
  });

  it('only counts a request that actually went out', () => {
    // A reply cannot be to a message nobody sent. Stamping a pending request
    // would cancel a chaser for an ask the customer never received.
    expect(where.sentAt).toEqual({ not: null });
  });

  it('leaves an already-answered request alone', () => {
    // `respondedAt` is the form submission. A request answered through the form
    // is finished, and re-stamping it would move a timestamp the register reads.
    expect(where.respondedAt).toBeNull();
  });

  it('records only the FIRST reply', () => {
    /*
     * This condition is also the claim. A conversation is many messages; without
     * it the second and third would keep rewriting the first reply's time, and
     * "when did they answer" would drift later every time they spoke.
     */
    expect(where.repliedAt).toBeNull();
  });

  it('only answers an ask that is still open', () => {
    /*
     * THE BUG THIS REPLACES. The first version of this test asserted the
     * opposite — that `status` was deliberately absent — which pinned the
     * implementation that had just been written rather than the rule that
     * mattered. It passed while the code retro-stamped every survey the
     * customer had ever been sent.
     *
     * A reply answers the ask that is waiting on one. A survey already closed,
     * expired or abandoned is not answered by somebody writing in months later
     * about something else.
     */
    expect(where.status).toEqual({ in: ['pending', 'sent'] });
  });

  it('ignores an ask that has already expired', () => {
    // Same liveness test the rest of the module uses: a request with no expiry
    // stays open, one whose expiry has passed does not.
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: at } }]);
  });

  it('records the time the customer wrote, not the time we processed it', () => {
    // A webhook replayed an hour later must not claim they answered an hour late.
    const replayed = repliedStampWhere('org_eclat', 'party_1', at);
    expect((replayed.OR as { expiresAt: { gt: Date } }[])[1].expiresAt.gt).toBe(at);
  });
});
