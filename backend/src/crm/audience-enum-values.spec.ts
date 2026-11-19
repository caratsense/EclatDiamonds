import { compileSegment, parseSegmentDefinition } from './audience-segment.dsl';

/**
 * A rule that matches nobody should say zero, not crash.
 *
 * The client typed "customer" into Enquiry stage — a plausible word, and the
 * one the generic value box's own placeholder suggested — and got "Something
 * went wrong. The team has been notified." The list went to Prisma as written
 * and Postgres refused it as an enum value, so a question about the data came
 * back as a system failure.
 *
 * Only a rule the system cannot EVALUATE should be an error, and then it has
 * to say which word was wrong and what the choices are, because the person
 * reading it has no other way to find out.
 */
const compile = (field: string, value: unknown) =>
  compileSegment(
    parseSegmentDefinition({ match: 'all', conditions: [{ field, op: 'in', value }] }),
    new Date('2026-11-19T00:00:00Z'),
  );

describe('a value the column cannot hold', () => {
  it('refuses "customer" as an enquiry stage, and names the choices', () => {
    expect(() => compile('lead.stage', ['customer'])).toThrow(/inquiry, quotation, order_placed/);
  });

  it('quotes the word that was wrong, so it can be found and fixed', () => {
    expect(() => compile('lead.source', ['facebook'])).toThrow(/"facebook"/);
  });

  it('refuses an unknown record type', () => {
    expect(() => compile('party.type', ['vendor'])).toThrow(/Choose from/);
  });

  it('refuses the whole rule when one value of several is wrong', () => {
    // Dropping the bad one and compiling the rest would send a broadcast to an
    // audience nobody described.
    expect(() => compile('lead.source', ['walk_in', 'facebook'])).toThrow(/"facebook"/);
  });
});

describe('a value the column can hold', () => {
  it('compiles every real lead source', () => {
    const { where } = compile('lead.source', ['walk_in', 'meta_ads', 'instagram']);
    expect(where).toEqual({
      AND: [{ leads: { some: { source: { in: ['walk_in', 'meta_ads', 'instagram'] } } } }],
    });
  });

  it('compiles every real stage', () => {
    const { where } = compile('lead.stage', ['inquiry', 'quotation', 'order_placed']);
    expect(where).toEqual({
      AND: [{ leads: { some: { stage: { in: ['inquiry', 'quotation', 'order_placed'] } } } }],
    });
  });

  it('compiles a record type', () => {
    const { where } = compile('party.type', ['customer']);
    expect(where).toEqual({ AND: [{ types: { hasSome: ['customer'] } }] });
  });

  it('reads back in words somebody can check before sending', () => {
    expect(compile('lead.source', ['walk_in']).reasons.join(' ')).toMatch(/came in through walk_in/);
  });
});
