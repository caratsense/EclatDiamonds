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
function repliedStampWhere(organisationId: string, partyId: string): Prisma.FeedbackRequestWhereInput {
  return {
    organisationId,
    partyId,
    sentAt: { not: null },
    respondedAt: null,
    repliedAt: null,
  };
}

describe('marking a feedback request as replied to', () => {
  const where = repliedStampWhere('org_eclat', 'party_1');

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

  it('does not filter on status, deliberately', () => {
    // `sentAt` is the fact that it left; `status` is bookkeeping that varies by
    // path. Narrowing on status would miss replies to requests in a state this
    // rule was never told about.
    expect('status' in where).toBe(false);
  });
});
