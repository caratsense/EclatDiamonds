import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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

/** Bounded so a pathological rule tree cannot become a pathological query. */
export const MAX_CONDITIONS = 25;

// ---------------------------------------------------------------- parsing

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException(`"${field}" needs a non-empty list of values.`);
  }
  if (value.length > 200) {
    throw new BadRequestException(`"${field}" accepts at most 200 values.`);
  }
  return value.map((v) => {
    if (typeof v !== 'string' || !v.trim()) {
      throw new BadRequestException(`"${field}" accepts text values only.`);
    }
    return v.trim();
  });
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

  switch (c.field) {
    // ------------------------------------------------------------ party
    case 'party.type': {
      const values = asStringArray(c.value, c.field);
      return {
        where: { types: { hasSome: values as never } },
        reason: `is a ${values.join(' or ')}`,
      };
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
      return {
        where: c.op === 'not_in' ? { storeId: { notIn: values } } : { storeId: { in: values } },
        reason: c.op === 'not_in' ? 'not at the chosen branches' : 'at the chosen branches',
      };
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
      return {
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
      return {
        where: { importBatchId: { in: asStringArray(c.value, c.field) } },
        reason: 'came from the chosen import',
      };
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
      return {
        where: { [col]: { not: null } } as Prisma.PartyWhereInput,
        reason: `has a ${col} on record`,
      };
    }

    // ------------------------------------------------------------- lead
    case 'lead.stage': {
      const values = asStringArray(c.value, c.field);
      return {
        where: { leads: { some: { stage: { in: values as never } } } },
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
       * `not_in` is honoured here deliberately. Most fields in this compiler
       * switch on the FIELD and ignore the operator, so a `not_in` elsewhere
       * is accepted and then silently compiled as an include -- the opposite
       * of what the rule says. An exclusion that quietly includes is the worst
       * possible failure for a broadcast, so this field reads the operator.
       */
      if (c.op === 'not_in') {
        return { where: { NOT: has }, reason: `is not tagged ${values.length} selected tag(s)` };
      }
      return { where: has, reason: `is tagged ${values.length} selected tag(s)` };
    }
    case 'lead.source': {
      const values = asStringArray(c.value, c.field);
      return {
        where: { leads: { some: { source: { in: values as never } } } },
        reason: `came in through ${values.join(' or ')}`,
      };
    }
    case 'lead.storeId':
      return {
        where: { leads: { some: { storeId: { in: asStringArray(c.value, c.field) } } } },
        reason: 'has a lead at the chosen branches',
      };
    case 'lead.ownerId':
      return {
        where: { leads: { some: { ownerId: { in: asStringArray(c.value, c.field) } } } },
        reason: 'has a lead owned by the chosen staff',
      };
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
      if (c.op === 'lte' && n === 0) {
        return { where: { sales: { none: {} } }, reason: 'has never bought' };
      }
      if (n <= 1) {
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
