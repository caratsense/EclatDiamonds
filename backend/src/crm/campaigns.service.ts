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
import { explainDeliveryError } from '../integrations/whatsapp-delivery-errors';
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
import {
  campaignOutcome,
  nextRecipientStatus,
  recipientSendKey,
} from './campaign-delivery';
import {
  DID_NOT_ARRIVE,
  RETRY_COOLDOWN_HOURS,
  retryCooldownSince,
  retryPlan,
  type RetryPlan,
} from './campaign-retry';
import { partitionForTagging } from './campaign-tagging';
import {
  ALREADY_RECEIVED_REASON,
  REACHED_STATUSES,
  audienceSnapshotWith,
  suppressedTemplateFrom,
} from './campaign-suppression';
import { LeadTagsService, tagSlug } from './lead-tags.service';
import { readableParty } from '../common/sales-scope';

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

/**
 * How many customers' template history the "already received this" check will
 * hold in memory at once.
 *
 * There is no relation from Party to CampaignRecipient, so the overlap cannot
 * be a single join: the people a template has ever reached are grouped in the
 * database and then counted against the audience. Capped so a tenant with years
 * of history cannot turn an interactive screen into a full table scan in
 * memory, and the screen says the figure is a floor when the cap is hit rather
 * than presenting a truncated number as complete.
 */
const TEMPLATE_HISTORY_MAX = 20_000;

/** How many ids go into one `IN` list. A 20,000-id query is not a query. */
const ID_CHUNK = 5_000;

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

/**
 * Statuses whose verdict a late delivery receipt may still correct. A cancelled
 * campaign is absent on purpose: somebody stopped it, and a receipt for a
 * message that had already left must not quietly reopen it.
 */
