import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { DEFAULT_PACK_CODE, getPack, listPacks } from './industry-packs/packs';
import { labelsFor, lexiconFor } from './industry-packs/lexicon';
import { provisionIndustryPack } from './industry-packs/provision';
import type { ConfigurableEntity } from './industry-packs/types';

/**
 * TenantConfigService — the configuration layer every industry-neutral surface
 * reads instead of hardcoding vocabulary (CaratOS Phase A2).
 *
 * Named `TenantConfig`, not `Config`, to stay clear of Nest's own ConfigService
 * (process/env configuration). This one is per-tenant business configuration and
 * is always resolved from the authenticated user's organisation — never from a
 * body, query or header, which is the whole point.
 *
 * UPGRADE RULE: applying a pack INSERTS what is missing and never UPDATES or
 * DELETES what is already there. A tenant who renamed "Bangle" to "Kada" keeps
 * their label through every future pack release. The cost is that a corrected
 * pack label does not propagate — which is the right trade: silently renaming a
 * tenant's own vocabulary under them is worse than a stale default.
 */

const CONFIGURABLE_ENTITIES: ConfigurableEntity[] = ['product', 'party', 'lead'];

/**
 * The only `Organisation.settings` keys GET /config/bootstrap returns.
 *
 * An allow-list rather than a deny-list: a key added to settings later is
 * private until someone deliberately publishes it here, which is the safe
 * direction for a payload every authenticated user can read.
 */
const PUBLIC_SETTINGS_KEYS = ['branding', 'featureProfile'] as const;

