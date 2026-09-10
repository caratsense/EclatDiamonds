import { Prisma } from '@prisma/client';

import type { IndustryPack, PackPipelineStage } from './types';
import { updateOrgSettingsIn } from '../org-settings';
import {
  mergeQuestions,
  readRecord,
  recordFor,
  type ManagedQuestion,
} from './pack-managed';

/**
 * The owner stamped on the generic funnel created before any pack is chosen.
 *
 * Not a real pack, and deliberately not NULL: NULL means "the tenant wrote this"
 * and is a promise never to touch the row. The starter funnel is neither — it is
 * the product's own placeholder wording, so a pack applied later may replace it,
 * while a stage the tenant has since edited (which clears `packCode`) may not.
 *
 * Underscore-prefixed so it cannot collide with a pack code, all of which are
 * plain industry slugs.
 */
export const SYSTEM_PACK_CODE = '_system';

/** The funnel shape a pack declares, as `convergePipeline` needs it. */
export interface PipelineSpec {
  code: string;
  name: string;
  stages: PackPipelineStage[];
  /** What flows through it. Packs only ever declare the lead funnel. */
  entity?: string;
}

export interface IndustryProvisionCounts {
  terms: number;
  attributes: number;
  fieldPolicies: number;
  pipelines: number;
  /** Stages created or re-worded when an existing funnel moved industry. */
  pipelineStages: number;
}

/**
 * Materialise one pack inside the caller's transaction.
 *
 * Keeping this as a transaction-client function lets self-service tenant signup
 * create the organisation, owner, first location, CRM pipeline and vocabulary as
 * one atomic unit. TenantConfigService uses the same function for later pack
 * upgrades, so onboarding cannot drift from the admin configuration screen.
 */