const SETTLEABLE: MessagingCampaignStatus[] = [
  'sending',
  'completed',
  'partially_failed',
  'failed',
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
    // The tenant's one tag vocabulary. Tagging from a broadcast must go through
    // the same service the CRM board and the customer profile use, or a tag
    // created here would skip the per-tenant ceiling and the name rules.
    private readonly leadTags: LeadTagsService,
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

  /**
   * How many of this audience have already had this template from us.
   *
   * The client's words: "these many people have already received this
   * template, do you want to send again? If no, exclude them." Asked at the
   * point the audience and the template are both known, which is the review
   * step of the wizard — late enough to be a real number, early enough that
   * nothing has been created.
   *
   * "Received" is the CampaignRecipient history and nothing else: a row that
   * reached the provider and was accepted. A failed row means they never got
   * the message, and suppressing them would guarantee they never do.
   */
  async templateOverlap(
    user: AuthUser,
    input: { definition?: unknown; segmentId?: string; storeIds?: string[]; templateName: string },
  ) {
    const templateName = input.templateName.trim();
    if (!templateName) {
      throw new BadRequestException('Choose the template before checking who has had it.');
    }
    const definition = await this.resolveDefinition(user, input);
    const compiled = compileSegment(definition, new Date());
    const where = previewAudienceWhere(user, compiled.where, input.storeIds);

    const [audience, overlap] = await Promise.all([
      this.prisma.party.count({ where }),
      this.countAlreadyReceived(user.organisationId, where, templateName),
    ]);

    return {
      templateName,
      /** Everyone the rules match, so the overlap can be read as a share. */
      audience,
      alreadyReceived: overlap.alreadyReceived,
      /** True when the figure is a floor rather than the whole history. */
      historyCapped: overlap.historyCapped,
    };
  }

  /**
   * Customers inside `where` who have previously been reached by a campaign
   * sending this template.
   *
   * Two steps rather than one join, because CampaignRecipient carries a plain
   * `partyId` with no relation to Party — grouping in the database gives the
   * distinct people, and the audience filter counts how many of them it
   * matches. The id list is chunked so the second half stays a query rather
   * than a twenty-thousand-element `IN`.
   */
  private async countAlreadyReceived(
    organisationId: string,
    where: Prisma.PartyWhereInput,
    templateName: string,
  ): Promise<{ alreadyReceived: number; historyCapped: boolean }> {
    const grouped = await this.prisma.campaignRecipient.groupBy({
      by: ['partyId'],
      where: {
        organisationId,
        status: { in: REACHED_STATUSES },
        partyId: { not: null },
        campaign: { templateName },
      },
      // Required by Prisma whenever a grouped read is limited, and the id is
      // the only column here. The order does not change the count: the cap is
      // reported as a cap rather than presented as the whole history.
      orderBy: { partyId: 'asc' },
      // One over the cap, so a capped history can be reported as capped rather
      // than silently rounded down to it.
      take: TEMPLATE_HISTORY_MAX + 1,
    });
    const historyCapped = grouped.length > TEMPLATE_HISTORY_MAX;
    const ids = grouped
      .slice(0, TEMPLATE_HISTORY_MAX)
      .map((g) => g.partyId)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return { alreadyReceived: 0, historyCapped };

    let alreadyReceived = 0;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      // AND, never a spread: `where` already carries an OR that IS the store
      // scope for a branch-limited user.
      alreadyReceived += await this.prisma.party.count({
        where: { AND: [where, { id: { in: ids.slice(i, i + ID_CHUNK) } }] },
      });
    }
    return { alreadyReceived, historyCapped };
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
      excludeAlreadyReceivedTemplate?: boolean;
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

    /*
     * "If no, exclude them" — the answer to the already-received prompt, frozen
     * with the audience rather than left as something the screen displayed.
     *
     * Held by TEMPLATE NAME, not as a boolean, because the suppression means
     * "people who have had this particular wording". Changing the campaign's
     * template later must not leave it suppressing the previous one's history.
     */
    const suppressTemplate =
      input.excludeAlreadyReceivedTemplate && input.templateName?.trim()
        ? input.templateName.trim()
        : null;

    const row = await this.prisma.messagingCampaign.create({
      data: {
        organisationId: user.organisationId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        channel,
        segmentId: input.segmentId ?? null,
        audienceSnapshot:
          definition || suppressTemplate
            ? (audienceSnapshotWith(
                definition ?? null,
                suppressTemplate,
              ) as unknown as Prisma.InputJsonValue)
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
    /*
     * The already-received suppression lives INSIDE `audienceSnapshot`, so any
     * write that rebuilds the snapshot has to carry it across or editing a
     * rule would silently switch the exclusion off — and the broadcast would
     * go to exactly the people she had chosen to leave out.
     */
    const storedSuppression = suppressedTemplateFrom(row.audienceSnapshot);
    const templateForSuppression =
      (typeof input.templateName === 'string' ? input.templateName.trim() : row.templateName) ||
      null;
    const suppression =
      input.excludeAlreadyReceivedTemplate === undefined
        ? storedSuppression
        : input.excludeAlreadyReceivedTemplate
          ? templateForSuppression
          : null;
    if (input.definition !== undefined) {
      data.audienceSnapshot = audienceSnapshotWith(
        parseSegmentDefinition(input.definition),
        suppression,
      ) as unknown as Prisma.InputJsonValue;
    } else if (suppression !== storedSuppression) {
      // Only the answer to the prompt changed. The stored rules are re-parsed
      // rather than re-typed, so a snapshot that was never written stays
      // unwritten instead of becoming an audience nobody chose.
      const rules = hasConditions(row.audienceSnapshot)
        ? parseSegmentDefinition(row.audienceSnapshot)
        : null;
      data.audienceSnapshot = audienceSnapshotWith(
        rules,
        suppression,
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
        // The suppression is carried across with the rules. Approval rewrites
        // the snapshot from the resolved definition, and a rebuild that dropped
        // the exclusion would send to the people she chose to leave out — at
        // the one moment nobody is looking at the screen any more.
        audienceSnapshot: audienceSnapshotWith(
          definition,
          suppressedTemplateFrom(row.audienceSnapshot),
        ) as unknown as Prisma.InputJsonValue,
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
    opts: { status?: string; page?: number; limit?: number } = {},
  ) {
    const row = await this.loadCampaign(user, id);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    /*
     * A tab is a question, not a column value. "Did they get it?" spans three
     * statuses and "did it fail?" spans two, so the filter resolves a group to
     * the statuses behind it rather than making the reader know which is which.
     */
    const GROUPS: Record<string, string[]> = {
      reached: REACHED_STATUSES,
      not_reached: DID_NOT_ARRIVE,
    };
    const group = opts.status ? GROUPS[opts.status] : undefined;
    const where = {
      organisationId: user.organisationId,
      campaignId: row.id,
      ...(group ? { status: { in: group } } : opts.status ? { status: opts.status } : {}),
    };
    const total = await this.prisma.campaignRecipient.count({ where });
    const rows = await this.prisma.campaignRecipient.findMany({
      where,
      /*
       * THE ORDER THE AUDIENCE WAS BUILT IN, not alphabetical by status.
       *
       * This used to sort by `status` ascending, which sorts the WORD: dead,
       * delivered, excluded, failed, pending, queued, read, sent. On the
       * nails-event broadcast that put all 59 given-up rows first, so every
       * page the client could reach was made of failures and the 7 sent sat at
       * rows 198-204 — her words, "I could still see only dead ones". A report
       * whose default view is sorted to show the worst outcome first is not a
       * report.
       *
       * `createdAt` is the same instant for every row of one audience (they are
       * written in a single insert), so `id` is what actually orders them —
       * stable, unique, and the order the list was built in. The status tabs
       * are there for anyone who does want one outcome at a time.
       */
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      total,
      page,
      pageSize: limit,
      pageCount: Math.max(Math.ceil(total / limit), 1),
      items: rows.map((r) => ({
        id: r.id,
        partyId: r.partyId,
        /*
         * THE WHOLE NUMBER, not the last four digits.
         *
         * This was masked, and the client asked why: "why have we hidden those
         * numbers... it could have simply been whole number visible." It is her
         * own customer list, shown to her own staff, who can open any of those
         * customers' records and read the number there in one click. Masking it
         * on this screen protected nobody and stopped the one thing the screen
         * is for — matching a row that did not arrive to a person she knows.
         */
        contact: r.contactValue,
        status: r.status,
        exclusionReason: r.exclusionReason,
        // Meta's codes, as a sentence. Stored as codes so no echoed customer
        // content lands in the row; explained here so the report does not read
        // "Provider error 131049" to the person deciding what to do about it.
        lastError: explainDeliveryError(r.lastError),
        sentAt: r.sentAt,
      })),
    };
  }

  /**
   * What a re-send to the "Did not arrive" group would actually do, before
   * anybody presses the button.
   *
   * A separate read rather than a figure returned by the re-send itself: the
   * client has to be able to see how many people it will spend, and how many it
   * is holding back and why, while she can still decide not to.
   */
  async retryPlanFor(user: AuthUser, id: string): Promise<RetryPlan> {
    const row = await this.loadCampaign(user, id);
    const scope = {
      organisationId: user.organisationId,
      campaignId: row.id,
      status: { in: DID_NOT_ARRIVE },
    };
    const [retryable, messagedRecently] = await Promise.all([
      this.prisma.campaignRecipient.count({ where: scope }),
      this.prisma.campaignRecipient.count({
        where: { ...scope, sentAt: { gte: retryCooldownSince(new Date()) } },
      }),
    ]);
    return retryPlan({ retryable, messagedRecently });
  }

  /**
   * Re-send to the people this broadcast did not reach.
   *
   * 'excluded' is deliberately left alone: it means consent or policy said no,
   * and retrying that would be a deliberate attempt to message somebody who
   * declined. scripts/retry-campaign.mjs can reclaim the narrow
   * `policy_refused_at_send` case when a rule has since changed, with a human
   * reading the figures first; a button on a screen is not the place for it.
   */
  async retryFailed(user: AuthUser, id: string, opts: { includeRecentlyMessaged?: boolean } = {}) {
    this.assertManager(user, 'retry a campaign');
    const row = await this.loadCampaign(user, id);
    /*
     * ANYONE MESSAGED IN THE LAST 24 HOURS IS HELD BACK.
     *
     * Meta caps marketing per recipient (error 131049), so re-sending to
     * somebody who was messaged an hour ago spends their allowance and is the
     * most likely way to have them refused again. The window and the reasoning
     * are RETRY_COOLDOWN_HOURS in campaign-retry, which is the same rule
     * scripts/retry-campaign.mjs enforces rather than a second opinion about it.
     *
     * `sentAt` is when the provider last took a message for them; a recipient
     * that never reached the provider has none and is always eligible.
     */
    const cooldownSince = retryCooldownSince(new Date());
    const cooldownClause = opts.includeRecentlyMessaged
      ? {}
      : { OR: [{ sentAt: null }, { sentAt: { lt: cooldownSince } }] };
    const where = {
      organisationId: user.organisationId,
      campaignId: row.id,
      status: { in: DID_NOT_ARRIVE },
    };
    const heldBack = opts.includeRecentlyMessaged
      ? 0
      : await this.prisma.campaignRecipient.count({
          where: { ...where, sentAt: { gte: cooldownSince } },
        });

    const reset = await this.prisma.campaignRecipient.updateMany({
      where: { ...where, ...cooldownClause },
      /*
       * `attempts` IS DELIBERATELY LEFT ALONE. It is the generation number in
       * the send's idempotency key, so zeroing it makes this attempt reuse the
       * key the last one spent — and the send becomes a no-op that hands back
       * the message already refused. That is exactly how three re-sends of the
       * nails-event broadcast reached nobody.
       *
       * The old message is let go of too: leaving it linked would have this
       * attempt's outcome read off the previous attempt's failure.
       */
      data: { status: 'pending', lastError: null, messageId: null },
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
      // The override is named in the trail. Overriding a per-recipient cap is
      // a decision somebody made, not a default, and the record has to show
      // which of the two happened.
      summary:
        `Retried ${reset.count} recipients that did not arrive on "${row.name}"` +
        (opts.includeRecentlyMessaged
          ? `, including anyone messaged in the last ${RETRY_COOLDOWN_HOURS}h.`
          : heldBack
            ? `; ${heldBack} held back as messaged within ${RETRY_COOLDOWN_HOURS}h.`
            : '.'),
    });
    return { retried: reset.count, heldBack, cooldownHours: RETRY_COOLDOWN_HOURS };
  }

  // ======================================================= tags from a send

  /**
   * Put a tag on the customers behind the ticked recipient rows.
   *
   * The client's words: "I can select multiple people at a time and then I can
   * give them a custom tag. So next time when I create a broadcast I can
   * include or exclude those people through tags." The include and the exclude
   * already exist — `party.tag` with `in` and `not_in` in the audience DSL —
   * so this is the half that was missing: getting the tag onto the people.
   *
   * It lands on the CUSTOMER through the same PartyTagAssignment the customer
   * profile writes, so a tag put on somebody here is the tag the next
   * broadcast's audience builder offers. A parallel "broadcast tag" would have
   * been invisible to the one screen it was asked for.
   */
  async tagRecipients(
    user: AuthUser,
    id: string,
    input: { recipientIds: string[]; tagId?: string; tagName?: string },
  ) {
    this.assertManager(user, 'tag customers from a broadcast');
    const row = await this.loadCampaign(user, id);
    if (!input.recipientIds.length) {
      throw new BadRequestException('Tick the people you want to tag first.');
    }

    const tag = await this.resolveTagFor(user, input);

    const rows = await this.prisma.campaignRecipient.findMany({
      where: {
        id: { in: input.recipientIds },
        organisationId: user.organisationId,
        campaignId: row.id,
      },
      select: { id: true, partyId: true },
    });
    const split = partitionForTagging(input.recipientIds, rows);

    /*
     * The customer must be one this caller may read, checked through the same
     * `readableParty` rule the customer profile's own tagging uses. A recipient
     * row is reachable because the broadcast is; that is not on its own a
     * licence to write to the customer record behind it.
     */
    const reachable = split.partyIds.length
      ? await this.prisma.party.findMany({
          where: { id: { in: split.partyIds }, ...readableParty(user) },
          select: { id: true },
        })
      : [];

    const created = reachable.length
      ? (
          await this.prisma.partyTagAssignment.createMany({
            data: reachable.map((p) => ({
              organisationId: user.organisationId,
              partyId: p.id,
              tagId: tag.id,
              createdById: user.id,
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;

    await this.audit.record(user, {
      action: 'campaign.recipients.tagged',
      entityType: 'MessagingCampaign',
      entityId: row.id,
      summary:
        `Tagged ${created} customer${created === 1 ? '' : 's'} "${tag.name}" ` +
        `from the broadcast "${row.name}".`,
    });

    return {
      tag: { id: tag.id, name: tag.name, colour: tag.colour },
      /** Customers that did not already carry the tag and now do. */
      tagged: created,
      /** Ticked customers that already carried it — counted, not an error. */
      alreadyTagged: reachable.length - created,
      /**
       * Ticked rows with no customer record behind them. A broadcast can hold
       * a number that never matched a customer, and there is nothing to tag;
       * the screen says which rows rather than reporting a smaller number with
       * no explanation.
       */
      withoutCustomer: split.withoutCustomer.length,
      /** Ids that are not on this broadcast. A stale screen, not a failure. */
      notOnThisBroadcast: split.notOnThisBroadcast.length,
    };
  }

  /**
   * The tag to apply: one the tenant already has, or a new one by name.
   *
   * A name that already exists is REUSED rather than refused. Somebody typing
   * "VIP" into the box on a broadcast screen means the VIP tag they already
   * have, and a conflict error there is a dead end — they cannot see the
   * vocabulary from here to pick it instead.
   */
  private async resolveTagFor(
    user: AuthUser,
    input: { tagId?: string; tagName?: string },
  ): Promise<{ id: string; name: string; colour: string | null }> {
    if (input.tagId) {
      const existing = await this.prisma.leadTag.findFirst({
        where: { id: input.tagId, organisationId: user.organisationId },
        select: { id: true, name: true, colour: true },
      });
      if (!existing) throw new NotFoundException('That tag does not exist here.');
      return existing;
    }
    const name = input.tagName?.trim();
    if (!name) throw new BadRequestException('Choose a tag, or type a name for a new one.');
    const bySlug = await this.prisma.leadTag.findFirst({
      where: { organisationId: user.organisationId, slug: tagSlug(name) },
      select: { id: true, name: true, colour: true },
    });
    if (bySlug) return bySlug;
    // Through LeadTagsService, so the per-tenant ceiling and the name length
    // rules are the vocabulary's own and not restated here.
    const made = await this.leadTags.create(user, { name });
    return { id: made.id, name: made.name, colour: made.colour };
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

    /*
     * "If no, exclude them", applied to the real audience.
     *
     * Checked per batch rather than once up front: CampaignRecipient has no
     * relation to Party, so this cannot be a clause on the audience query, and
     * resolving the whole history into an `IN` list would be the same figure
     * with a worse failure mode. One indexed lookup per 500 customers.
     *
     * They are written as EXCLUDED rows rather than left out of the list
     * entirely. A person who silently never appears is a person nobody can
     * account for; an excluded row with a reason puts them on the "Not
     * messaged" tab, which is where every other deliberate omission is.
     */
    const suppressTemplate = suppressedTemplateFrom(campaign.audienceSnapshot);

    let cursor: string | undefined;
    let created = 0;
    let blocked = 0;
    let unreadable = 0;
    let alreadyHadTemplate = 0;
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

      const alreadyReached = suppressTemplate
        ? new Set(
            (
              await this.prisma.campaignRecipient.groupBy({
                by: ['partyId'],
                where: {
                  organisationId: ctx.organisationId,
                  partyId: { in: batch.map((p) => p.id) },
                  status: { in: REACHED_STATUSES },
                  campaign: { templateName: suppressTemplate },
                },
              })
            ).map((g) => g.partyId),
          )
        : null;

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
        // Checked after blocked, so a blocked customer is reported as blocked:
        // that is the stronger reason and the one that would still apply if the
        // suppression were turned off.
        const hadTemplate = !isBlocked && alreadyReached?.has(p.id) === true;
        if (hadTemplate) alreadyHadTemplate += 1;
        rows.push({
          organisationId: ctx.organisationId,
          campaignId: campaign.id,
          partyId: p.id,
          contactValue: normalized,
          status: isBlocked || hadTemplate ? 'excluded' : 'pending',
          exclusionReason: isBlocked
            ? 'blocked_customer'
            : hadTemplate
              ? ALREADY_RECEIVED_REASON
              : null,
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
        `${blocked} blocked, ${unreadable} with no usable number` +
        (suppressTemplate
          ? `, ${alreadyHadTemplate} already had ${suppressTemplate}.`
          : '.'),
    });
    await this.enqueueSend(ctx.organisationId, campaign.id);
    return { created, blocked, unreadable, alreadyHadTemplate };
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
        const queued = await this.omnichannel.queueToContact(actor, {
          to: recipient.contactValue,
          purpose: 'marketing',
          // The campaign chose this person BY their customer record; handing
          // over only their number made the send re-derive who they were, and
          // lose them when no ContactPoint row existed.
          ...(recipient.partyId ? { partyId: recipient.partyId } : {}),
          templateName: campaign.templateName,
          languageCode: campaign.templateLanguage,
          // Undefined when the template takes no values: Meta refuses an empty
          // parameter list as firmly as a missing one.
          templateComponents: templateComponentsFor(
            resolveVariables(mappings, subjects.get(recipient.partyId ?? '') ?? {}),
          ),
          /*
           * The ATTEMPT is part of the key, not just the recipient.
           *
           * Without it a retry is a no-op that looks like a send: the key is
           * already spent, so queueToContact hands back the message it refused
           * the first time, this loop reads that old refusal off it, and the
           * row fails again with an error from an hour ago. The nails-event
           * broadcast was re-sent three times that way after the header bug
           * was fixed, and not one of the 125 was ever tried again.
           *
           * `attempts` was incremented by the claim above, so it is this
           * attempt's number — and it is never reset, which is what makes each
           * retry a key the provider has not seen. Within one attempt the key
           * is still fixed, so a job that dies mid-chunk and runs again cannot
           * message anybody twice.
           */
          idempotencyKey: recipientSendKey(campaign.id, recipient.id, recipient.attempts + 1),
          // So the thread can be found by the broadcast that started it.
          campaignId: campaign.id,
        });
        /*
         * STILL QUEUED. `queueToContact` returns `{ message, job, ... }` — an
         * outbox row and the job that will call the provider, nothing more.
         *
         * This used to write 'sent' here, with the id read as
         * `(message as { id?: string }).id`, which is undefined on that shape.
         * So a broadcast of 126 reported "125 sent" while Meta had refused all
         * 125, and not one recipient carried a message id to ever find out.
         * Storing the id is what lets the outcome come back; the status is the
         * outbox's to give, below.
         */
        await this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { messageId: queued.message.id, lastError: null },
        });
        /*
         * Read the outbox once, now. The delivery job can run and settle this
         * message while the row above is still being written — and a receipt
         * that arrives in that window finds no recipient to land on, leaving
         * somebody queued forever. It also covers the idempotent re-send, where
         * `queueToContact` hands back a message that was decided long ago.
         */
        await this.applyMessageOutcome({
          organisationId: ctx.organisationId,
          messageId: queued.message.id,
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

  /**
   * What the outbox made of one campaign message, reaching the recipient row
   * that asked for it.
   *
   * Called by OmnichannelService when the provider accepts or refuses a message
   * and again for every delivery receipt the webhook verifies, so nothing here
   * polls. A message belonging to no campaign is the ordinary case and costs one
   * indexed lookup.
   *
   * `status` is given by the receipt paths, which know more than the stored row
   * does at that instant; the send loop omits it and the outbox row is read.
   */
  async applyMessageOutcome(input: {
    organisationId: string;
    messageId: string;
    status?: string;
    error?: string | null;
    occurredAt?: Date;
  }) {
    const recipient = await this.prisma.campaignRecipient.findFirst({
      where: { organisationId: input.organisationId, messageId: input.messageId },
      select: { id: true, campaignId: true, status: true, attempts: true, sentAt: true },
    });
    if (!recipient) return { matched: false, updated: false };

    let { status, error } = input;
    if (!status) {
      const message = await this.prisma.message.findFirst({
        where: { id: input.messageId, organisationId: input.organisationId },
        select: { status: true, error: true },
      });
      if (!message) return { matched: true, updated: false };
      status = message.status;
      error = message.error;
    }

    const next = nextRecipientStatus({
      current: recipient.status,
      attempts: recipient.attempts,
      messageStatus: status,
    });
    if (!next) return { matched: true, updated: false, status: recipient.status };

    const failed = next === 'failed' || next === 'dead';
    await this.prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status: next,
        // When it actually left, stamped once. A delivered or read receipt is
        // later proof of the same send, not a second one — and it is the only
        // proof there is when the 'sent' callback never arrived.
        ...(!failed && !recipient.sentAt ? { sentAt: input.occurredAt ?? new Date() } : {}),
        lastError: failed ? (error ?? 'The provider refused this message.').slice(0, 500) : null,
      },
    });
    // The refusals arrive after the last row was handed over, so the campaign's
    // own verdict is recomputed here rather than only at the end of the loop.
    await this.finish(input.organisationId, recipient.campaignId);
    return { matched: true, updated: true, status: next };
  }

  /**
   * Write the campaign's own status from what actually happened to its
   * recipients.
   *
   * Called when the send loop runs out of rows to hand over AND again on every
   * outcome the outbox reports. Those are not the same moment: handing 126
   * messages to the outbox takes a minute and Meta's verdict on them takes
   * longer, so the first call finds every recipient still queued and must leave
   * the campaign 'sending' — which is what `campaignOutcome` decides. Finishing
   * there, as this once did, is how a broadcast that reached nobody was written
   * 'completed' and stamped with a finish time.
   *
   * A cancelled campaign is never reopened by a late receipt.
   */
  private async finish(organisationId: string, campaignId: string) {
    const grouped = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { organisationId, campaignId },
      _count: { _all: true },
    });
    const counts: CampaignCounts = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const outcome = campaignOutcome(counts);
    if (!outcome.settled) return { status: outcome.status, counts };

    const campaign = await this.prisma.messagingCampaign.findFirst({
      where: { id: campaignId, organisationId },
      select: { status: true, finishedAt: true },
    });
    if (!campaign || !SETTLEABLE.includes(campaign.status)) {
      return { status: campaign?.status ?? outcome.status, counts };
    }
    const status = outcome.status as MessagingCampaignStatus;
    if (campaign.status === status && campaign.finishedAt) return { status, counts };
    await this.prisma.messagingCampaign.update({
      where: { id: campaignId },
      // When it finished, not when the verdict was last corrected: a receipt
      // that turns 'completed' into 'partially_failed' two minutes later did
      // not move the send.
      data: { status, finishedAt: campaign.finishedAt ?? new Date() },
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

/**
 * Does this stored snapshot actually hold rules?
 *
 * A snapshot may be a suppression and nothing else — a campaign built from a
 * saved segment answers the already-received prompt without ever having inline
 * rules — and `parseSegmentDefinition` would refuse that as an audience with no
 * rule. Asked before parsing rather than caught after, because the refusal it
 * throws is written for somebody building an audience.
 */
function hasConditions(snapshot: unknown): boolean {
  return (
    Boolean(snapshot) &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    Array.isArray((snapshot as Record<string, unknown>).conditions)
  );
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
