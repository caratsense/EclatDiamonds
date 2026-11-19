import { SEGMENT_FIELDS, compileSegment, parseSegmentDefinition } from './audience-segment.dsl';

/**
 * Building a broadcast audience from customer tags.
 *
 * The client asked for this directly: "there is still no tag option in
 * broadcast". The tag vocabulary (LeadTag) and the assignments
 * (PartyTagAssignment) already existed and were already editable on a
 * customer's profile — what was missing was any way to turn them into an
 * audience, which is the one thing she wanted tags for.
 *
 * `not_in` is asserted as hard as `in`. This compiler once switched on the
 * FIELD and ignored the operator everywhere but here, so a `not_in` on any
 * other field was accepted and then compiled as an include — an exclusion that
 * quietly messages everyone it was meant to protect. On a broadcast that is the
 * worst failure available, so the exclusion path is pinned here for the tag and,
 * below, for every other field that an audience can be built from.
 */

const compile = (definition: unknown) =>
  compileSegment(parseSegmentDefinition(definition), new Date('2026-11-19T00:00:00Z'));

const tagRule = (op: string, value: string[]) => ({
  match: 'all',
  conditions: [{ field: 'party.tag', op, value }],
});

/**
 * What one tag rule compiles to. Each value is tried as an id and as a name,
 * because the builder sends ids and the API and older saved segments send names
 * — see audience-tag-name.spec.ts for that half.
 */
const tagged = (values: string[]) => ({
  partyTagAssignments: {
    some: {
      OR: [{ tagId: { in: values } }, { tag: { name: { in: values, mode: 'insensitive' } } }],
    },
  },
});

describe('including customers by tag', () => {
  it('matches a customer carrying any of the chosen tags', () => {
    const { where } = compile(tagRule('in', ['tag-meta', 'tag-walkin']));
    expect(where).toEqual({ AND: [tagged(['tag-meta', 'tag-walkin'])] });
  });

  it('reads as something a person can check before sending', () => {
    const { reasons } = compile(tagRule('in', ['tag-meta']));
    expect(reasons.join(' ')).toMatch(/tagged/);
  });

  it('names the tags the rule was written with, not how many there were', () => {
    // "is tagged 2 selected tag(s)" is a count nobody can check against what
    // they picked, and the preview's "Because" list is what the client
    // approves a broadcast from.
    const { reasons } = compile(tagRule('in', ['Meta Leads', 'VIP']));
    expect(reasons).toEqual(['is tagged "Meta Leads" or "VIP"']);
  });

  it('counts the tags it cannot name rather than inventing names for them', () => {
    // The builder sends ids. This compiler is pure — it has no tenant to look
    // an id up in — so it says how many were picked and quotes nothing it
    // would have to guess at.
    const { reasons } = compile(tagRule('in', ['cmh2k9x1a0000qzrm4w8d3ltf']));
    expect(reasons).toEqual(['is tagged 1 tag picked from your list']);
  });

  it('says both halves when a rule mixes a typed name with a picked tag', () => {
    const { reasons } = compile(tagRule('in', ['Meta Leads', 'cmh2k9x1a0000qzrm4w8d3ltf']));
    expect(reasons).toEqual(['is tagged "Meta Leads" or 1 tag picked from your list']);
  });
});

