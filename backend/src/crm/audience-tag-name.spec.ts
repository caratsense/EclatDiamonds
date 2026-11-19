import { compileSegment, parseSegmentDefinition } from './audience-segment.dsl';

/**
 * A tag rule that names a tag by NAME.
 *
 * The broadcast builder now stores ids, picked from the tenant's own tag list.
 * The client did not have that list: the value was a free-text box, she typed
 * "meta leads" — the name of her own tag — and the compiler matched it against
 * PartyTagAssignment.tagId, where a name can never match. The audience came
 * back empty with nothing on screen to say why. "Firstly it is not working and
 * secondly, it's not obvious."
 *
 * The picker answers the second half. This is the first: a value that is a name
 * resolves as well as a value that is an id, so an audience built against the
 * API, and every segment saved while the box was free text, still reaches the
 * people it names.
 *
 * Scope is not asserted here because it is not this function's to assert: the
 * caller ANDs its own organisationId onto the compiled filter, and an
 * assignment is only reachable through a party, so a name can only ever resolve
 * to a tag used inside the caller's own organisation.
 */

const compile = (op: string, value: string[]) =>
  compileSegment(
    parseSegmentDefinition({ match: 'all', conditions: [{ field: 'party.tag', op, value }] }),
    new Date('2026-11-19T00:00:00Z'),
  ).where;

/** The one rule's filter, out of the AND the compiler wraps every rule in. */
const only = (where: unknown) => (where as { AND: unknown[] }).AND[0];

/** The ways one tag rule is allowed to match: by id, or by name. */
const waysToMatch = (where: unknown) =>
  (only(where) as { partyTagAssignments: { some: { OR: unknown[] } } }).partyTagAssignments.some.OR;

describe('choosing a tag from the list', () => {
  it('resolves the id the picker stores', () => {
    expect(waysToMatch(compile('in', ['tag-meta']))).toContainEqual({
      tagId: { in: ['tag-meta'] },
    });
  });
});

describe('typing a tag by name', () => {
  it('resolves the name the client typed', () => {
    expect(waysToMatch(compile('in', ['Meta Leads']))).toContainEqual({
      tag: { name: { in: ['Meta Leads'], mode: 'insensitive' } },
    });
  });

  it('does not mind how the name was capitalised', () => {
    // "Meta Leads" and "meta leads" cannot be two tags in one organisation, so
    // they must not be two audiences either.
    expect(waysToMatch(compile('in', ['meta leads']))).toContainEqual({
      tag: { name: { in: ['meta leads'], mode: 'insensitive' } },
    });
  });

  it('reads an exclusion by name as a real exclusion', () => {
    expect(only(compile('not_in', ['Do Not Contact']))).toEqual({
      NOT: {
        partyTagAssignments: {
          some: {
            OR: [
              { tagId: { in: ['Do Not Contact'] } },
              { tag: { name: { in: ['Do Not Contact'], mode: 'insensitive' } } },
            ],
          },
        },
      },
    });
  });
});

describe('a value that is neither a tag id nor a tag name', () => {
  it('matches nobody rather than everybody', () => {
    // The filter still demands an assignment carrying that value, so a
    // customer with no tags — or with every other tag — cannot satisfy it.
    expect(only(compile('in', ['nobody has this tag']))).toEqual({
      partyTagAssignments: {
        some: {
          OR: [
            { tagId: { in: ['nobody has this tag'] } },
            { tag: { name: { in: ['nobody has this tag'], mode: 'insensitive' } } },
          ],
        },
      },
    });
  });

  it('is never quietly dropped from the rest of the list', () => {
    // Dropping what cannot be resolved is how "has any of these two tags"
    // becomes "has any tag at all" — and that is the whole customer base, in
    // one broadcast, with a preview count that looked plausible.
    const where = compile('in', ['tag-meta', 'nobody has this tag']);
    expect(waysToMatch(where)).toContainEqual({
      tagId: { in: ['tag-meta', 'nobody has this tag'] },
    });
    expect(waysToMatch(where)).toContainEqual({
      tag: { name: { in: ['tag-meta', 'nobody has this tag'], mode: 'insensitive' } },
    });
  });

  it('suppresses nobody when the rule is an exclusion', () => {
    // An exclusion naming a tag that does not exist excludes no one, which is
    // the safe direction: it can only ever leave the audience as it was.
    expect(only(compile('not_in', ['nobody has this tag']))).toHaveProperty('NOT');
  });
});
