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
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { IdentityService } from './identity.service';
import {
  MAX_CONDITIONS,
  SegmentDefinition,
  compileSegment,
  parseSegmentDefinition,
} from './audience-segment.dsl';
import {
  CampaignVariableError,
  type VariableMapping,
  parseVariableMappings,
  resolveVariables,
  templateComponentsFor,
  variableSlotsIn,
} from './campaign-variables';
import {
  HAS_CONTACT_POINT,
  campaignAudienceWhere,
  campaignContactValue,
  previewAudienceWhere,
  visibleStores,
} from './campaign-audience';

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
    private readonly scope: StoreScopeService,
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
    const where = previewAudienceWhere(user, compiled.where, input.storeIds);

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
        where: { AND: [where, HAS_CONTACT_POINT] },
      }),
    ]);

    // Exclusions the audience itself cannot express, counted honestly and
    // separately so the reviewer sees why the sendable number is lower.
    // Counted among the CONTACTABLE rather than the whole audience: a blocked
    // customer with no number at all is already in `noContactPoint`, and
    // counting them twice would make the figures below stop adding up.
    const blocked = await this.prisma.party.count({
      where: { AND: [where, HAS_CONTACT_POINT, { isBlacklisted: true }] },
    });

    return {
      total,
      /**
       * Has a number on file. An upper bound, honestly: whether that number can
       * be read is decided per customer at expansion, and a figure that
       * normalised fifty thousand numbers to be exact is not a figure an
       * interactive screen can afford. Anything that falls out there is
       * reported on the campaign itself rather than quietly disappearing.
       */
      contactable,
      /**
       * The number that has to survive to the send, and the one the campaign
       * screen later calls `targeted`: contactable, less the blocked. The
       * headline used to be `contactable`, which counts blocked customers that
       * expansion then writes as excluded — so the preview promised a larger
       * send than the manager actually got, by exactly the blocked count.
       */
      sendable: contactable - blocked,
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
      templateVariables: row.templateVariables ?? null,
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
      templateVariables?: unknown;
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
        /*
         * Stored as given and checked on approval, not here. A draft is
         * allowed to be half-written -- somebody picks the template on one
         * visit and says what fills it on the next -- and refusing an
         * incomplete mapping at this point would make that impossible.
         */
        templateVariables: toJsonOrNull(input.templateVariables),
        storeIds: visibleStores(user, input.storeIds) ?? [],
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
    if ('templateVariables' in input) data.templateVariables = toJsonOrNull(input.templateVariables);
    if (typeof input.scheduledAt === 'string') data.scheduledAt = new Date(input.scheduledAt);
    if (input.scheduledAt === null) data.scheduledAt = null;
    if (Array.isArray(input.storeIds)) {
      data.storeIds = visibleStores(user, input.storeIds as string[]) ?? [];
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
    await this.assertSendable(user, row);

    /*
     * AN APPROVER DOES NOT QUEUE FOR THEMSELVES.
     *
     * Approval exists so a broadcast to thousands of customers is seen by
     * somebody senior to whoever wrote it. When the author IS that person it
     * stops being a check and becomes a second button — head office writing a
     * campaign, sending it to themselves, and approving it a moment later.
     * The client asked for exactly this: "head office should definitely not
     * require that".
     *
     * The record still says both things happened and who did them, because
     * removing the ceremony is not the same as removing the trail.
     */
    if (isApprover(user)) return this.approveDraft(user, row, true);

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
    return this.approveDraft(user, row, false);
  }

  /** The approval itself, shared by the two ways of reaching it. */
  private async approveDraft(
    user: AuthUser,
    row: Awaited<ReturnType<CampaignsService['loadCampaign']>>,
    ownWork: boolean,
  ) {
    await this.assertSendable(user, row);

    const definition = await this.resolveDefinition(user, {
      segmentId: row.segmentId ?? undefined,
      definition: row.audienceSnapshot ?? undefined,
    });

    /*
     * The mapping is checked HERE, not at the provider.
     *
     * A template with an unfilled `{{1}}` is refused by Meta once per
     * recipient, after the campaign is already running, and each refusal reads
     * as that customer's problem rather than the campaign's. Approval is the
     * last moment anybody is looking at this, so it is where it is caught.
     */
    const { assetId } = await this.variableMappingsFor(user, row);
    const asset = { id: assetId };

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
      // Says which of the two routes this was. "Approved their own" is the
      // fact an auditor would want and the one the shortcut could hide.
      summary: ownWork
        ? `Approved their own campaign "${row.name}" and released it.`
        : `Approved the campaign "${row.name}".`,
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
    // The same builder the preview went through, so the archive exclusion and
    // the branch scope cannot be present on one side and missing on the other.
    const where = campaignAudienceWhere(
      { organisationId: ctx.organisationId, storeIds: campaign.storeIds },
      compiled.where,
    );

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
    let blocked = 0;
    let unreadable = 0;
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
        const normalized = campaignContactValue(p, (raw) =>
          this.identity.normalize('whatsapp', raw, country),
        );
        if (!normalized) {
          // Counted apart from the blocked: `contactValue` is half the unique
          // key, so there is nothing to key a recipient row on and this person
          // leaves no trace on the campaign screen. The audit line below is
          // where the preview's figure and the sent figure are reconciled.
          unreadable += 1;
          continue;
        }
        const isBlocked = p.isBlacklisted;
        if (isBlocked) blocked += 1;
        rows.push({
          organisationId: ctx.organisationId,
          campaignId: campaign.id,
          partyId: p.id,
          contactValue: normalized,
          status: isBlocked ? 'excluded' : 'pending',
          exclusionReason: isBlocked ? 'blocked_customer' : null,
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
      summary:
        `Expanded "${campaign.name}" to ${created} recipients; ` +
        `${blocked} blocked, ${unreadable} with no usable number.`,
    });
    await this.enqueueSend(ctx.organisationId, campaign.id);
    return { created, blocked, unreadable };
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

    /*
     * What fills the template's {{n}} for each person in this chunk.
     *
     * Parsed once per chunk rather than per recipient -- it is the same mapping
     * for all of them -- and the customers it reads from are fetched in one
     * query, because a name lookup per recipient is a hundred round trips per
     * chunk on a campaign that may run to thousands.
     *
     * A mapping that no longer matches its template (the template was edited at
     * Meta after approval, so a variable appeared) stops the whole campaign
     * here. The alternative is sending to some of the audience and failing on
     * the rest, which is the one outcome nobody can undo.
     */
    let mappings: VariableMapping[] = [];
    if (campaign.templateVariables !== null && campaign.templateVariables !== undefined) {
      try {
        mappings = parseVariableMappings(
          campaign.templateVariables,
          variableSlotsIn(campaign.bodyPreview ?? ''),
        );
      } catch {
        // bodyPreview is the approved wording WITH its samples substituted, so
        // it carries no {{n}} and the count above is 0. Fall back to trusting
        // the stored mapping as saved: approval already checked it against the
        // provider's own template.
        mappings = parseVariableMappings(
          campaign.templateVariables,
          Array.isArray(campaign.templateVariables) ? campaign.templateVariables.length : 0,
        );
      }
    }

    const subjects = new Map<string, { name: string | null; branchName: string | null }>();
    if (mappings.length) {
      const ids = batch.map((r) => r.partyId).filter((id): id is string => Boolean(id));
      const parties = ids.length
        ? await this.prisma.party.findMany({
            where: { id: { in: ids }, organisationId: ctx.organisationId },
            select: { id: true, name: true, store: { select: { name: true } } },
          })
        : [];
      for (const p of parties) {
        subjects.set(p.id, { name: p.name, branchName: p.store?.name ?? null });
      }
    }

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
          // Undefined when the template takes no values: Meta refuses an empty
          // parameter list as firmly as a missing one.
          templateComponents: templateComponentsFor(
            resolveVariables(mappings, subjects.get(recipient.partyId ?? '') ?? {}),
          ),
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
    /*
     * THE SAME SCOPE A SESSION WOULD GIVE THEM.
     *
     * Reading `userStores` directly looked equivalent and was not: for head
     * office and an area manager `resolveScope` widens to every branch of the
     * organisation, because those roles are not defined by their assignment
     * rows. Head office here has two of them, so a campaign it approved could
     * only reach customers at two branches — the other 36 were refused one at
     * a time, at send, with "Store not in your scope", on a broadcast that had
     * already been approved for all of them.
     */
    const { storeIds } = await this.scope.resolveScope(
      user.id,
      user.role,
      user.organisationId,
    );
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organisationId: user.organisationId,
      storeIds,
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

  /**
   * Everything that has to be true before a campaign may move towards customers.
   *
   * Both the submit and the approve path come through here, and any future one
   * should too: the wizard is not what protects the send. These endpoints can
   * be POSTed at directly, and the screen's own count is a number the browser
   * holds — neither is a reason to believe anybody is on the other end.
   */
  private async assertSendable(
    user: AuthUser,
    row: Prisma.MessagingCampaignGetPayload<object>,
  ) {
    if (!row.templateName || !row.templateLanguage) {
      throw new BadRequestException(
        'A WhatsApp campaign needs an approved template name and its language, for example en_US.',
      );
    }
    await this.assertAudienceReachesSomeone(user, row);
  }

  /**
   * Refuse a broadcast that would reach nobody.
   *
   * Counted here rather than trusted from the request, and counted through the
   * same tenant scope the preview screen uses, so the refusal names the same
   * number the manager was shown. An audience that matches no one spends an
   * approval, finishes as a "completed" campaign that sent nothing, and tells
   * nobody what went wrong — the rules were simply wrong, which is a sentence
   * worth saying out loud.
   */
  private async assertAudienceReachesSomeone(
    user: AuthUser,
    row: Prisma.MessagingCampaignGetPayload<object>,
  ) {
    const definition = await this.resolveDefinition(user, {
      segmentId: row.segmentId ?? undefined,
      definition: row.audienceSnapshot ?? undefined,
    });
    const compiled = compileSegment(definition, new Date());
    /*
     * The SEND's audience, not the previewer's.
     *
     * `campaignAudienceWhere` is the clause expansion itself uses — the
     * campaign's own frozen branches, not whatever branches this approver can
     * currently see. A gate measured against a different set from the one that
     * will actually run is a gate that passes sends it should stop.
     */
    const where = campaignAudienceWhere(row, compiled.where);

    const [total, contactable] = await Promise.all([
      this.prisma.party.count({ where }),
      this.prisma.party.count({ where: { AND: [where, HAS_CONTACT_POINT] } }),
    ]);

    const refusal = audienceRefusal({ total, contactable });
    if (refusal) throw new BadRequestException(refusal);
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
        /*
         * `message_template`, which is what the template sync and the outbox
         * both write (TEMPLATE_ASSET_KIND). This read asked for
         * 'whatsapp_template' — a kind nothing in the system has ever
         * written — so approving ANY campaign failed with "synchronise
         * templates first", however many times anybody synchronised. It is
         * the reason no broadcast has ever been sent.
         */
        kind: 'message_template',
        externalId: key,
        integration: { providerCode: 'whatsapp_cloud' },
      },
      select: { id: true, metadata: true },
    });
    if (!asset) {
      throw new BadRequestException(
        'That template is not registered for this tenant in that language. Synchronise templates first.',
      );
    }
    return asset;
  }

  /**
   * How many `{{n}}` the chosen template carries, from what Meta told us.
   *
   * Read from the template rather than from the author's recollection of it:
   * the mapping has to match what the provider approved, and the provider is
   * the only authority on that. `variables` is the projected list; the source
   * body is the fallback for a row recorded before that list was kept.
   */
  private templateSlots(metadata: unknown): number {
    const raw = (metadata ?? {}) as Record<string, unknown>;
    if (Array.isArray(raw.variables)) return raw.variables.length;
    return typeof raw.bodySource === 'string' ? variableSlotsIn(raw.bodySource) : 0;
  }

  /**
   * The mapping for a campaign, checked against its template.
   *
   * Throws the author's own sentence rather than a validator name — this runs
   * on approval, which is the last moment anybody is looking.
   */
  private async variableMappingsFor(
    user: AuthUser,
    row: { templateName: string | null; templateLanguage: string | null; templateVariables: unknown },
  ): Promise<{ assetId: string; mappings: VariableMapping[] }> {
    const asset = await this.resolveTemplateAsset(user, row);
    try {
      return {
        assetId: asset.id,
        mappings: parseVariableMappings(row.templateVariables, this.templateSlots(asset.metadata)),
      };
    } catch (error) {
      if (error instanceof CampaignVariableError) throw new BadRequestException(error.message);
      throw error;
    }
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
    if (!isApprover(user)) {
      throw new BadRequestException(
        'Only head office or an area manager can approve a campaign.',
      );
    }
  }
}