describe('excluding customers by tag', () => {
  it('compiles not_in to a real NOT, never to an include', () => {
    // The whole point. A suppression tag that silently includes the people it
    // names would message exactly the customers it was added to protect.
    const { where } = compile(tagRule('not_in', ['tag-optout']));
    expect(where).toEqual({ AND: [{ NOT: tagged(['tag-optout']) }] });
  });

  it('says so in the reason, so the exclusion is visible on review', () => {
    const { reasons } = compile(tagRule('not_in', ['tag-optout']));
    expect(reasons.join(' ')).toMatch(/is not tagged/);
  });

  it('names the suppressed tag, which is the one a reviewer must recognise', () => {
    const { reasons } = compile(tagRule('not_in', ['Do Not Contact']));
    expect(reasons).toEqual(['is not tagged "Do Not Contact"']);
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
    expect(and).toContainEqual(tagged(['tag-meta']));
    expect(and).toContainEqual({ NOT: tagged(['tag-optout']) });
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
    expect(where).toEqual({ AND: [tagged(['tag-bridal', 'tag-vip'])] });
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

/**
 * Every field an audience can be built from, and what an exclusion on it must
 * do. `excludesWith: null` means the field cannot express one and must refuse.
 *
 * The bug this table exists for: the compiler read the operator for three
 * fields and ignored it for the rest, so "city is not Mumbai" or "did not come
 * in through Meta" compiled to the include. Nobody could see it on the preview
 * — the count looked plausible, and the broadcast went to the people the rule
 * named. A field is only allowed two answers now: a real negative, or a
 * refusal that says what it does support.
 *
 * Exclusions on a column that may be empty keep the customers the rule never
 * named: `city NOT IN ('Mumbai')` is unknown, not true, where there is no city,
 * and most of this client's customers arrived from WhatsApp with none.
 */
const EXCLUSIONS: { field: string; value: unknown; excludesWith: unknown }[] = [
  { field: 'party.id', value: ['party-1'], excludesWith: { id: { notIn: ['party-1'] } } },
  { field: 'party.tag', value: ['tag-optout'], excludesWith: { NOT: tagged(['tag-optout']) } },
  {
    field: 'party.type',
    value: ['supplier'],
    excludesWith: { NOT: { types: { hasSome: ['supplier'] } } },
  },
  {
    field: 'party.storeId',
    value: ['mumbai-bandra'],
    excludesWith: { OR: [{ storeId: { notIn: ['mumbai-bandra'] } }, { storeId: null }] },
  },
  {
    field: 'party.city',
    value: ['Mumbai'],
    excludesWith: { OR: [{ city: { notIn: ['Mumbai'] } }, { city: null }] },
  },
  {
    field: 'party.state',
    value: ['Maharashtra'],
    excludesWith: { OR: [{ state: { notIn: ['Maharashtra'] } }, { state: null }] },
  },
  {
    field: 'party.importBatchId',
    value: ['batch-1'],
    excludesWith: { OR: [{ importBatchId: { notIn: ['batch-1'] } }, { importBatchId: null }] },
  },
  {
    field: 'lead.stage',
    value: ['inquiry'],
    excludesWith: { leads: { none: { stage: { in: ['inquiry'] } } } },
  },
  {
    field: 'lead.source',
    value: ['walk_in'],
    excludesWith: { leads: { none: { source: { in: ['walk_in'] } } } },
  },
  {
    field: 'lead.storeId',
    value: ['mumbai-bandra'],
    excludesWith: { leads: { none: { storeId: { in: ['mumbai-bandra'] } } } },
  },
  {
    field: 'lead.ownerId',
    value: ['user-1'],
    excludesWith: { leads: { none: { ownerId: { in: ['user-1'] } } } },
  },
  // A day count, a money figure, a score and a yes/no have no list to be
  // outside of — their negative is the other test they already offer.
  { field: 'party.createdAt', value: 30, excludesWith: null },
  { field: 'party.isBlacklisted', value: true, excludesWith: null },
  { field: 'party.birthday', value: true, excludesWith: null },
  { field: 'party.anniversary', value: true, excludesWith: null },
  { field: 'lead.createdAt', value: 30, excludesWith: null },
  { field: 'interaction.lastAt', value: 30, excludesWith: null },
  { field: 'transaction.orderCount', value: 1, excludesWith: null },
  { field: 'transaction.totalSpend', value: 50000, excludesWith: null },
  { field: 'intent.score', value: 70, excludesWith: null },
  { field: 'consent.marketing', value: 'granted', excludesWith: null },
  // Tenant vocabulary reaches the language as `attribute:<key>`; the bare word
  // is not a field anything can be built from, with any operator.
  { field: 'attribute', value: ['gold'], excludesWith: null },
];

const rule = (field: string, op: string, value: unknown) => ({
  match: 'all',
  conditions: [{ field, op, value }],
});

/** The one rule's filter, out of the AND the compiler wraps every rule in. */
const only = (where: unknown) => (where as { AND: unknown[] }).AND[0];

const honoured = EXCLUSIONS.filter((e) => e.excludesWith !== null);
const refused = EXCLUSIONS.filter((e) => e.excludesWith === null);

describe('excluding on any field an audience can be built from', () => {
  it('covers every field in the language, so a new one cannot be forgotten', () => {
    // A field added without an entry here is a field whose exclusion nobody
    // decided — which is how this bug arrived in the first place.
    expect([...SEGMENT_FIELDS].sort()).toEqual(EXCLUSIONS.map((e) => e.field).sort());
  });

  it.each(honoured)('compiles not_in on $field to a real negative', ({ field, value, excludesWith }) => {
    expect(only(compile(rule(field, 'not_in', value)).where)).toEqual(excludesWith);
  });

  it.each(honoured)('never compiles not_in on $field to the include', ({ field, value }) => {
    const excluded = only(compile(rule(field, 'not_in', value)).where);
    const included = only(compile(rule(field, 'in', value)).where);
    expect(excluded).not.toEqual(included);
  });

  it.each(refused)('refuses not_in on $field rather than inverting it', ({ field, value }) => {
    expect(() => compile(rule(field, 'not_in', value))).toThrow(field);
  });

  it('refuses an exclusion on a tenant custom field, naming what it does support', () => {
    expect(() => compile(rule('attribute:preferred_metal', 'not_in', ['gold']))).toThrow(
      /preferred_metal/,
    );
  });
});

describe('the other operators a rule can be written with', () => {
  // `not_in` is not the only way a rule can be turned into its opposite. These
  // two were, until the same reading was applied to them.
  it('reads "has no birthday on record" as the absence it says it is', () => {
    const { where, reasons } = compile(rule('party.birthday', 'is_not_set', undefined));
    expect(only(where)).toEqual({ birthday: null });
    expect(reasons).toEqual(['has no birthday on record']);
  });

  it('still reads "has a birthday on record" as the presence', () => {
    expect(only(compile(rule('party.birthday', 'is_set', undefined)).where)).toEqual({
      birthday: { not: null },
    });
  });

  it('refuses "at most one order" instead of compiling it to "at least one"', () => {
    // The customer with ten orders was kept and the customer with none was
    // dropped — the rule inside out, with a plausible-looking count.
    expect(() => compile(rule('transaction.orderCount', 'lte', 1))).toThrow(/never bought/);
    expect(only(compile(rule('transaction.orderCount', 'lte', 0)).where)).toEqual({
      sales: { none: {} },
    });
  });
});
