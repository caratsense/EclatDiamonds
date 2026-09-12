import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreScopeService } from '../../common/store-scope.service';
import {
  FIELD_DICTIONARY,
  normaliseHeader,
  type ImportEntity,
} from './field-dictionary';
import { MAX_IMPORT_COLUMNS } from './csv.util';
import type { FieldMappingInput } from './import.service';

/**
 * A column mapping somebody already worked out once.
 *
 * The import pipeline already maps any spreadsheet onto canonical fields; what
 * it did not do was REMEMBER. A supplier file arrives every month with the same
 * forty columns, and re-mapping it monthly is where mistakes creep in: the
 * column that was "Cost" is "Cost Price" this month, the mapping is rebuilt from
 * scratch, and nobody notices it landed in `price`.
 *
 * The important part is not storing the mapping — it is storing the HEADERS it
 * was built from. Applying a profile to a file whose columns have changed then
 * reports exactly what moved. A profile that silently maps whatever columns
 * happen to be present is worse than re-mapping by hand, because it is wrong
 * confidently and at scale.
 */

const ENTITIES: ImportEntity[] = ['customers', 'stores', 'products'];
const MAX_PROFILES_PER_ENTITY = 50;

export interface ProfileFit {
  /** Mappings that can be applied as-is: the source column is still there. */
  applicable: FieldMappingInput[];
  /** Columns the profile expects that this file does not have. */
  missingColumns: string[];
  /** Columns in this file the profile says nothing about. */
  unknownColumns: string[];
  /** True when every mapped column is present — the "just apply it" case. */
  exact: boolean;
}

