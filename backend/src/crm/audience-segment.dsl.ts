import { BadRequestException } from '@nestjs/common';
import { LeadSource, LeadStage, PartyType, Prisma } from '@prisma/client';

/**
 * The audience condition language.
 *
 * A saved segment stores a rule tree, never SQL. A stored predicate would be an
 * injection surface, and worse, it could not be re-checked for tenant scope at
 * read time — the tenant filter here is applied by the caller AFTER compilation
 * and cannot be overridden by anything a user typed.
 *
 * Every field below is neutral. There is deliberately no `party.metalPreference`
 * or `lead.karat`: industry vocabulary reaches this language through
 * `attribute:<key>`, which reads the tenant's own AttributeDefinition keys out of
 * `Party.attributes`. A jeweller's `preferred_metal` and a hospital's
 * `department` are then the same mechanism, and neither needs a migration.
 */

export const SEGMENT_FIELDS = [
  // --- who they are -------------------------------------------------------
  /*
   * NAMED CUSTOMERS, CHOSEN BY HAND.
   *
   * Every other field here describes a rule ("bought in the last year", "has
   * not visited for 90 days") and the audience is whoever happens to match it.
   * Sometimes the audience is not a rule at all: a manager has five people in
   * mind and wants to send to those five.
   *
   * Expressing that as a field rather than as a separate `partyIds` column on
   * the campaign is what keeps it cheap and keeps it safe. A hand-picked list
   * then travels the identical path as any other audience: previewed with a
   * real count before anything is written, frozen into `audienceSnapshot` at
   * approval, store-scoped on expansion, and filtered by marketing consent and
   * the archive at send time. A second audience mechanism would be a second
   * place for all of that to be forgotten.
   */
  'party.id',
  /*
   * TAGS, THE WAY THE CLIENT ACTUALLY SEGMENTS.
   *
   * "Meta Leads", "Walk-in Leads", a tag per branch -- the vocabulary already
   * exists as LeadTag and is already editable on a customer's profile. What
   * was missing was any way to build an audience from it, which is the one
   * thing the client asked tags FOR.
   *
   * `in` includes, `not_in` excludes. "Has ALL of these tags" needs no new
   * operator: it is one condition per tag with the segment's own
   * `match: 'all'`, which is how every other field already composes.
   */
  'party.tag',
  'party.type',
  'party.storeId',
  'party.city',
  'party.state',
  'party.createdAt',
  'party.isBlacklisted',
  'party.importBatchId',
  'party.birthday',
  'party.anniversary',
  // --- where they came from ----------------------------------------------
  'lead.stage',
  'lead.source',
  'lead.createdAt',
  'lead.storeId',
  'lead.ownerId',
  // --- what they have done ------------------------------------------------
  'interaction.lastAt',
  'transaction.orderCount',
  'transaction.totalSpend',
  // --- what we think ------------------------------------------------------
  'intent.score',
  // --- may we contact them ------------------------------------------------
  'consent.marketing',
  // --- tenant vocabulary --------------------------------------------------
  'attribute',
] as const;

export type SegmentField = (typeof SEGMENT_FIELDS)[number];

export const SEGMENT_OPS = [
  'in',
  'not_in',
  'eq',
  'ne',
  'gte',
  'lte',
  'within_days',
  'older_than_days',
  'is_set',
  'is_not_set',
  'contains',
] as const;

export type SegmentOp = (typeof SEGMENT_OPS)[number];

export interface SegmentCondition {
  field: string;
  op: SegmentOp;
  value?: unknown;
}

export interface SegmentDefinition {
  match: 'all' | 'any';
  conditions: SegmentCondition[];
}

/*
 * The database's own vocabularies, so a rule can only ask for a value that
 * exists. Typed from the Prisma enums rather than copied: adding a lead source
 * and forgetting this list is how a new channel becomes unselectable, and
 * copying it wrong is how a selectable value becomes a 500.
 */
export const PARTY_TYPES = Object.values(PartyType);
export const LEAD_STAGES = Object.values(LeadStage);
export const LEAD_SOURCES = Object.values(LeadSource);

/** Bounded so a pathological rule tree cannot become a pathological query. */
export const MAX_CONDITIONS = 25;

// ---------------------------------------------------------------- parsing