function publicSettings(settings: Prisma.JsonValue | null): Record<string, unknown> {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const source = settings as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_SETTINGS_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const DATA_TYPES = ['text', 'number', 'decimal', 'boolean', 'date', 'enum', 'multi_enum'];
const REQUIREMENTS = ['hidden', 'optional', 'required'];

@Injectable()
export class TenantConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The industry packs a new tenant can choose from during onboarding. */
  availablePacks() {
    return { packs: listPacks(), defaultPackCode: DEFAULT_PACK_CODE };
  }

  /**
   * GET /config/bootstrap — everything a client needs to render itself for this
   * tenant: identity, locale, vocabularies, custom fields and field policy.
   *
   * `configVersion` is returned so a client can cache this and revalidate
   * cheaply; it is bumped by every mutation below.
   */
  async bootstrap(user: AuthUser) {
    const organisationId = user.organisationId;

    const [organisation, terms, attributes, policies] = await Promise.all([
      this.prisma.organisation.findUnique({
        where: { id: organisationId },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          industryPackCode: true,
          industryPackVersion: true,
          country: true,
          currency: true,
          timezone: true,
          settings: true,
          configVersion: true,
        },
      }),
      this.prisma.taxonomyTerm.findMany({
        where: { organisationId, isActive: true },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
        select: {
          id: true,
          kind: true,
          code: true,
          label: true,
          parentId: true,
          sortOrder: true,
          systemValue: true,
          packCode: true,
          metadata: true,
        },
      }),
      this.prisma.attributeDefinition.findMany({
        where: { organisationId, isActive: true },
        orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
      }),
      this.prisma.fieldPolicy.findMany({
        where: { organisationId },
        orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }],
      }),
    ]);

    // The guard guarantees the user's organisation exists, so a miss here is a
    // genuine data fault, not a permission problem.
    if (!organisation) throw new NotFoundException('Organisation not found');

    const pack = getPack(organisation.industryPackCode);

    return {
      organisation: {
        id: organisation.id,
        name: organisation.name,
        slug: organisation.slug,
        status: organisation.status,
        country: organisation.country,
        currency: organisation.currency,
        timezone: organisation.timezone,
        /*
         * A NARROWED view of the settings bag, not the bag.
         *
         * `settings` also holds CRM routing rules, ad-set automation and
         * qualification policy — internal user ids, store ids and thresholds.
         * This endpoint is readable by every authenticated user including a
         * salesperson, and it was handing all of that out because the whole
         * column was spread into the response. Only the two keys a client
         * actually renders from are returned; everything else is served by the
         * endpoint that owns it, to the role that owns it.
         */
        settings: publicSettings(organisation.settings),
        configVersion: organisation.configVersion,
      },
      industry: {
        packCode: organisation.industryPackCode,
        packName: pack?.name ?? null,
        appliedVersion: organisation.industryPackVersion,
        /** True when a newer pack version ships than the one applied. */
        upgradeAvailable: !!pack && (organisation.industryPackVersion ?? 0) < pack.version,
        /**
         * Set when the tenant's recorded pack code has no definition in this
         * release. Reported rather than silently defaulted — the tenant's own
         * taxonomy rows still work, but pack upgrades cannot be offered.
         */
        packMissing: !!organisation.industryPackCode && !pack,
        /*
         * The routes this industry's product includes, DERIVED from the pack on
         * every read rather than stored.
         *
         * It used to be written once into `settings.featureProfile` at signup
         * and never touched again, so changing industry afterwards moved a
         * tenant's vocabulary, fields and pipeline while leaving them on the
         * previous industry's navigation — permanently, since nothing rewrote
         * it. Deriving it here means the answer is always the applied pack's,
         * there is no second copy to drift, and no backfill is needed for the
         * tenants that already have a stale one.
         *
         * Null when the pack is unknown to this release, which the client reads
         * as "impose nothing" and falls back to the stored profile.
         */
        enabledNavigation: pack?.onboarding?.enabledNavigation ?? null,
        /** What this industry's CRM assistant is for. Descriptive, not a prompt. */
        aiContext: pack?.onboarding?.aiCrmContext ?? null,
      },
      /**
       * Neutral label -> this industry's word, for the two components that
       * render chrome. Empty for jewellery and for any pack with no lexicon,
       * which is what keeps Eclat's wording bit-for-bit unchanged.
       */
      labels: labelsFor(pack),
      /** The resolved nouns behind those labels, for the configuration screen. */
      lexicon: lexiconFor(pack),
      /** Vocabularies grouped by kind, in display order. */
      taxonomies: this.groupTerms(terms, pack),
      /** Custom attribute definitions grouped by the entity that carries them. */
      attributes: this.groupBy(attributes, (a) => a.entity),
      /** Per-field visibility/labels for BUILT-IN fields, grouped by entity. */
      fieldPolicies: this.groupBy(policies, (p) => p.entity),
      configurableEntities: CONFIGURABLE_ENTITIES,
    };
  }

  private groupTerms(
    terms: {
      kind: string;
      code: string;
      label: string;
      id: string;
      parentId: string | null;
      sortOrder: number;
      systemValue: string | null;
      packCode: string | null;
      metadata: Prisma.JsonValue | null;
    }[],
    pack: ReturnType<typeof getPack>,
  ) {
    const packMeta = new Map(
      (pack?.taxonomies ?? []).map((t) => [t.kind, { label: t.label, systemBacked: !!t.systemBacked }]),
    );
    const out: Record<string, { label: string; systemBacked: boolean; terms: typeof terms }> = {};
    for (const t of terms) {
      const meta = packMeta.get(t.kind);
      // A vocabulary the tenant invented has no pack metadata; label it from its
      // own kind rather than dropping it.
      out[t.kind] ??= { label: meta?.label ?? t.kind, systemBacked: meta?.systemBacked ?? false, terms: [] };
      out[t.kind].terms.push(t);
    }
    return out;
  }

  private groupBy<T>(rows: T[], key: (row: T) => string): Record<string, T[]> {
    const out: Record<string, T[]> = {};
    for (const row of rows) (out[key(row)] ??= []).push(row);
    return out;
  }

  /**
   * Apply (or upgrade to) an industry pack for the caller's organisation.
   *
   * Idempotent and additive — safe to re-run. Runs in one transaction so a
   * half-applied pack can never be observed. See the UPGRADE RULE above: this
   * only ever inserts.
   */
  async applyPack(user: AuthUser, packCode: string) {
    const pack = getPack(packCode);
    if (!pack) {
      throw new BadRequestException(
        `Unknown industry pack "${packCode}". Available: ${listPacks().map((p) => p.code).join(', ')}.`,
      );
    }
    const organisationId = user.organisationId;

    const inserted = await this.prisma.$transaction((tx) =>
      provisionIndustryPack(tx, organisationId, pack),
    );

    await this.audit.record(user, {
      action: 'config.pack_applied',
      entityType: 'system',
      entityId: pack.code,
      summary: `Applied industry pack "${pack.name}" v${pack.version}`,
      metadata: { ...inserted, packCode: pack.code, packVersion: pack.version },
    });

    return {
      packCode: pack.code,
      packName: pack.name,
      packVersion: pack.version,
      inserted,
      message:
        inserted.terms +
          inserted.attributes +
          inserted.fieldPolicies +
          inserted.pipelines ===
        0
          ? 'Pack already applied — nothing to add. Existing configuration was left untouched.'
          : `Added ${inserted.terms} term(s), ${inserted.attributes} attribute(s) and ` +
            `${inserted.fieldPolicies} field policy row(s), plus ${inserted.pipelines} CRM pipeline(s). ` +
            'Existing configuration was left untouched.',
    };
  }

  // -------------------------------------------------------------------------
  // Taxonomy
  // -------------------------------------------------------------------------

  async listTerms(user: AuthUser, kind?: string, includeInactive = false) {
    return this.prisma.taxonomyTerm.findMany({
      where: {
        organisationId: user.organisationId,
        ...(kind ? { kind } : {}),
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async createTerm(
    user: AuthUser,
    input: {
      kind: string;
      code: string;
      label: string;
      parentId?: string;
      sortOrder?: number;
      systemValue?: string;
    },
  ) {
    const organisationId = user.organisationId;

    // A parent must belong to the same tenant AND the same vocabulary. Checking
    // the organisation here is what stops a crafted parentId from stitching this
    // tenant's tree onto another's.
    if (input.parentId) {
      const parent = await this.prisma.taxonomyTerm.findFirst({
        where: { id: input.parentId, organisationId },
        select: { kind: true },
      });
      if (!parent) throw new NotFoundException('Parent term not found');
      if (parent.kind !== input.kind) {
        throw new BadRequestException('Parent term belongs to a different vocabulary');
      }
    }

    const duplicate = await this.prisma.taxonomyTerm.findUnique({
      where: { organisationId_kind_code: { organisationId, kind: input.kind, code: input.code } },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(`"${input.code}" already exists in ${input.kind}`);
    }

    const term = await this.prisma.taxonomyTerm.create({
      data: {
        organisationId,
        kind: input.kind,
        code: input.code,
        label: input.label,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
        // Tenant-created terms never claim a system enum value: the typed column
        // would reject it at write time. `systemValue` is settable only where the
        // caller supplied one that a pack already uses for this vocabulary.
        systemValue: await this.resolveSystemValue(organisationId, input.kind, input.systemValue),
        packCode: null,
      },
    });
    await this.bump(user, 'config.term_created', term.id, `Added ${input.kind} "${input.label}"`);
    return term;
  }

  /**
   * Guard the enum bridge. A tenant may only attach a `systemValue` that some
   * existing term in the same vocabulary already uses — which means a pack put it
   * there, which means the Prisma enum genuinely accepts it. Anything else would
   * let the UI offer a value the database rejects on save.
   */
  private async resolveSystemValue(
    organisationId: string,
    kind: string,
    requested?: string,
  ): Promise<string | null> {
    if (!requested) return null;
    const known = await this.prisma.taxonomyTerm.findFirst({
      where: { organisationId, kind, systemValue: requested },
      select: { id: true },
    });
    if (!known) {
      throw new BadRequestException(
        `"${requested}" is not a value the ${kind} column accepts. Leave it blank to create a ` +
          `label-only term, or pick a value an existing term already maps to.`,
      );
    }
    return requested;
  }

  async updateTerm(
    user: AuthUser,
    id: string,
    input: { label?: string; sortOrder?: number; isActive?: boolean },
  ) {
    const term = await this.prisma.taxonomyTerm.findFirst({
      where: { id, organisationId: user.organisationId },
      select: { id: true, kind: true, label: true },
    });
    if (!term) throw new NotFoundException('Term not found');

    const updated = await this.prisma.taxonomyTerm.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.bump(user, 'config.term_updated', id, `Updated ${term.kind} "${updated.label}"`);
    return updated;
  }

  /**
   * Terms are DEACTIVATED, never deleted. Rows elsewhere may reference a term's
   * code, and hard-deleting it would turn a historical record into a dangling
   * label with no way to explain itself.
   */
  async deactivateTerm(user: AuthUser, id: string) {
    return this.updateTerm(user, id, { isActive: false });
  }

  // -------------------------------------------------------------------------
  // Custom attributes
  // -------------------------------------------------------------------------

  async upsertAttribute(
    user: AuthUser,
    input: {
      entity: string;
      key: string;
      label: string;
      dataType: string;
      required?: boolean;
      taxonomyKind?: string;
      options?: string[];
      unit?: string;
      searchable?: boolean;
      sortOrder?: number;
    },
  ) {
    const organisationId = user.organisationId;
    if (!CONFIGURABLE_ENTITIES.includes(input.entity as ConfigurableEntity)) {
      throw new BadRequestException(
        `Custom attributes are only supported on: ${CONFIGURABLE_ENTITIES.join(', ')}.`,
      );
    }
    if (!DATA_TYPES.includes(input.dataType)) {
      throw new BadRequestException(`Unknown data type. Use one of: ${DATA_TYPES.join(', ')}.`);
    }
    if ((input.dataType === 'enum' || input.dataType === 'multi_enum') && !input.taxonomyKind && !input.options?.length) {
      throw new BadRequestException(
        'An enum attribute needs either a taxonomyKind or a non-empty options list.',
      );
    }

    const data = {
      label: input.label,
      dataType: input.dataType,
      required: input.required ?? false,
      taxonomyKind: input.taxonomyKind ?? null,
      options: (input.options ?? undefined) as Prisma.InputJsonValue | undefined,
      unit: input.unit ?? null,
      searchable: input.searchable ?? false,
      sortOrder: input.sortOrder ?? 0,
    };

    const attribute = await this.prisma.attributeDefinition.upsert({
      where: {
        organisationId_entity_key: { organisationId, entity: input.entity, key: input.key },
      },
      create: { organisationId, entity: input.entity, key: input.key, ...data },
      update: data,
    });
    await this.bump(
      user,
      'config.attribute_upserted',
      attribute.id,
      `Custom field ${input.entity}.${input.key} ("${input.label}")`,
    );
    return attribute;
  }

  /**
   * Deactivated, not deleted — the values already written into each row's
   * `attributes` JSON stay where they are, and re-enabling the definition brings
   * them back rather than losing them.
   */
  async deactivateAttribute(user: AuthUser, id: string) {
    const existing = await this.prisma.attributeDefinition.findFirst({
      where: { id, organisationId: user.organisationId },
      select: { id: true, entity: true, key: true },
    });
    if (!existing) throw new NotFoundException('Attribute not found');
    const updated = await this.prisma.attributeDefinition.update({
      where: { id },
      data: { isActive: false },
    });
    await this.bump(
      user,
      'config.attribute_deactivated',
      id,
      `Hid custom field ${existing.entity}.${existing.key} (existing values kept)`,
    );
    return updated;
  }

  // -------------------------------------------------------------------------
  // Field policy (built-in fields)
  // -------------------------------------------------------------------------

  async upsertFieldPolicy(
    user: AuthUser,
    input: { entity: string; field: string; requirement: string; label?: string; sortOrder?: number },
  ) {
    if (!REQUIREMENTS.includes(input.requirement)) {
      throw new BadRequestException(`requirement must be one of: ${REQUIREMENTS.join(', ')}.`);
    }
    const organisationId = user.organisationId;
    const data = {
      requirement: input.requirement,
      label: input.label ?? null,
      sortOrder: input.sortOrder ?? 0,
    };
    const policy = await this.prisma.fieldPolicy.upsert({
      where: {
        organisationId_entity_field: { organisationId, entity: input.entity, field: input.field },
      },
      create: { organisationId, entity: input.entity, field: input.field, ...data },
      update: data,
    });
    await this.bump(
      user,
      'config.field_policy_set',
      policy.id,
      `${input.entity}.${input.field} is now ${input.requirement}`,
    );
    return policy;
  }

  /**
   * Bump `configVersion` and write one audit row. Every mutation above funnels
   * through here so a client's cached bootstrap can never go stale silently.
   */
  private async bump(user: AuthUser, action: string, entityId: string, summary: string) {
    await this.prisma.organisation.update({
      where: { id: user.organisationId },
      data: { configVersion: { increment: 1 } },
    });
    await this.audit.record(user, {
      action,
      entityType: 'system',
      entityId,
      summary,
    });
  }
}