@Injectable()
export class MappingProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, entity?: string) {
    if (entity) this.assertEntity(entity);
    const rows = await this.prisma.importMappingProfile.findMany({
      where: { ...this.scope.orgFilter(user), ...(entity ? { entity } : {}) },
      orderBy: [{ lastUsedAt: 'desc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toView(r));
  }

  async save(
    user: AuthUser,
    input: {
      name: string;
      entity: string;
      mappings: FieldMappingInput[];
      sourceHeaders?: string[];
    },
  ) {
    this.assertEntity(input.entity);
    const name = input.name.trim();
    if (name.length < 2) throw new BadRequestException('Give the profile a name.');

    const mappings = this.validateMappings(input.entity as ImportEntity, input.mappings);
    const headers = (input.sourceHeaders ?? mappings.map((m) => m.sourceColumn))
      .map((h) => h.trim())
      .filter(Boolean);

    const existing = await this.prisma.importMappingProfile.count({
      where: { ...this.scope.orgFilter(user), entity: input.entity },
    });
    if (existing >= MAX_PROFILES_PER_ENTITY) {
      throw new BadRequestException(
        `There are already ${MAX_PROFILES_PER_ENTITY} saved mappings for ${input.entity}. Delete one first.`,
      );
    }

    /*
     * Upsert by NAME, not create-only. Re-saving "Gati monthly stock" after the
     * supplier renamed a column is the normal way this is used, and forcing a
     * delete-then-create for it would leave a window with no profile at all.
     */
    const row = await this.prisma.importMappingProfile.upsert({
      where: {
        organisationId_entity_name: {
          organisationId: user.organisationId,
          entity: input.entity,
          name,
        },
      },
      create: {
        organisationId: user.organisationId,
        name,
        entity: input.entity,
        mappings: mappings as unknown as Prisma.InputJsonValue,
        sourceHeaders: headers,
        createdById: user.id,
      },
      update: {
        mappings: mappings as unknown as Prisma.InputJsonValue,
        sourceHeaders: headers,
      },
    });

    await this.audit.record(user, {
      action: 'imports.mapping_profile_saved',
      entityType: 'ImportMappingProfile',
      entityId: row.id,
      summary: `Saved import mapping "${row.name}" for ${row.entity}`,
      metadata: { fields: mappings.length, headers: headers.length },
    });
    return this.toView(row);
  }

  async remove(user: AuthUser, id: string) {
    const row = await this.prisma.importMappingProfile.findFirst({
      where: { id, ...this.scope.orgFilter(user) },
    });
    if (!row) throw new NotFoundException('No such saved mapping here.');
    await this.prisma.importMappingProfile.delete({ where: { id } });
    await this.audit.record(user, {
      action: 'imports.mapping_profile_deleted',
      entityType: 'ImportMappingProfile',
      entityId: id,
      summary: `Deleted import mapping "${row.name}"`,
    });
    return { deleted: true };
  }

  /**
   * How well does a saved profile fit the file in front of us?
   *
   * The answer is three lists, not a boolean. A profile whose columns are all
   * present is applied in one click; one where two columns have vanished shows
   * WHICH two, so the person can decide whether the supplier renamed them or
   * genuinely stopped sending them. Applying it regardless — mapping by position,
   * or quietly dropping the missing ones — is how an import silently writes the
   * cost column into the price field.
   */
  fit(
    profile: { mappings: unknown; sourceHeaders: string[] },
    headers: string[],
  ): ProfileFit {
    const mappings = asMappings(profile.mappings);
    // Matched on the NORMALISED header, so a supplier changing "Cost Price" to
    // "COST_PRICE" is correctly treated as the same column rather than as one
    // disappearing and another appearing.
    const present = new Map(headers.map((h) => [normaliseHeader(h), h]));

    const applicable: FieldMappingInput[] = [];
    const missingColumns: string[] = [];
    const claimed = new Set<string>();

    for (const m of mappings) {
      const actual = present.get(normaliseHeader(m.sourceColumn));
      if (actual == null) {
        missingColumns.push(m.sourceColumn);
        continue;
      }
      applicable.push({ sourceColumn: actual, canonicalField: m.canonicalField });
      claimed.add(normaliseHeader(actual));
    }

    const unknownColumns = headers.filter((h) => !claimed.has(normaliseHeader(h)));
    return {
      applicable,
      missingColumns,
      unknownColumns,
      exact: missingColumns.length === 0,
    };
  }

  /**
   * Apply a saved profile to a file's headers.
   *
   * Returns the mappings AND what did not fit, so the caller renders both. It
   * also stamps usage, which is what makes the list sort by "the one you
   * actually use" rather than alphabetically.
   */
  async apply(user: AuthUser, id: string, headers: string[]) {
    const profile = await this.prisma.importMappingProfile.findFirst({
      where: { id, ...this.scope.orgFilter(user) },
    });
    if (!profile) throw new NotFoundException('No such saved mapping here.');

    const fit = this.fit(profile, headers);
    await this.prisma.importMappingProfile.update({
      where: { id },
      data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
    });
    return {
      profile: this.toView(profile),
      ...fit,
      /*
       * Said in words, because the difference matters and a list of column names
       * on its own does not say what to do about it.
       */
      warning: fit.exact
        ? null
        : `This file is missing ${fit.missingColumns.length} column(s) the mapping expects: ` +
          `${fit.missingColumns.slice(0, 5).join(', ')}` +
          `${fit.missingColumns.length > 5 ? '…' : ''}. ` +
          `Those fields will be blank unless you map them by hand.`,
    };
  }

  private validateMappings(
    entity: ImportEntity,
    mappings: FieldMappingInput[],
  ): FieldMappingInput[] {
    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new BadRequestException('A mapping profile needs at least one column.');
    }
    if (mappings.length > MAX_IMPORT_COLUMNS) {
      throw new BadRequestException(
        `A mapping may cover at most ${MAX_IMPORT_COLUMNS} columns.`,
      );
    }
    const known = new Set(FIELD_DICTIONARY[entity].map((f) => f.field));
    const seenField = new Set<string>();
    const cleaned: FieldMappingInput[] = [];

    for (const m of mappings) {
      const sourceColumn = String(m.sourceColumn ?? '').trim();
      const canonicalField = String(m.canonicalField ?? '').trim();
      if (!sourceColumn || !canonicalField) {
        throw new BadRequestException('Every mapping needs a column and a field.');
      }
      if (!known.has(canonicalField)) {
        throw new BadRequestException(
          `"${canonicalField}" is not a field a ${entity} import can write.`,
        );
      }
      // Two columns writing one field is not a preference, it is a file the
      // importer cannot resolve — and picking one silently is the wrong answer.
      if (seenField.has(canonicalField)) {
        throw new BadRequestException(
          `Two columns are both mapped to "${canonicalField}". Pick one.`,
        );
      }
      seenField.add(canonicalField);
      cleaned.push({ sourceColumn, canonicalField });
    }
    return cleaned;
  }

  private assertEntity(entity: string): asserts entity is ImportEntity {
    if (!(ENTITIES as string[]).includes(entity)) {
      throw new BadRequestException(`entity must be one of: ${ENTITIES.join(', ')}.`);
    }
  }

  private toView(r: {
    id: string;
    name: string;
    entity: string;
    mappings: unknown;
    sourceHeaders: string[];
    lastUsedAt: Date | null;
    useCount: number;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      name: r.name,
      entity: r.entity,
      mappings: asMappings(r.mappings),
      sourceHeaders: r.sourceHeaders,
      lastUsedAt: r.lastUsedAt,
      useCount: r.useCount,
      createdAt: r.createdAt,
    };
  }
}

/** JSON out of the database is `unknown`; this is the one place that is settled. */
function asMappings(value: unknown): FieldMappingInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (m): m is FieldMappingInput =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as FieldMappingInput).sourceColumn === 'string' &&
        typeof (m as FieldMappingInput).canonicalField === 'string',
    )
    .map((m) => ({ sourceColumn: m.sourceColumn, canonicalField: m.canonicalField }));
}