/**
 * What a rule is called on screen.
 *
 * The messages below are read by whoever is building the audience, and they
 * used to quote the internal key: a rule left unfilled came back as
 * `"party.tag" needs a non-empty list of values`. The client hit that, read it
 * as the builder refusing to count at all, and concluded she could not build
 * an audience from branches alone. A name she recognises and a sentence that
 * says what to do would have cost her nothing.
 *
 * Falls back to the key, which is better than a blank: an unnamed field here
 * is one somebody added above and did not name, and the key at least finds it.
 */
const FIELD_LABELS: Record<string, string> = {
  'party.id': 'Named customers',
  'party.tag': 'Tag',
  'party.type': 'Record type',
  'party.storeId': 'Branch',
  'party.city': 'City',
  'party.state': 'State',
  'party.createdAt': 'Added',
  'party.importBatchId': 'Came from an import',
  'party.isBlacklisted': 'Blocked',
  'lead.stage': 'Enquiry stage',
  'lead.source': 'Enquiry source',
  'lead.storeId': 'Enquiry branch',
  'lead.ownerId': 'Enquiry owner',
  'lead.createdAt': 'Enquiry raised',
  'interaction.lastAt': 'Last activity',
  'transaction.orderCount': 'Has ever bought',
  'transaction.totalSpend': 'An order worth at least',
  'intent.score': 'Interest score',
  'consent.marketing': 'Marketing consent',
};

function labelFor(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException(
      `The "${labelFor(field)}" rule has nothing chosen in it. ` +
        'Pick a value, or delete that rule with the bin beside it.',
    );
  }
  if (value.length > 200) {
    throw new BadRequestException(`"${labelFor(field)}" accepts at most 200 values.`);
  }
  return value.map((v) => {
    if (typeof v !== 'string' || !v.trim()) {
      throw new BadRequestException(`"${labelFor(field)}" accepts text values only.`);
    }
    return v.trim();
  });
}

/**
 * The values a database enum column will actually accept.
 *
 * Without this the list went to Prisma as written and Postgres refused it, so
 * "Enquiry stage is one of customer" — a plausible thing to type, and what the
 * generic value box's own placeholder suggested — came back as "Something went
 * wrong. The team has been notified." A rule that matches nobody should say
 * zero; only a rule the system cannot evaluate should be an error, and then it
 * should say which word was wrong and what the choices are.
 */
function asEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T[] {
  const values = asStringArray(value, field);
  const unknown = values.filter((v) => !allowed.includes(v as T));
  if (unknown.length) {
    throw new BadRequestException(
      `"${labelFor(field)}" does not have ${unknown.map((v) => `"${v}"`).join(', ')}. ` +
        `Choose from: ${allowed.join(', ')}.`,
    );
  }
  return values as T[];
}

function asNumber(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new BadRequestException(`"${field}" needs a number.`);
  }
  return n;
}

function asPositiveInt(value: unknown, field: string): number {
  const n = asNumber(value, field);
  if (!Number.isInteger(n) || n < 0 || n > 36500) {
    throw new BadRequestException(`"${field}" needs a whole number of days between 0 and 36500.`);
  }
  return n;
}

/**
 * `attribute:preferred_metal` → the key. Returns null for anything else, so the
 * caller can tell a tenant-vocabulary field from a built-in one.
 */
function attributeKey(field: string): string | null {
  if (!field.startsWith('attribute:')) return null;
  const key = field.slice('attribute:'.length).trim();
  // Same shape AttributeDefinition.key allows. A key with a quote or a dot would
  // change the meaning of the JSON path below.
  if (!/^[a-z0-9_]{1,64}$/i.test(key)) {
    throw new BadRequestException(
      'A custom field key may contain only letters, numbers and underscores.',
    );
  }
  return key;
}

