import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { MessagingCampaignStatus, Prisma, Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { JobsService, JobContext } from '../jobs/jobs.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { IdentityService } from './identity.service';
import {
  MAX_CONDITIONS,
  SegmentDefinition,
  compileSegment,
  parseSegmentDefinition,
} from './audience-segment.dsl';

export const CAMPAIGN_EXPAND_JOB = 'campaign.expand';
export const CAMPAIGN_SEND_JOB = 'campaign.send';

/**
 * How many recipients one send job handles before re-enqueuing itself. Keeps a
 * single job inside the 15-minute worker lease no matter how large the audience,
 * and makes progress visible while a large campaign is still going out.
 */
const SEND_CHUNK = 100;

/** Hard ceiling on one campaign, per tenant. A runaway audience is a headline. */
const MAX_AUDIENCE = 50_000;

/** Rows returned to the preview screen. The COUNT beside them is uncapped. */
const PREVIEW_SAMPLE = 25;

type CampaignCounts = Record<string, number>;

/**
 * Statuses a campaign may be edited from. Once it is approved the audience is
 * frozen and the content is what a manager signed off on; changing either
 * afterwards would make the approval meaningless.
 */
const EDITABLE: MessagingCampaignStatus[] = ['draft', 'awaiting_approval'];

/** Statuses from which cancellation still prevents messages going out. */
const CANCELLABLE: MessagingCampaignStatus[] = [
  'draft',
  'awaiting_approval',
  'approved',
  'scheduled',
  'expanding',
  'queued',
  'sending',
];

@Injectable()
export class CampaignsService implements OnModuleInit {
  private readonly log = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
    @Inject(forwardRef(() => OmnichannelService))
    private readonly omnichannel: OmnichannelService,
  ) {}

  onModuleInit() {
    this.jobs.register(CAMPAIGN_EXPAND_JOB, (payload, ctx) => this.runExpansion(payload, ctx));
    this.jobs.register(CAMPAIGN_SEND_JOB, (payload, ctx) => this.runSend(payload, ctx));
  }

  // ==================================================== saved audiences

  async listSegments(user: AuthUser) {
    const rows = await this.prisma.audienceSegment.findMany({
      where: { organisationId: user.organisationId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      definition: r.definition,
      updatedAt: r.updatedAt,
    }));
  }

  async createSegment(
    user: AuthUser,
    input: { name: string; description?: string; definition: unknown },
  ) {
    this.assertManager(user, 'save an audience');
    const definition = parseSegmentDefinition(input.definition);
    try {
      const row = await this.prisma.audienceSegment.create({
        data: {
          organisationId: user.organisationId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          definition: definition as unknown as Prisma.InputJsonValue,
          createdById: user.id,
        },
      });
      await this.audit.record(user, {
        action: 'campaign.segment.created',
        entityType: 'AudienceSegment',
        entityId: row.id,
        summary: `Saved the audience "${row.name}".`,
      });
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('An audience with that name already exists.');
      }
      throw error;
    }
  }

  async updateSegment(
    user: AuthUser,
    id: string,
    input: { name?: string; description?: string; definition?: unknown },
  ) {
    this.assertManager(user, 'change an audience');
    const existing = await this.loadSegment(user, id);
    const definition =
      input.definition === undefined ? undefined : parseSegmentDefinition(input.definition);
    const row = await this.prisma.audienceSegment.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
        ...(definition ? { definition: definition as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    await this.audit.record(user, {
      action: 'campaign.segment.updated',
      entityType: 'AudienceSegment',
      entityId: row.id,
      summary: `Changed the audience "${row.name}".`,
    });
    return row;
  }

  async deleteSegment(user: AuthUser, id: string) {
    this.assertManager(user, 'delete an audience');
    const existing = await this.loadSegment(user, id);
    await this.prisma.audienceSegment.delete({ where: { id: existing.id } });
    await this.audit.record(user, {
      action: 'campaign.segment.deleted',
      entityType: 'AudienceSegment',
      entityId: existing.id,
      summary: `Deleted the audience "${existing.name}".`,
    });
    return { ok: true };
  }

  private async loadSegment(user: AuthUser, id: string) {
    const row = await this.prisma.audienceSegment.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!row) throw new NotFoundException('That audience does not exist.');
    return row;
  }

  // ==================================================== audience preview

  /**
   * The count is a real database aggregate over the whole audience, not the
   * length of the sample. A preview that says "25" because it fetched 25 rows is
   * how a manager approves a send to fifty thousand people believing it was
   * twenty-five.
   */
  async previewAudience(
    user: AuthUser,
    input: { definition?: unknown; segmentId?: string; storeIds?: string[] },
  ) {
    const definition = await this.resolveDefinition(user, input);
    const now = new Date();
    const compiled = compileSegment(definition, now);
    const where = this.tenantScope(user, compiled.where, input.storeIds);

    const [total, sample, contactable] = await Promise.all([
      this.prisma.party.count({ where }),
      this.prisma.party.findMany({
        where,
        take: PREVIEW_SAMPLE,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          phone: true,
          whatsapp: true,
          city: true,
          storeId: true,
          isBlacklisted: true,
        },
      }),
      // AND, never a spread. `where` already carries an OR that IS the store
      // scope for a branch-limited user; setting OR again by spreading would
      // replace it and quietly count every branch in the tenant.
      this.prisma.party.count({
        where: {
          AND: [where, { OR: [{ whatsapp: { not: null } }, { phone: { not: null } }] }],
        },
      }),
    ]);

    // Exclusions the audience itself cannot express, counted honestly and
    // separately so the reviewer sees why the sendable number is lower.
    const blocked = await this.prisma.party.count({
      where: { AND: [where, { isBlacklisted: true }] },
    });

    return {
      total,
      contactable,
      /**
       * Consent is NOT counted here. It is an event log where the latest event
       * wins, which a filter cannot express, and a number derived from "has ever
       * been granted" would overstate who may lawfully be messaged. The real
       * decision is made per recipient at send time; this screen says so rather
       * than showing a figure that would not survive contact with the policy.
       */
      consentCheckedAtSend: true,
      excluded: {
        noContactPoint: total - contactable,
        blocked,
      },
      reasons: compiled.reasons,
      sample: sample.map((p) => ({
        id: p.id,
        name: p.name,
        contact: maskContact(p.whatsapp ?? p.phone),
        city: p.city,
        storeId: p.storeId,
        blocked: p.isBlacklisted,
      })),
      sampleCapped: total > sample.length,
      evaluatedAt: now,
    };
  }

  private async resolveDefinition(
    user: AuthUser,
    input: { definition?: unknown; segmentId?: string },
  ): Promise<SegmentDefinition> {
    if (input.segmentId) {
      const saved = await this.loadSegment(user, input.segmentId);
      return parseSegmentDefinition(saved.definition);
    }
    if (input.definition === undefined) {
      throw new BadRequestException('Choose a saved audience or describe one.');
    }
    return parseSegmentDefinition(input.definition);
  }

  /**
   * The tenant filter, applied AFTER compilation and never from user input.
   * `storeIds` narrows further, and is intersected with the caller's own store
   * scope so a manager cannot preview another branch's customers by naming it.
   */
  private tenantScope(
    user: AuthUser,
    compiled: Prisma.PartyWhereInput,
    storeIds?: string[],
  ): Prisma.PartyWhereInput {
    const scope: Prisma.PartyWhereInput = {
      organisationId: user.organisationId,
      AND: [compiled],
    };
    const allowed = this.visibleStores(user, storeIds);
    if (allowed) {
      // A party with no branch is org-level and stays visible to anyone who can
      // see any branch — excluding it would silently drop head-office records.
      scope.OR = [{ storeId: { in: allowed } }, { storeId: null }];
    }
    return scope;
  }

  /** null = every store (org-wide role and no explicit narrowing). */
  private visibleStores(user: AuthUser, requested?: string[]): string[] | null {
    const orgWide = user.role === 'head_office' || user.role === 'area_manager';
    if (orgWide) {
      return requested?.length ? requested : null;
    }
    const own = user.storeIds ?? [];
    if (!requested?.length) return own;
    const intersection = requested.filter((s) => own.includes(s));
    if (!intersection.length) {
      throw new BadRequestException('You do not have access to the branches you chose.');
    }
    return intersection;
  }

  // ========================================================== campaigns

  async list(user: AuthUser, opts: { status?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Prisma.MessagingCampaignWhereInput = {
      organisationId: user.organisationId,
      ...(opts.status ? { status: opts.status as MessagingCampaignStatus } : {}),
    };
    const rows = await this.prisma.messagingCampaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const counts = await this.countsFor(
      user.organisationId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => this.present(r, counts[r.id] ?? {}));
  }

  async get(user: AuthUser, id: string) {
    const row = await this.loadCampaign(user, id);
    const counts = await this.countsFor(user.organisationId, [row.id]);
    return this.present(row, counts[row.id] ?? {});
  }

  /**
   * Delivery figures, grouped in the database rather than counted in memory.
   * One query covers every campaign on the list screen.
   */
  private async countsFor(
    organisationId: string,
    campaignIds: string[],
  ): Promise<Record<string, CampaignCounts>> {
    if (!campaignIds.length) return {};
    const grouped = await this.prisma.campaignRecipient.groupBy({
      by: ['campaignId', 'status'],
      where: { organisationId, campaignId: { in: campaignIds } },
      _count: { _all: true },
    });
    const out: Record<string, CampaignCounts> = {};
    for (const g of grouped) {
      (out[g.campaignId] ??= {})[g.status] = g._count._all;
    }
    return out;
  }

  private present(row: Prisma.MessagingCampaignGetPayload<object>, counts: CampaignCounts) {
    const sum = (...keys: string[]) => keys.reduce((n, k) => n + (counts[k] ?? 0), 0);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      channel: row.channel,
      status: row.status,
      segmentId: row.segmentId,
      templateName: row.templateName,
      templateLanguage: row.templateLanguage,
      bodyPreview: row.bodyPreview,
      storeIds: row.storeIds,
      scheduledAt: row.scheduledAt,
      approvedAt: row.approvedAt,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      expandedAt: row.expandedAt,
      finishedAt: row.finishedAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      counts: {
        targeted: sum('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'dead'),
        excluded: sum('excluded'),
        pending: sum('pending'),
        queued: sum('queued'),
        sent: sum('sent'),
        delivered: sum('delivered'),
        read: sum('read'),
        failed: sum('failed'),
        dead: sum('dead'),
        cancelled: sum('cancelled'),
      },
    };
  }

  async create(
    user: AuthUser,
    input: {
      name: string;
      description?: string;
      channel?: string;
      segmentId?: string;
      definition?: unknown;
      templateName?: string;
      templateLanguage?: string;
      bodyPreview?: string;
      storeIds?: string[];
      scheduledAt?: string;
      marketingCampaignId?: string;
    },
  ) {
    this.assertManager(user, 'create a campaign');
    const channel = (input.channel ?? 'whatsapp').trim();
    if (channel !== 'whatsapp') {
      // Adapter contracts for email/SMS/RCS exist and are fixture-tested. A
      // campaign is not allowed to be CREATED on a channel that cannot actually
      // deliver, because a scheduled campaign that silently never sends is worse
      // than one that was refused.
      throw new BadRequestException(
        `The ${channel} channel has no live provider yet. Only WhatsApp campaigns can be sent.`,
      );
    }
    if (input.segmentId) await this.loadSegment(user, input.segmentId);
    const definition =
      input.definition === undefined ? undefined : parseSegmentDefinition(input.definition);
    if (!input.segmentId && !definition) {
      throw new BadRequestException('Choose a saved audience or describe one.');
    }

    const row = await this.prisma.messagingCampaign.create({
      data: {
        organisationId: user.organisationId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        channel,
        segmentId: input.segmentId ?? null,
        audienceSnapshot: definition
          ? (definition as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        templateName: input.templateName?.trim() || null,
        templateLanguage: input.templateLanguage?.trim() || null,
        bodyPreview: input.bodyPreview?.trim() || null,
        storeIds: this.visibleStores(user, input.storeIds) ?? [],
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        marketingCampaignId: input.marketingCampaignId ?? null,
        createdById: user.id,
      },
    });
    await this.audit.record(user, {
      action: 'campaign.created',
      entityType: 'MessagingCampaign',
      entityId: row.id,
      summary: `Created the campaign "${row.name}".`,
    });
    return this.present(row, {});
  }

  async update(user: AuthUser, id: string, input: Record<string, unknown>) {
    this.assertManager(user, 'change a campaign');
    const row = await this.loadCampaign(user, id);
    if (!EDITABLE.includes(row.status)) {
      throw new ConflictException(
        `A campaign that is ${row.status.replace('_', ' ')} can no longer be edited.`,
      );
    }
    const data: Prisma.MessagingCampaignUpdateInput = {};
    if (typeof input.name === 'string') data.name = input.name.trim();
    if (typeof input.description === 'string') data.description = input.description.trim() || null;
    if (typeof input.templateName === 'string') data.templateName = input.templateName.trim() || null;
    if (typeof input.templateLanguage === 'string') {
      data.templateLanguage = input.templateLanguage.trim() || null;
    }
    if (typeof input.bodyPreview === 'string') data.bodyPreview = input.bodyPreview.trim() || null;
    if (typeof input.scheduledAt === 'string') data.scheduledAt = new Date(input.scheduledAt);
    if (input.scheduledAt === null) data.scheduledAt = null;
    if (Array.isArray(input.storeIds)) {
      data.storeIds = this.visibleStores(user, input.storeIds as string[]) ?? [];
    }
    if (input.definition !== undefined) {
      data.audienceSnapshot = parseSegmentDefinition(
        input.definition,
      ) as unknown as Prisma.InputJsonValue;
    }
    if (typeof input.segmentId === 'string') {
      await this.loadSegment(user, input.segmentId);
      data.segment = { connect: { id: input.segmentId } };
    }

    const updated = await this.prisma.messagingCampaign.update({ where: { id: row.id }, data });
    await this.audit.record(user, {
      action: 'campaign.updated',
      entityType: 'MessagingCampaign',
      entityId: row.id,
      summary: `Changed the campaign "${updated.name}".`,
    });
    return this.present(updated, {});
  }

  async submit(user: AuthUser, id: string) {
    const row = await this.loadCampaign(user, id);
    if (row.status !== 'draft') {
      throw new ConflictException('Only a draft can be sent for approval.');
    }
    this.assertSendable(row);
    const updated = await this.prisma.messagingCampaign.update({
      where: { id: row.id },
      data: { status: 'awaiting_approval' },
    });
    await this.audit.record(user, {
      action: 'campaign.submitted',
      entityType: 'MessagingCampaign',
      entityId: row.id,
      summary: `Sent "${row.name}" for approval.`,
    });
    return this.present(updated, {});
  }

  /**
   * Approval is the moment the audience stops being a live query.
   *
   * The definition is frozen into `audienceSnapshot` here, and expansion reads
   * only that. Without this, editing a saved segment after approval would
   * silently change who a scheduled campaign reaches — the approver signed off
   * on a number, and that number has to still mean something at send time.
   */
  async approve(user: AuthUser, id: string) {
    this.assertApprover(user);
    const row = await this.loadCampaign(user, id);
    if (row.status !== 'awaiting_approval') {
      throw new ConflictException('Only a campaign awaiting approval can be approved.');
    }
    this.assertSendable(row);

    const definition = await this.resolveDefinition(user, {
      segmentId: row.segmentId ?? undefined,
      definition: row.audienceSnapshot ?? undefined,
    });

    const asset = await this.resolveTemplateAsset(user, row);

    const updated = await this.prisma.messagingCampaign.update({
      where: { id: row.id },
      data: {
        status: row.scheduledAt && row.scheduledAt > new Date() ? 'scheduled' : 'approved',
        approvedById: user.id,
        approvedAt: new Date(),
        audienceSnapshot: definition as unknown as Prisma.InputJsonValue,
        templateAssetId: asset.id,
        providerSnapshot: {
          providerCode: 'whatsapp_cloud',
          templateKey: `${row.templateName}:${row.templateLanguage}`,
          assetId: asset.id,
          approvedAt: new Date().toISOString(),
        },
      },
    });

    await this.audit.record(user, {
      action: 'campaign.approved',
      entityType: 'MessagingCampaign',
      entityId: row.id,
      summary: `Approved the campaign "${row.name}".`,
    });

    await this.jobs.enqueue({
      kind: CAMPAIGN_EXPAND_JOB,
      organisationId: user.organisationId,
      payload: { campaignId: row.id },
      // Tenant in the key: uniqueness is table-wide.
      idempotencyKey: `campaign-expand:${user.organisationId}:${row.id}`,
      runAt: row.scheduledAt && row.scheduledAt > new Date() ? row.scheduledAt : undefined,
      createdById: user.id,
    });

    return this.present(updated, {});
  }

  async cancel(user: AuthUser, id: string, reason?: string) {
    this.assertManager(user, 'cancel a campaign');
    const row = await this.loadCampaign(user, id);
    if (!CANCELLABLE.includes(row.status)) {
      throw new ConflictException(`A campaign that is ${row.status} can no longer be cancelled.`);
    }

    // Order matters. Recipients are marked first so that a send job already
    // running finds nothing left to send: it re-reads status per chunk, and a
    // 'cancelled' row is skipped. Flipping the campaign first would leave a
    // window where the job is still walking a list of 'pending' rows.
    const [stopped] = await this.prisma.$transaction([
      this.prisma.campaignRecipient.updateMany({
        where: { organisationId: user.organisationId, campaignId: row.id, status: 'pending' },
        data: { status: 'cancelled', exclusionReason: 'campaign_cancelled' },
      }),
      this.prisma.messagingCampaign.update({
        where: { id: row.id },
        data: {
          status: 'cancelled',
          cancelledById: user.id,
          cancelledAt: new Date(),
          cancelReason: reason?.trim() || null,
          finishedAt: new Date(),
        },
      }),
    ]);

    await this.audit.record(user, {
      action: 'campaign.cancelled',
      entityType: 'MessagingCampaign',
      entityId: row.id,
      summary: `Cancelled "${row.name}"; ${stopped.count} unsent recipients stopped.`,
    });
    return this.get(user, row.id);
  }

  /**
   * Recipients, paginated. Failures first: on a campaign of forty thousand, the
   * rows a human needs are the ones that did not arrive.
   */
  async recipients(
    user: AuthUser,
    id: string,
    opts: { status?: string; cursor?: string; limit?: number } = {},
  ) {
    const row = await this.loadCampaign(user, id);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.campaignRecipient.findMany({
      where: {
        organisationId: user.organisationId,
        campaignId: row.id,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        partyId: r.partyId,
        contact: maskContact(r.contactValue),
        status: r.status,
        exclusionReason: r.exclusionReason,
        lastError: r.lastError,
        sentAt: r.sentAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]?.id : null,
    };
  }

  /**
   * Retry the ones that failed transiently. Deliberately NOT offered for 'dead'
   * or 'excluded': dead exhausted its attempts and needs a human to look at why,
   * and excluded means consent or policy said no — retrying that would be a
   * deliberate attempt to message someone who declined.
   */
  async retryFailed(user: AuthUser, id: string) {
    this.assertManager(user, 'retry a campaign');
    const row = await this.loadCampaign(user, id);
    const reset = await this.prisma.campaignRecipient.updateMany({
      where: { organisationId: user.organisationId, campaignId: row.id, status: 'failed' },
      data: { status: 'pending', lastError: null },
    });
    if (reset.count) {
      await this.prisma.messagingCampaign.update({
        where: { id: row.id },
        data: { status: 'sending', finishedAt: null },
      });
      await this.enqueueSend(user.organisationId, row.id, user.id);
    }
    await this.audit.record(user, {
      action: 'campaign.retried',
      entityType: 'MessagingCampaign',
      entityId: row.id,
      summary: `Retried ${reset.count} failed recipients on "${row.name}".`,
    });
    return { retried: reset.count };
  }

  // ============================================================== jobs

  private async enqueueSend(organisationId: string, campaignId: string, createdById?: string) {
    // No idempotency key: a send job re-enqueues itself per chunk, and a key
    // would make the second chunk a no-op. Duplicate execution is safe because
    // each recipient row is claimed with a conditional update.
    await this.jobs.enqueue({
      kind: CAMPAIGN_SEND_JOB,
      organisationId,
      payload: { campaignId },
      createdById,
    });
  }

  /**
   * Turn the frozen audience into recipient rows. Idempotent by construction:
   * `@@unique([campaignId, contactValue])` means a retried expansion inserts
   * nothing new, and `skipDuplicates` makes that silent rather than fatal.
   */
  private async runExpansion(payload: unknown, ctx: JobContext) {
    const campaignId = (payload as { campaignId?: string })?.campaignId;
    if (!campaignId || !ctx.organisationId) {
      throw new Error('campaign.expand needs a campaignId and a tenant.');
    }
    const campaign = await this.prisma.messagingCampaign.findFirst({
      where: { id: campaignId, organisationId: ctx.organisationId },
    });
    if (!campaign) throw new Error(`Campaign ${campaignId} no longer exists.`);
    if (campaign.status === 'cancelled') {
      return { skipped: 'cancelled' };
    }
    if (campaign.expandedAt) {
      await this.enqueueSend(ctx.organisationId, campaign.id);
      return { skipped: 'already_expanded' };
    }

    await this.prisma.messagingCampaign.update({
      where: { id: campaign.id },
      data: { status: 'expanding' },
    });

    const definition = parseSegmentDefinition(campaign.audienceSnapshot);
    const compiled = compileSegment(definition, new Date());
    const where: Prisma.PartyWhereInput = {
      organisationId: ctx.organisationId,
      AND: [
        compiled.where,
        ...(campaign.storeIds.length
          ? [{ OR: [{ storeId: { in: campaign.storeIds } }, { storeId: null }] }]
          : []),
      ],
    };

    const total = await this.prisma.party.count({ where });
    if (total > MAX_AUDIENCE) {
      await this.prisma.messagingCampaign.update({
        where: { id: campaign.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          lastError: `Audience of ${total} exceeds the ${MAX_AUDIENCE} ceiling for one campaign.`,
        },
      });
      return { failed: 'audience_too_large', total };
    }

    const org = await this.prisma.organisation.findUnique({
      where: { id: ctx.organisationId },
      select: { country: true },
    });
    const country = org?.country ?? 'IN';

    let cursor: string | undefined;
    let created = 0;
    let excluded = 0;
    for (;;) {
      const batch = await this.prisma.party.findMany({
        where,
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, whatsapp: true, phone: true, isBlacklisted: true },
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;

      const rows: Prisma.CampaignRecipientCreateManyInput[] = [];
      for (const p of batch) {
        const normalized = this.identity.normalize('whatsapp', p.whatsapp ?? p.phone ?? '', country);
        if (!normalized) {
          excluded += 1;
          continue; // nothing to key a recipient row on
        }
        const blocked = p.isBlacklisted;
        if (blocked) excluded += 1;
        rows.push({
          organisationId: ctx.organisationId,
          campaignId: campaign.id,
          partyId: p.id,
          contactValue: normalized,
          status: blocked ? 'excluded' : 'pending',
          exclusionReason: blocked ? 'blocked_customer' : null,
        });
      }
      if (rows.length) {
        const res = await this.prisma.campaignRecipient.createMany({
          data: rows,
          skipDuplicates: true,
        });
        created += res.count;
      }
    }

    await this.prisma.messagingCampaign.update({
      where: { id: campaign.id },
      data: { status: 'queued', expandedAt: new Date() },
    });
    await this.audit.recordSystem(ctx.organisationId, 'campaign_expansion', {
      action: 'campaign.expanded',
      entityType: 'MessagingCampaign',
      entityId: campaign.id,
      summary: `Expanded "${campaign.name}" to ${created} recipients; ${excluded} excluded.`,
    });
    await this.enqueueSend(ctx.organisationId, campaign.id);
    return { created, excluded };
  }

  /**
   * Send one chunk, then re-enqueue if there is more.
   *
   * Every message goes through OmnichannelService.queueToContact, which is the
   * single chokepoint enforcing consent, the 24-hour window, approved templates
   * and the outbox. This service never touches a provider, which is why a
   * campaign cannot become a way around the messaging policy.
   */
  private async runSend(payload: unknown, ctx: JobContext) {
    const campaignId = (payload as { campaignId?: string })?.campaignId;
    if (!campaignId || !ctx.organisationId) {
      throw new Error('campaign.send needs a campaignId and a tenant.');
    }
    const campaign = await this.prisma.messagingCampaign.findFirst({
      where: { id: campaignId, organisationId: ctx.organisationId },
    });
    if (!campaign) throw new Error(`Campaign ${campaignId} no longer exists.`);
    if (campaign.status === 'cancelled') return { skipped: 'cancelled' };
    if (!campaign.templateName || !campaign.templateLanguage) {
      throw new Error('A campaign without an approved template cannot send.');
    }

    if (campaign.status !== 'sending') {
      await this.prisma.messagingCampaign.update({
        where: { id: campaign.id },
        data: { status: 'sending' },
      });
    }

    const batch = await this.prisma.campaignRecipient.findMany({
      where: { organisationId: ctx.organisationId, campaignId: campaign.id, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: SEND_CHUNK,
    });

    if (!batch.length) return this.finish(ctx.organisationId, campaign.id);

    // The campaign runs as the approver. Sending as nobody would bypass store
    // scope inside queueToContact; sending as the creator would let an
    // unapproved author's scope decide what an approver signed off on.
    const actor = await this.actorFor(ctx.organisationId, campaign.approvedById ?? campaign.createdById);

    for (const recipient of batch) {
      // Claim the row first. Two workers on the same campaign then cannot both
      // send to the same person: the loser's updateMany matches nothing.
      const claimed = await this.prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, status: 'pending' },
        data: { status: 'queued', queuedAt: new Date(), attempts: { increment: 1 } },
      });
      if (!claimed.count) continue;

      try {
        const message = await this.omnichannel.queueToContact(actor, {
          to: recipient.contactValue,
          purpose: 'marketing',
          templateName: campaign.templateName,
          languageCode: campaign.templateLanguage,
          idempotencyKey: `campaign:${campaign.id}:${recipient.id}`,
        });
        await this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            messageId: (message as { id?: string })?.id ?? null,
            lastError: null,
          },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        // A policy refusal is not a failure to retry — consent was withdrawn, or
        // the window closed. Recording it as 'excluded' is the difference
        // between an honest report and one that hides a refusal as an outage.
        const isPolicy = /consent|window|opted out|template|blocked/i.test(reason);
        await this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: isPolicy ? 'excluded' : recipient.attempts >= 2 ? 'dead' : 'failed',
            exclusionReason: isPolicy ? 'policy_refused_at_send' : null,
            lastError: reason.slice(0, 500),
          },
        });
      }
    }

    await this.enqueueSend(ctx.organisationId, campaign.id);
    return { processed: batch.length };
  }

  private async finish(organisationId: string, campaignId: string) {
    const grouped = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { organisationId, campaignId },
      _count: { _all: true },
    });
    const counts: CampaignCounts = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const bad = (counts.failed ?? 0) + (counts.dead ?? 0);
    const good = (counts.sent ?? 0) + (counts.delivered ?? 0) + (counts.read ?? 0);
    const status: MessagingCampaignStatus =
      bad === 0 ? 'completed' : good === 0 ? 'failed' : 'partially_failed';
    await this.prisma.messagingCampaign.update({
      where: { id: campaignId },
      data: { status, finishedAt: new Date() },
    });
    return { status, counts };
  }

  /**
   * Rebuild an AuthUser for the approver so the send inherits their real store
   * scope from the database, not from anything stored on the campaign.
   */
  private async actorFor(organisationId: string, userId: string | null): Promise<AuthUser> {
    if (!userId) throw new Error('A campaign with no approver and no creator cannot send.');
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organisationId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        organisationId: true,
        userStores: { select: { storeId: true } },
      },
    });
    if (!user) throw new Error('The user who approved this campaign no longer exists.');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organisationId: user.organisationId,
      storeIds: user.userStores.map((s) => s.storeId),
    } as AuthUser;
  }

  // ============================================================= helpers

  private async loadCampaign(user: AuthUser, id: string) {
    const row = await this.prisma.messagingCampaign.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!row) throw new NotFoundException('That campaign does not exist.');
    return row;
  }

  private assertSendable(row: { templateName: string | null; templateLanguage: string | null }) {
    if (!row.templateName || !row.templateLanguage) {
      throw new BadRequestException(
        'A WhatsApp campaign needs an approved template name and its language, for example en_US.',
      );
    }
  }

  /**
   * The template must exist for THIS tenant. Whether it may be sent is
   * loadApprovedTemplate's decision inside the outbox — the provider's verdict
   * and its age — and is deliberately not re-implemented here.
   */
  private async resolveTemplateAsset(
    user: AuthUser,
    row: { templateName: string | null; templateLanguage: string | null },
  ) {
    const key = `${row.templateName}:${row.templateLanguage}`;
    const asset = await this.prisma.integrationAsset.findFirst({
      where: {
        organisationId: user.organisationId,
        kind: 'whatsapp_template',
        externalId: key,
        integration: { providerCode: 'whatsapp_cloud' },
      },
      select: { id: true },
    });
    if (!asset) {
      throw new BadRequestException(
        'That template is not registered for this tenant in that language. Synchronise templates first.',
      );
    }
    return asset;
  }

  private assertManager(user: AuthUser, what: string) {
    const allowed: Role[] = ['head_office', 'area_manager', 'store_manager'];
    if (!allowed.includes(user.role)) {
      throw new BadRequestException(`You do not have permission to ${what}.`);
    }
  }

  /**
   * Approval is deliberately narrower than creation. A store manager may draft a
   * campaign for their branch; releasing it to customers is a head-office act.
   */
  private assertApprover(user: AuthUser) {
    const allowed: Role[] = ['head_office', 'area_manager'];
    if (!allowed.includes(user.role)) {
      throw new BadRequestException(
        'Only head office or an area manager can approve a campaign.',
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

/** Last four digits only. A campaign report is read by people who do not need the number. */
function maskContact(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return `••••${trimmed.slice(-4)}`;
}

export { MAX_CONDITIONS };