export async function provisionIndustryPack(
  tx: Prisma.TransactionClient,
  organisationId: string,
  pack: IndustryPack,
): Promise<IndustryProvisionCounts> {
  const counts: IndustryProvisionCounts = {
    terms: 0,
    attributes: 0,
    fieldPolicies: 0,
    pipelines: 0,
    pipelineStages: 0,
  };

  // Terms first and parents before children, so parentCode resolves locally.
  for (const taxonomy of pack.taxonomies) {
    const idByCode = new Map<string, string>();
    const ordered = [...taxonomy.terms].sort(
      (a, b) => Number(!!a.parentCode) - Number(!!b.parentCode),
    );
    for (const term of ordered) {
      const existing = await tx.taxonomyTerm.findUnique({
        where: {
          organisationId_kind_code: {
            organisationId,
            kind: taxonomy.kind,
            code: term.code,
          },
        },
        select: { id: true },
      });
      if (existing) {
        idByCode.set(term.code, existing.id);
        continue;
      }
      const parentId = term.parentCode ? idByCode.get(term.parentCode) ?? null : null;
      const created = await tx.taxonomyTerm.create({
        data: {
          organisationId,
          kind: taxonomy.kind,
          code: term.code,
          label: term.label,
          parentId,
          sortOrder: term.sortOrder ?? 0,
          systemValue: term.systemValue ?? null,
          packCode: pack.code,
          metadata: (term.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        select: { id: true },
      });
      idByCode.set(term.code, created.id);
      counts.terms++;
    }
  }

  for (const attr of pack.attributes) {
    const existing = await tx.attributeDefinition.findUnique({
      where: {
        organisationId_entity_key: {
          organisationId,
          entity: attr.entity,
          key: attr.key,
        },
      },
      select: { id: true },
    });
    if (existing) continue;
    await tx.attributeDefinition.create({
      data: {
        organisationId,
        entity: attr.entity,
        key: attr.key,
        label: attr.label,
        dataType: attr.dataType,
        required: attr.required ?? false,
        taxonomyKind: attr.taxonomyKind ?? null,
        options: (attr.options ?? undefined) as Prisma.InputJsonValue | undefined,
        unit: attr.unit ?? null,
        searchable: attr.searchable ?? false,
        sortOrder: attr.sortOrder ?? 0,
        packCode: pack.code,
      },
    });
    counts.attributes++;
  }

  for (const policy of pack.fieldPolicies) {
    const existing = await tx.fieldPolicy.findUnique({
      where: {
        organisationId_entity_field: {
          organisationId,
          entity: policy.entity,
          field: policy.field,
        },
      },
      select: { id: true },
    });
    if (existing) continue;
    await tx.fieldPolicy.create({
      data: {
        organisationId,
        entity: policy.entity,
        field: policy.field,
        requirement: policy.requirement,
        label: policy.label ?? null,
        packCode: pack.code,
      },
    });
    counts.fieldPolicies++;
  }

  /*
   * The CRM funnel and the qualification questions CONVERGE on the new industry,
   * where everything above only ever inserts.
   *
   * They have to. Every pack ships the same pipeline code and the same three
   * stage codes and differs only in wording, so the insert-only rule meant a
   * tenant who changed industry kept the previous industry's funnel for ever
   * while `industryPackCode` claimed otherwise. What makes converging safe is
   * `packCode` on the row itself: a row a pack wrote is ours to re-word, and a
   * row the tenant wrote or has since edited is not.
   */
  const previous = readRecord(await currentSettings(tx, organisationId));
  const pipeline = pack.onboarding?.pipeline;
  if (pipeline) {
    const result = await convergePipeline(tx, organisationId, pipeline, pack.code);
    counts.pipelines += result.created ? 1 : 0;
    counts.pipelineStages += result.changed;
  }

  await tx.organisation.update({
    where: { id: organisationId },
    data: {
      industryPackCode: pack.code,
      industryPackVersion: pack.version,
      configVersion: { increment: 1 },
    },
  });

  // Qualification questions + the ownership record itself, under the row lock.
  await updateOrgSettingsIn(tx, organisationId, (settings) => {
    const policy =
      settings.crmQualification && typeof settings.crmQualification === 'object'
        ? { ...(settings.crmQualification as Record<string, unknown>) }
        : null;
    if (policy) {
      const existingQuestions = Array.isArray(policy.questions)
        ? (policy.questions as ManagedQuestion[]).filter((q) => q && typeof q.key === 'string')
        : [];
      policy.questions = mergeQuestions(existingQuestions, pack, previous);
    }
    return {
      ...settings,
      ...(policy ? { crmQualification: policy } : {}),
      packManaged: recordFor(pack) as unknown as Record<string, unknown>,
    };
  });

  return counts;
}

/**
 * Bring one organisation's funnel to `spec`, touching only rows a pack owns.
 *
 * THE single writer of pipeline rows on behalf of the product — pack
 * provisioning and `PipelinesService.ensureDefault` both come through here, so
 * "the healthcare funnel" means the same thing whichever ran first, and running
 * both in either order converges to one pack-owned pipeline with no duplicates.
 *
 * ## The ownership rule, in full
 *
 *  - `packCode IS NULL` — the tenant's. Never written, in any circumstance. This
 *    covers rows they created and rows they have since edited, because editing a
 *    stage clears the stamp (see `PipelinesService.upsertStage`).
 *  - `packCode` set — the product's wording, from a pack or from the starter
 *    funnel. Re-worded to match `spec`, and re-stamped with the new owner.
 *
 * Only the LABEL and the stamp ever move. `outcome` and `systemValue` are what
 * reports and the typed `LeadStage` column read; every pack agrees on those, so
 * rewriting them could only ever change a historical conversion number.
 *
 * Returns what actually changed so callers can report honest counts — a
 * re-application that changes nothing returns zero.
 */
export async function convergePipeline(
  tx: Prisma.TransactionClient,
  organisationId: string,
  spec: PipelineSpec,
  packCode: string,
): Promise<{ created: boolean; changed: number }> {
  const existing = await tx.pipeline.findUnique({
    where: { organisationId_code: { organisationId, code: spec.code } },
    select: {
      id: true,
      name: true,
      packCode: true,
      stages: { select: { id: true, code: true, label: true, packCode: true } },
    },
  });

  if (!existing) {
    await tx.pipeline.create({
      data: {
        organisationId,
        entity: spec.entity ?? 'lead',
        code: spec.code,
        name: spec.name,
        isDefault: true,
        packCode,
        stages: {
          create: spec.stages.map((stage) => ({
            organisationId,
            code: stage.code,
            label: stage.label,
            sortOrder: stage.sortOrder,
            outcome: stage.outcome,
            systemValue: stage.systemValue ?? null,
            probability: stage.probability ?? null,
            packCode,
          })),
        },
      },
    });
    return { created: true, changed: 0 };
  }

  let changed = 0;

  if (existing.packCode && (existing.name !== spec.name || existing.packCode !== packCode)) {
    if (existing.name !== spec.name) changed++;
    await tx.pipeline.update({
      where: { id: existing.id },
      data: { name: spec.name, packCode },
    });
  }

  const byCode = new Map(existing.stages.map((stage) => [stage.code, stage]));
  for (const stage of spec.stages) {
    const current = byCode.get(stage.code);
    if (!current) {
      // This industry asks for a stage the tenant has never had.
      await tx.pipelineStage.create({
        data: {
          organisationId,
          pipelineId: existing.id,
          code: stage.code,
          label: stage.label,
          sortOrder: stage.sortOrder,
          outcome: stage.outcome,
          systemValue: stage.systemValue ?? null,
          probability: stage.probability ?? null,
          packCode,
        },
      });
      changed++;
      continue;
    }
    // Tenant-owned: their words, full stop.
    if (!current.packCode) continue;
    if (current.label === stage.label && current.packCode === packCode) continue;
    if (current.label !== stage.label) changed++;
    await tx.pipelineStage.update({
      where: { id: current.id },
      data: { label: stage.label, packCode },
    });
  }

  // Stages a previous pack seeded that this one does not ask for are left in
  // place. A lead may be sitting in one, and deleting a stage out from under an
  // operational record is never worth a tidier funnel.
  return { created: false, changed };
}

/** The settings bag as it stands, without taking the write lock. */
async function currentSettings(tx: Prisma.TransactionClient, organisationId: string) {
  const org = await tx.organisation.findUnique({
    where: { id: organisationId },
    select: { settings: true },
  });
  const raw = org?.settings;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