export function parseSegmentDefinition(input: unknown): SegmentDefinition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('An audience needs a rule definition.');
  }
  const raw = input as Record<string, unknown>;
  const match = raw.match === 'any' ? 'any' : 'all';
  const conditions = raw.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new BadRequestException('An audience needs at least one rule.');
  }
  if (conditions.length > MAX_CONDITIONS) {
    throw new BadRequestException(`An audience may hold at most ${MAX_CONDITIONS} rules.`);
  }

  const parsed: SegmentCondition[] = conditions.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new BadRequestException('Every rule needs a field, a test and a value.');
    }
    const cond = c as Record<string, unknown>;
    const field = typeof cond.field === 'string' ? cond.field.trim() : '';
    const op = cond.op as SegmentOp;
    if (!field) throw new BadRequestException('Every rule needs a field.');
    if (!SEGMENT_OPS.includes(op)) {
      throw new BadRequestException(`"${String(cond.op)}" is not a test this system knows.`);
    }
    const isAttribute = attributeKey(field) !== null;
    if (!isAttribute && !SEGMENT_FIELDS.includes(field as SegmentField)) {
      throw new BadRequestException(`"${field}" is not a field an audience can be built from.`);
    }
    return { field, op, value: cond.value };
  });

  return { match, conditions: parsed };
}

// ------------------------------------------------------------- compilation

