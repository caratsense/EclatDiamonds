import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { getPack } from '../config/industry-packs/packs';
import { SYSTEM_PACK_CODE, convergePipeline } from '../config/industry-packs/provision';
import type { PackPipelineStage } from '../config/industry-packs/types';

/**
 * PipelinesService — tenant-configurable funnels (Phase A3).
 *
 * `LeadStage` is a closed three-value enum (inquiry / quotation / order_placed)
 * describing a jewellery sale. A pharmacy's funnel is not those three words, and
 * widening a Prisma enum per customer is a migration per customer.
 *
 * So a stage becomes a row. The typed column still exists and still holds a
 * legal enum value — `PipelineStage.systemValue` says which — and every existing
 * Eclat query, report and index keeps working untouched. A stage with no
 * `systemValue` leaves the enum column where it was and is authoritative for
 * display only. That is the honest boundary: reports that group by the enum keep
 * grouping by the enum, and nothing silently changes meaning.
 */

const OUTCOMES = ['open', 'won', 'lost'];

/** The default funnel: exactly the enum Eclat runs on today, made editable. */
const DEFAULT_STAGES: PackPipelineStage[] = [
  { code: 'inquiry', label: 'Inquiry', systemValue: 'inquiry', outcome: 'open', probability: 20, sortOrder: 1 },
  { code: 'quotation', label: 'Quotation', systemValue: 'quotation', outcome: 'open', probability: 50, sortOrder: 2 },
  { code: 'order_placed', label: 'Order placed', systemValue: 'order_placed', outcome: 'won', probability: 100, sortOrder: 3 },
];

