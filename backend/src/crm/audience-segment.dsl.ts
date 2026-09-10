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