export interface CompiledSegment {
  /** A Party filter. The caller ANDs its own organisationId onto this. */
  where: Prisma.PartyWhereInput;
  /**
   * Human-readable reasons, in the order the rules were given, for the preview
   * screen. A count with no explanation is not reviewable.
   */
  reasons: string[];
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Exclude on a column that is allowed to be empty.
 *
 * `notIn` on its own drops every row where the column is null, because in SQL
 * `city NOT IN ('Mumbai')` is unknown rather than true when there is no city.
 * Most of this client's customers arrived from WhatsApp with no city, state,
 * branch or import on record, so "city is not Mumbai" would quietly come back
 * with almost nobody. A customer the rule never named stays in — the same way
 * a customer with no tags at all survives a tag exclusion.
 */
function withoutAnyOf(
  column: 'city' | 'state' | 'storeId' | 'importBatchId',
  values: string[],
): Prisma.PartyWhereInput {
  return { OR: [{ [column]: { notIn: values } }, { [column]: null }] } as Prisma.PartyWhereInput;
}

/**
 * The built-in fields that cannot honestly answer "is not one of", and the
 * tests they do offer.
 *
 * Every field that CAN express an exclusion now does, in its own case below.
 * These cannot: a day count, a money figure, a score and a yes/no have no list
 * to be outside of, and their negative is the other test they already carry.
 * Refusing is the only safe third answer, because the one this compiler used to
 * give was to ignore the operator and compile the include — on a broadcast,
 * a suppression rule messaging exactly the people it was written to protect.
 */
const FIELDS_WITHOUT_AN_EXCLUSION: Record<string, string> = {
  'party.isBlacklisted': 'blocked and not blocked',
  'party.createdAt': '"in the last (days)" and "more than (days) ago"',
  'party.birthday': 'the date being on record and the date being missing',
  'party.anniversary': 'the date being on record and the date being missing',
  'lead.createdAt': '"in the last (days)" and "more than (days) ago"',
  'interaction.lastAt': '"in the last (days)" and "nothing for (days)"',
  'transaction.orderCount': '"never bought" and "bought at least once"',
  'transaction.totalSpend': '"at least" and "at most"',
  'intent.score': '"at least" and "at most"',
  'consent.marketing': 'given and withdrawn',
};

/**
 * A value shaped like an id this system generates, rather than something a
 * person typed.
 *
 * It decides only what a reason may SAY. A tag chosen in the builder arrives as
 * an id, and an id cannot be turned back into a name here: this compiler is
 * pure and has no tenant to look one up in. So a name is quoted and an id is
 * counted. Reading one wrongly costs a quoted id or an uncounted name on the
 * preview; it can never change which customers the rule matches.
 */
function looksLikeId(value: string): boolean {
  return /^c[a-z0-9]{20,}$/.test(value);
}

/**
 * How a tag rule says what was picked.
 *
 * The preview's "Because" list is what a manager approves a broadcast from, and
 * "1 selected tag(s)" is not something anyone can check against what they chose.
 */
function describeTags(values: string[]): string {
  const named = values.filter((v) => !looksLikeId(v)).map((v) => `"${v}"`);
  const fromTheList = values.length - named.length;
  if (fromTheList) {
    named.push(
      fromTheList === 1 ? '1 tag picked from your list' : `${fromTheList} tags picked from your list`,
    );
  }
  return named.join(' or ');
}

/**
 * Compile one condition to a Party filter fragment.
 *
 * `now` is passed in rather than read here so that a preview and the expansion
 * that follows it can be compiled against the same instant — otherwise
 * `within_days` quietly means something different in each, and the count a
 * manager approved is not the count that gets messaged.
 */
function compileCondition(c: SegmentCondition, now: Date): { where: Prisma.PartyWhereInput; reason: string } {
  const key = attributeKey(c.field);
  if (key) {
    switch (c.op) {
      case 'in': {
        const values = asStringArray(c.value, c.field);
        return {
          where: { OR: values.map((v) => ({ attributes: { path: [key], equals: v } })) },
          reason: `${key} is one of ${values.join(', ')}`,
        };
      }
      case 'eq': {
        const v = asStringArray([c.value], c.field)[0];
        return {
          where: { attributes: { path: [key], equals: v } },
          reason: `${key} is ${v}`,
        };
      }
      case 'is_set':
        return {
          where: { NOT: { attributes: { path: [key], equals: Prisma.DbNull } } },
          reason: `${key} is filled in`,
        };
      default:
        throw new BadRequestException(`Custom field "${key}" supports is, is one of, and is filled in.`);
    }
  }

  const insteadOffers = FIELDS_WITHOUT_AN_EXCLUSION[c.field];
  if (c.op === 'not_in' && insteadOffers) {
    throw new BadRequestException(
      `"${c.field}" cannot be used as an exclusion. It supports ${insteadOffers}.`,
    );
  }

  switch (c.field) {
    // ------------------------------------------------------------ party
    case 'party.type': {
      const values = asEnumArray(c.value, c.field, PARTY_TYPES);
      // `types` is a list, so the exclusion is "plays none of these roles". A
      // party carrying no role at all is not one of them and stays in.
      const plays: Prisma.PartyWhereInput = { types: { hasSome: values } };
      return c.op === 'not_in'
        ? { where: { NOT: plays }, reason: `is not a ${values.join(' or ')}` }
        : { where: plays, reason: `is a ${values.join(' or ')}` };
    }
    case 'party.id': {
      const values = asStringArray(c.value, c.field);
      return {
        where: c.op === 'not_in' ? { id: { notIn: values } } : { id: { in: values } },
        reason: c.op === 'not_in'
          ? 'not one of the customers chosen by hand'
          : 'chosen by hand',
      };
    }
    case 'party.storeId': {
      const values = asStringArray(c.value, c.field);
      return c.op === 'not_in'
        ? { where: withoutAnyOf('storeId', values), reason: 'not at the chosen branches' }
        : { where: { storeId: { in: values } }, reason: 'at the chosen branches' };
    }
    case 'party.city':
    case 'party.state': {
      const col = c.field === 'party.city' ? 'city' : 'state';
      if (c.op === 'contains') {
        const v = asStringArray([c.value], c.field)[0];
        return {
          where: { [col]: { contains: v, mode: 'insensitive' } } as Prisma.PartyWhereInput,
          reason: `${col} contains "${v}"`,
        };
      }
      const values = asStringArray(c.value, c.field);
      return c.op === 'not_in'
        ? {
            where: withoutAnyOf(col, values),
            reason: `${col} is not ${values.join(' or ')}`,
          }
        : {
            where: { [col]: { in: values } } as Prisma.PartyWhereInput,
            reason: `${col} is one of ${values.join(', ')}`,
          };
    }
    case 'party.isBlacklisted': {
      const on = c.value === true || c.value === 'true';
      return {
        where: { isBlacklisted: on },
        reason: on ? 'is blocked' : 'is not blocked',
      };
    }
    case 'party.importBatchId':
      if (c.op === 'is_set') {
        return { where: { importBatchId: { not: null } }, reason: 'came from an import' };
      }
      if (c.op === 'is_not_set') {
        return { where: { importBatchId: null }, reason: 'was not imported' };
      }
      {
        const values = asStringArray(c.value, c.field);
        return c.op === 'not_in'
          ? {
              where: withoutAnyOf('importBatchId', values),
              reason: 'did not come from the chosen import',
            }
          : { where: { importBatchId: { in: values } }, reason: 'came from the chosen import' };
      }
    case 'party.createdAt': {
      const days = asPositiveInt(c.value, c.field);
      return c.op === 'older_than_days'
        ? { where: { createdAt: { lt: daysAgo(now, days) } }, reason: `added more than ${days} days ago` }
        : { where: { createdAt: { gte: daysAgo(now, days) } }, reason: `added in the last ${days} days` };
    }
    case 'party.birthday':
    case 'party.anniversary': {
      // Anniversary campaigns care about the DAY, not the year. Postgres
      // date_part through Prisma would need raw SQL; the honest bounded version
      // is "the date is set", with the day-window applied by the caller when a
      // tenant enables occasion campaigns.
      const col = c.field === 'party.birthday' ? 'birthday' : 'anniversary';
      // `is_not_set` is read, not ignored. Ignoring it compiled "has no
      // birthday on record" into its opposite -- the same silent inversion as
      // a `not_in` that includes, reached by a different operator.
      return c.op === 'is_not_set'
        ? {
            where: { [col]: null } as Prisma.PartyWhereInput,
            reason: `has no ${col} on record`,
          }
        : {
            where: { [col]: { not: null } } as Prisma.PartyWhereInput,
            reason: `has a ${col} on record`,
          };
    }

    // ------------------------------------------------------------- lead
    case 'lead.stage': {
      const values = asEnumArray(c.value, c.field, LEAD_STAGES);
      // An exclusion on a lead is `none`, not `NOT some` of one lead: a
      // customer with a second enquiry elsewhere in the pipeline must still be
      // excluded, and a customer with no enquiry at all must still be kept.
      const atStage: Prisma.LeadWhereInput = { stage: { in: values } };
      return c.op === 'not_in'
        ? {
            where: { leads: { none: atStage } },
            reason: `has no lead at stage ${values.join(' or ')}`,
          }
        : {
            where: { leads: { some: atStage } },
            reason: `has a lead at stage ${values.join(' or ')}`,
          };
    }
    case 'party.tag': {
      const values = asStringArray(c.value, c.field);
      /*
       * A TAG IS NAMED BY ITS ID OR BY ITS NAME.
       *
       * The builder sends ids, picked from the tenant's own list. Everything
       * else sends names: an audience built against the API, and every segment
       * saved while the value editor was a free-text box -- the client typed
       * "meta leads", the name of her own tag, and matched nobody.
       *
       * Resolved inside the filter rather than by looking the names up first,
       * because this function is pure: it has no tenant to look them up in,
       * and taking one would mean an async compiler on both call paths. The
       * join is tenant-safe without it. An assignment is only reachable
       * through a party, and the caller has already scoped the party query to
       * its own organisation, so another tenant's tag of the same name cannot
       * be reached. `insensitive` matches the vocabulary's own rule, which
       * already refuses "Meta Leads" beside "meta leads" in one tenant.
       *
       * A value that is neither an id nor a name matches no assignment, so an
       * include reaches nobody and an exclude suppresses nobody. Names are
       * never dropped from the list before the query: an emptied list would
       * compile to "has any tag at all", which is everybody the rule was
       * meant to narrow.
       */
      const has: Prisma.PartyWhereInput = {
        partyTagAssignments: {
          some: {
            OR: [
              { tagId: { in: values } },
              { tag: { name: { in: values, mode: 'insensitive' } } },
            ],
          },
        },
      };
      /*
       * `not_in` is a real NOT, never an include. This compiler once switched
       * on the FIELD and ignored the operator everywhere but here, so a
       * `not_in` on any other field was accepted and then compiled as the
       * include -- the opposite of what the rule said. Every field now either
       * reads the operator or refuses it; nothing silently inverts.
       */
      if (c.op === 'not_in') {
        return { where: { NOT: has }, reason: `is not tagged ${describeTags(values)}` };
      }
      return { where: has, reason: `is tagged ${describeTags(values)}` };
    }
    case 'lead.source': {
      const values = asEnumArray(c.value, c.field, LEAD_SOURCES);
      const cameIn: Prisma.LeadWhereInput = { source: { in: values } };
      return c.op === 'not_in'
        ? {
            where: { leads: { none: cameIn } },
            reason: `did not come in through ${values.join(' or ')}`,
          }
        : { where: { leads: { some: cameIn } }, reason: `came in through ${values.join(' or ')}` };
    }
    case 'lead.storeId': {
      const values = asStringArray(c.value, c.field);
      const atBranch: Prisma.LeadWhereInput = { storeId: { in: values } };
      return c.op === 'not_in'
        ? {
            where: { leads: { none: atBranch } },
            reason: 'has no lead at the chosen branches',
          }
        : {
            where: { leads: { some: atBranch } },
            reason: 'has a lead at the chosen branches',
          };
    }
    case 'lead.ownerId': {
      const values = asStringArray(c.value, c.field);
      const ownedBy: Prisma.LeadWhereInput = { ownerId: { in: values } };
      return c.op === 'not_in'
        ? {
            where: { leads: { none: ownedBy } },
            reason: 'has no lead owned by the chosen staff',
          }
        : {
            where: { leads: { some: ownedBy } },
            reason: 'has a lead owned by the chosen staff',
          };
    }
    case 'lead.createdAt': {
      const days = asPositiveInt(c.value, c.field);
      return c.op === 'older_than_days'
        ? {
            where: { leads: { some: { createdAt: { lt: daysAgo(now, days) } } } },
            reason: `has a lead older than ${days} days`,
          }
        : {
            where: { leads: { some: { createdAt: { gte: daysAgo(now, days) } } } },
            reason: `has a lead from the last ${days} days`,
          };
    }

    // ------------------------------------------------------ what they did
    case 'interaction.lastAt': {
      const days = asPositiveInt(c.value, c.field);
      return c.op === 'older_than_days'
        ? {
            where: {
              NOT: { activityEvents: { some: { occurredAt: { gte: daysAgo(now, days) } } } },
            },
            reason: `no activity in the last ${days} days`,
          }
        : {
            where: { activityEvents: { some: { occurredAt: { gte: daysAgo(now, days) } } } },
            reason: `active in the last ${days} days`,
          };
    }
    case 'transaction.orderCount': {
      const n = asNumber(c.value, c.field);
      if (c.op === 'lte') {
        // Only "at most nothing" can be honoured. "At most one order" used to
        // fall through to "has bought at least once", which is the opposite
        // rule: it kept the customer with ten orders and dropped the one with
        // none.
        if (n === 0) {
          return { where: { sales: { none: {} } }, reason: 'has never bought' };
        }
      } else if (n <= 1) {
        return { where: { sales: { some: {} } }, reason: 'has bought at least once' };
      }
      // Prisma cannot express "count(sales) >= n" in a filter. Rather than
      // silently approximating it, this is refused: an audience that quietly
      // means something else is how the wrong people get messaged.
      throw new BadRequestException(
        'Order count supports "has never bought" and "has bought at least once". ' +
          'Use total spend for finer segmentation.',
      );
    }
    case 'transaction.totalSpend': {
      const n = asNumber(c.value, c.field);
      return c.op === 'lte'
        ? {
            where: { sales: { none: { totalAmount: { gt: new Prisma.Decimal(n) } } } },
            reason: `no single order above ${n}`,
          }
        : {
            where: { sales: { some: { totalAmount: { gte: new Prisma.Decimal(n) } } } },
            reason: `an order of ${n} or more`,
          };
    }

    // -------------------------------------------------------------- intent
    case 'intent.score': {
      const n = asNumber(c.value, c.field);
      return c.op === 'lte'
        ? {
            where: { leadQualifications: { some: { score: { lte: n } } } },
            reason: `intent score at or below ${n}`,
          }
        : {
            where: { leadQualifications: { some: { score: { gte: n } } } },
            reason: `intent score at or above ${n}`,
          };
    }

    // ------------------------------------------------------------- consent
    case 'consent.marketing': {
      // Consent is an event log, not a column: the latest event wins. A filter
      // cannot express "latest", so this narrows to parties that have EVER been
      // granted marketing consent, and the real decision is made per recipient
      // at send time by the delivery policy. Narrowing here only reduces work;
      // it never authorises a send on its own.
      const want = c.value === 'revoked' ? 'consent.revoked' : 'consent.granted';
      return {
        where: { activityEvents: { some: { type: want } } },
        reason: want === 'consent.granted' ? 'has given marketing consent' : 'has withdrawn consent',
      };
    }
  }

  throw new BadRequestException(`"${c.field}" is not a field an audience can be built from.`);
}

export function compileSegment(definition: SegmentDefinition, now: Date): CompiledSegment {
  const parts = definition.conditions.map((c) => compileCondition(c, now));
  const wheres = parts.map((p) => p.where);
  return {
    where: definition.match === 'any' ? { OR: wheres } : { AND: wheres },
    reasons: parts.map((p) => p.reason),
  };
}