@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, entity = 'lead') {
    return this.prisma.pipeline.findMany({
      where: { organisationId: user.organisationId, entity, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: {
        stages: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  /**
   * Create the starting funnel for a tenant. Idempotent — running it twice
   * returns the existing default rather than creating a second one, because
   * onboarding can legitimately be retried.
   *
   * ## Why this asks the tenant's industry first (MM2-04)
   *
   * It used to create `code: 'default'` named "Sales pipeline" with stages
   * Inquiry / Quotation / Order placed, unconditionally — and every industry
   * pack ships a funnel under that same code. So whichever ran first won for
   * ever: a clinic that hit this endpoint during onboarding before choosing an
   * industry was left permanently on jewellery-shaped English, because applying
   * the healthcare pack afterwards found `default` already there.
   *
   * Now there is one writer. With a pack applied, this materialises THAT pack's
   * funnel, stamped with its code. Without one, it creates the generic starter
   * stamped `_system` — the product's wording, not the tenant's — so a pack
   * applied later may re-word it, while anything the tenant has since edited
   * (which clears the stamp) may not. Both orderings land on the same funnel.
   */
  async ensureDefault(user: AuthUser, entity = 'lead') {
    const organisationId = user.organisationId;
    const existing = await this.prisma.pipeline.findFirst({
      where: { organisationId, entity, isDefault: true },
      include: { stages: { orderBy: { sortOrder: 'asc' } } },
    });
    if (existing) return { created: false as const, pipeline: existing };

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { industryPackCode: true },
    });
    const pack = getPack(organisation?.industryPackCode);
    const packPipeline = pack?.onboarding?.pipeline;

    // `entity` is honoured for a non-lead funnel; a pack only ever declares the
    // lead funnel, so anything else falls back to the generic starter.
    const usePack = !!packPipeline && entity === 'lead';
    const spec = usePack
      ? { ...packPipeline!, entity }
      : { code: 'default', name: 'Sales pipeline', stages: DEFAULT_STAGES, entity };
    const owner = usePack ? pack!.code : SYSTEM_PACK_CODE;

    const created = await this.prisma.$transaction(async (tx) => {
      await convergePipeline(tx, organisationId, spec, owner);
      return tx.pipeline.findUniqueOrThrow({
        where: { organisationId_code: { organisationId, code: spec.code } },
        include: { stages: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    await this.audit.record(user, {
      action: 'crm.pipeline_created',
      entityType: 'Pipeline',
      entityId: created.id,
      summary: `Created the default ${usePack ? pack!.name.toLowerCase() : 'sales'} pipeline`,
    });
    return { created: true as const, pipeline: created };
  }

  async createPipeline(
    user: AuthUser,
    input: { code: string; name: string; entity?: string; isDefault?: boolean },
  ) {
    const organisationId = user.organisationId;
    const duplicate = await this.prisma.pipeline.findUnique({
      where: { organisationId_code: { organisationId, code: input.code } },
      select: { id: true },
    });
    if (duplicate) throw new BadRequestException(`A pipeline with code "${input.code}" already exists.`);

    const pipeline = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.pipeline.updateMany({
          where: { organisationId, entity: input.entity ?? 'lead' },
          data: { isDefault: false },
        });
      }
      return tx.pipeline.create({
        data: {
          organisationId,
          entity: input.entity ?? 'lead',
          code: input.code,
          name: input.name,
          isDefault: input.isDefault ?? false,
        },
        include: { stages: true },
      });
    });
    await this.audit.record(user, {
      action: 'crm.pipeline_created',
      entityType: 'Pipeline',
      entityId: pipeline.id,
      summary: `Created pipeline "${input.name}"`,
    });
    return pipeline;
  }

  async upsertStage(
    user: AuthUser,
    pipelineId: string,
    input: {
      code: string;
      label: string;
      sortOrder?: number;
      outcome?: string;
      systemValue?: string;
      probability?: number;
    },
  ) {
    const organisationId = user.organisationId;
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: pipelineId, organisationId },
      select: { id: true, name: true },
    });
    if (!pipeline) throw new NotFoundException('Pipeline not found');

    if (input.outcome && !OUTCOMES.includes(input.outcome)) {
      throw new BadRequestException(`outcome must be one of: ${OUTCOMES.join(', ')}.`);
    }
    // Same guard as the taxonomy layer: a stage may only claim an enum value the
    // typed column genuinely accepts, or the lead will fail to save later.
    if (input.systemValue && !DEFAULT_STAGES.some((s) => s.systemValue === input.systemValue)) {
      throw new BadRequestException(
        `"${input.systemValue}" is not a value the lead stage column accepts ` +
          `(${DEFAULT_STAGES.map((s) => s.systemValue).join(', ')}). Leave it blank for a display-only stage.`,
      );
    }

    const data = {
      label: input.label,
      sortOrder: input.sortOrder ?? 0,
      outcome: input.outcome ?? 'open',
      systemValue: input.systemValue ?? null,
      probability: input.probability ?? null,
      // A human just decided what this stage says, so the pack no longer owns it.
      // Clearing the stamp is what makes "pack-owned" safe to overwrite later: it
      // can never mean "we may replace words somebody chose".
      packCode: null,
    };
    const stage = await this.prisma.pipelineStage.upsert({
      where: { pipelineId_code: { pipelineId, code: input.code } },
      create: { organisationId, pipelineId, code: input.code, ...data },
      update: data,
    });
    await this.audit.record(user, {
      action: 'crm.pipeline_stage_upserted',
      entityType: 'PipelineStage',
      entityId: stage.id,
      summary: `Stage "${input.label}" on ${pipeline.name}`,
    });
    return stage;
  }

  /** Deactivated, never deleted — leads that sat here keep a resolvable stage. */
  async deactivateStage(user: AuthUser, stageId: string) {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { id: stageId, organisationId: user.organisationId },
      select: { id: true, label: true },
    });
    if (!stage) throw new NotFoundException('Stage not found');
    const updated = await this.prisma.pipelineStage.update({
      where: { id: stageId },
      data: { isActive: false },
    });
    await this.audit.record(user, {
      action: 'crm.pipeline_stage_deactivated',
      entityType: 'PipelineStage',
      entityId: stageId,
      summary: `Retired stage "${stage.label}"`,
    });
    return updated;
  }
}
