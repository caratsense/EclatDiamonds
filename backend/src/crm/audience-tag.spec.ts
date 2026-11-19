import { compileSegment, parseSegmentDefinition } from './audience-segment.dsl';

/**
 * Building a broadcast audience from customer tags.
 *
 * The client asked for this directly: "there is still no tag option in
 * broadcast". The tag vocabulary (LeadTag) and the assignments
 * (PartyTagAssignment) already existed and were already editable on a
 * customer's profile — what was missing was any way to turn them into an
 * audience, which is the one thing she wanted tags for.
 *
 * `not_in` is asserted as hard as `in`. Most fields in this compiler switch on
 * the FIELD and ignore the operator, so a `not_in` elsewhere is accepted and
 * then compiled as an include — an exclusion that quietly includes everyone it
 * was meant to protect. On a broadcast that is the worst failure available, so
 * the exclusion path is pinned here.
 */

const compile = (definition: unknown) =>
  compileSegment(parseSegmentDefinition(definition), new Date('2026-11-19T00:00:00Z'));

const tagRule = (op: string, value: string[]) => ({
  match: 'all',
  conditions: [{ field: 'party.tag', op, value }],
});

describe('including customers by tag', () => {
  it('matches a customer carrying any of the chosen tags', () => {
    const { where } = compile(tagRule('in', ['tag-meta', 'tag-walkin']));
    expect(where).toEqual({
      AND: [{ partyTagAssignments: { some: { tagId: { in: ['tag-meta', 'tag-walkin'] } } } }],
    });
  });

  it('reads as something a person can check before sending', () => {
    const { reasons } = compile(tagRule('in', ['tag-meta']));
    expect(reasons.join(' ')).toMatch(/tagged/);
  });
});

describe('excluding customers by tag', () => {
  it('compiles not_in to a real NOT, never to an include', () => {
    // The whole point. A suppression tag that silently includes the people it
    // names would message exactly the customers it was added to protect.
    const { where } = compile(tagRule('not_in', ['tag-optout']));
    expect(where).toEqual({
      AND: [{ NOT: { partyTagAssignments: { some: { tagId: { in: ['tag-optout'] } } } } }],
    });
  });

  it('says so in the reason, so the exclusion is visible on review', () => {
    const { reasons } = compile(tagRule('not_in', ['tag-optout']));
    expect(reasons.join(' ')).toMatch(/is not tagged/);
  });
});

describe('combining tags with the rest of an audience', () => {
  it('ands an include with an exclude, which is the client example', () => {
    // "Include Meta Leads, restrict to Store A, exclude a suppression tag."
    const { where } = compile({
      match: 'all',
      conditions: [
        { field: 'party.tag', op: 'in', value: ['tag-meta'] },
        { field: 'party.storeId', op: 'in', value: ['mumbai-bandra'] },
        { field: 'party.tag', op: 'not_in', value: ['tag-optout'] },
      ],
    });
    const and = (where as { AND: unknown[] }).AND;
    expect(and).toHaveLength(3);
    expect(and).toContainEqual({
      partyTagAssignments: { some: { tagId: { in: ['tag-meta'] } } },
    });
    expect(and).toContainEqual({
      NOT: { partyTagAssignments: { some: { tagId: { in: ['tag-optout'] } } } },
    });
  });

  it('gives "has ALL of these tags" without a new operator', () => {
    // One condition per tag under match:'all' — the same way every other
    // field already composes. No `has_all` op to invent or maintain.
    const { where } = compile({
      match: 'all',
      conditions: [
        { field: 'party.tag', op: 'in', value: ['tag-bridal'] },
        { field: 'party.tag', op: 'in', value: ['tag-vip'] },
      ],
    });
    expect((where as { AND: unknown[] }).AND).toHaveLength(2);
  });

  it('gives "has ANY of these tags" from one condition', () => {
    const { where } = compile(tagRule('in', ['tag-bridal', 'tag-vip']));
    expect(where).toEqual({
      AND: [{ partyTagAssignments: { some: { tagId: { in: ['tag-bridal', 'tag-vip'] } } } }],
    });
  });

  it('ors the conditions under match: any', () => {
    const { where } = compile({
      match: 'any',
      conditions: [
        { field: 'party.tag', op: 'in', value: ['tag-bridal'] },
        { field: 'party.tag', op: 'in', value: ['tag-vip'] },
      ],
    });
    expect(where).toHaveProperty('OR');
  });
});

describe('a tag rule that cannot be honoured', () => {
  it('refuses an empty tag list rather than matching everyone', () => {
    expect(() => compile(tagRule('in', []))).toThrow();
  });
});