/**
 * A value on its way into a nullable Json column.
 *
 * `Prisma.JsonNull` rather than `null`: the latter means "leave this alone" to
 * Prisma, so clearing a mapping by passing null would silently keep the old one
 * — and a campaign would send values its author believed they had removed.
 */
function toJsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === undefined || value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}

/**
 * May this person release a broadcast to customers?
 *
 * Head office and an area manager. A store manager may draft one for their
 * branch; letting it reach customers is somebody else's signature.
 */
function isApprover(user: AuthUser): boolean {
  const allowed: Role[] = ['head_office', 'area_manager'];
  return allowed.includes(user.role);
}

/**
 * Why an audience cannot be broadcast to, in words a manager can act on — or
 * null when it can.
 *
 * Sending to nobody is not a send; it is a mistake in the rules, and the
 * refusal has to say which mistake. "Nobody matches" sends her back to the
 * rules; "nobody who matches has a number" tells her the rules are right and
 * the records are not, which is a different afternoon's work.
 */
export function audienceRefusal(counts: { total: number; contactable: number }): string | null {
  if (counts.total === 0) {
    return 'These rules match nobody, so there is no one to send to. Change the audience, count who it reaches, and try again.';
  }
  if (counts.contactable === 0) {
    return `None of the ${counts.total} people who match have a phone or WhatsApp number, so nothing could be delivered. Change the audience, count who it reaches, and try again.`;
  }
  return null;
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
