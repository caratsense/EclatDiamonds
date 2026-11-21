import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuditService, SYSTEM_ACTORS, type SystemActor } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import {
  buildCarouselSendComponent,
  carouselImageKeys,
  type CarouselCardMedia,
} from './carousel-send';
import {
  planMediaHeader,
  withMediaHeader,
  type MediaHeaderPlan,
} from './media-header-send';
import { readableParty } from '../common/sales-scope';
import { StoreScopeService } from '../common/store-scope.service';
import { ConversationsService } from '../crm/conversations.service';
import { ActivityService } from '../crm/activity.service';
import { CampaignsService } from '../crm/campaigns.service';
import { IdentityService } from '../crm/identity.service';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { ChannelAdaptersService } from '../integrations/adapters/channel-adapters.service';
import { JobContext, JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  QueueOmnichannelMessageDto,
  RecordConsentDto,
  UpsertMessageTemplateDto,
} from './dto/omnichannel.dto';
import {
  ConsentState,
  evaluateDeliveryPolicy,
  evaluateSendableContent,
  MessagePurpose,
  OmnichannelChannel,
  providerTemplateStatus,
  templateSendability,
  type ProviderTemplateStatus,
} from './omnichannel-policy';
import { templateKey } from './template-sync.service';

export const OMNICHANNEL_DELIVERY_JOB = 'omnichannel.deliver';
const DELIVERY_MAX_ATTEMPTS = 5;
const TEMPLATE_ASSET_KIND = 'message_template';
const MAX_COMPONENT_BYTES = 20_000;

interface DeliveryJobPayload {
  messageId: string;
}

interface TemplateMetadata {
  channel: 'whatsapp';
  languageCode: string;
  category: 'authentication' | 'marketing' | 'utility';
  /**
   * What an operator recorded locally. Kept for history and for the screen, and
   * deliberately NOT what authorises a send: a person typing "approved" into a
   * form is a claim about Meta, not a fact from Meta.
   */
  approvalStatus: 'approved' | 'pending' | 'rejected' | 'paused' | 'disabled';
  /** The provider's own verdict, written only by TemplateSyncService. */
  providerStatus: ProviderTemplateStatus;
  /** When that verdict was read. Absent on every row predating template sync. */
  providerSyncedAt: string | null;
  bodyPreview?: string;
  /**
   * The body as written, with `{{1}}` still in it, and the samples beside it.
   *
   * `bodyPreview` has the samples substituted, which is right for reading and
   * wrong for editing: putting it back in the editor would submit a template
   * that greets every customer by the name in the example. The editor opens
   * from these two.
   */
  bodySource?: string;
  bodyExamples?: string[];
  /** A carousel cannot be edited here; its cards are not recoverable. */
  isCarousel?: boolean;
  /*
   * The rest of the message, so a template can be REVIEWED and not merely
   * identified. Written by TemplateSyncService from the provider's own
   * components. Absent on anything synchronised before that existed, which the
   * detail view says plainly rather than drawing an empty bubble.
   */
  headerFormat?: string;
  headerText?: string;
  /** Meta's own CDN URL for an approved image header. */
  headerImageUrl?: string;
  footerText?: string;
  buttons?: { type: 'URL' | 'QUICK_REPLY'; text: string; url?: string }[];
  variables: string[];
  recordedAt: string;
}

/**
 * A document to deliver with a message, by private storage key.
 *
 * Only ever built by server code (a quote PDF), never accepted from a request
 * body: a caller who could name a key could name another record's document.
 */
export const ATTACHABLE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AttachmentMime = 'application/pdf' | (typeof ATTACHABLE_IMAGE_MIMES)[number];

export interface QueuedDocument {
  storageKey: string;
  filename: string;
  /*
   * Was `'application/pdf'` alone, which is why a product photograph could not
   * be sent: the delivery path had no shape to carry one and failed the
   * message with "media delivery is not connected yet".
   */
  mimeType: AttachmentMime;
}

/** Which WhatsApp message a stored attachment becomes. */
export function attachmentKind(mimeType: string): 'document' | 'image' {
  return (ATTACHABLE_IMAGE_MIMES as readonly string[]).includes(mimeType) ? 'image' : 'document';
}

interface MessageInstructions {
  purpose: MessagePurpose;
  templateAssetId?: string;
  templateComponents?: unknown[];
  document?: QueuedDocument;
  queuedAt?: string;
  /** On a staff thread: the employee the notice is for, re-read at delivery. */
  staffUserId?: string;
  /**
   * The broadcast this message belongs to, when it is one.
   *
   * Recorded on the message rather than inferred from the recipient row,
   * because the inbox reads threads and has no way back to a campaign
   * otherwise: `CampaignRecipient.messageId` is a plain column with no
   * relation behind it, so a thread cannot be filtered by the broadcast that
   * started it without first listing every message id the campaign produced.
   *
   * It also answers, on the thread itself, the question a colleague asks when
   * a customer replies to something nobody at the branch typed: what was this
   * in reply to.
   */
  campaignId?: string;
}

/** The outcome of queuing a notice to a member of staff. */
export type StaffNoticeResult =
  | { queued: true; messageId: string; jobId?: string; deduplicated: boolean }
  | { queued: false; code: string; reason: string };

export const CONSENT_PURPOSES = ['service', 'marketing', 'all'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * The purpose recorded on a stored consent event, or undefined when the row
 * does not carry a recognised one.
 *
 * `metadata` is free-form JSON that a past release, an import or another agent
 * may have written, so its `purpose` is genuinely unknown until checked. An
 * unreadable purpose must not be treated as `service` or as `all` — the first
 * would silently grant marketing consent, the second would grant everything.
 * It is skipped instead, leaving the resolution to fall through to `unknown`.
 */
export function consentPurpose(value: unknown): ConsentPurpose | undefined {
  return typeof value === 'string' &&
    (CONSENT_PURPOSES as readonly string[]).includes(value)
    ? (value as ConsentPurpose)
    : undefined;
}

export interface ConsentSnapshot {
  state: ConsentState;
  purpose: ConsentPurpose;
  channel: string;
  eventId?: string;
  occurredAt?: Date;
  expiresAt?: Date;
  source?: string;
}

/**
 * Consent, approved templates and the durable outbound outbox.
 *
 * The Message row is the user-visible outbox item; JobTask is the delivery
 * engine and dead-letter record. Keeping those responsibilities separate means
 * a provider timeout cannot make the inbox claim a message was sent, while a
 * worker restart cannot lose something a salesperson already queued.
 */
@Injectable()
export class OmnichannelService implements OnModuleInit {
  private readonly log = new Logger(OmnichannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly conversations: ConversationsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly whatsapp: WhatsAppService,
    /**
     * Asked, per tenant, whether a channel has a working outbound path.
     *
     * The policy function is pure and cannot read a tenant's connections, so
     * the answer is fetched here and handed to it. Before this the policy
     * decided it with `channel !== 'whatsapp'`, which could not say why a
     * channel was unavailable and gave the same answer to a business that had
     * connected Instagram and one that had not.
     */
    private readonly adapters: ChannelAdaptersService,
    private readonly identity: IdentityService,
    private readonly scope: StoreScopeService,
    /** Reads a queued document's bytes at delivery time. */
    private readonly storage: StorageService,
    /**
     * Told what became of a broadcast's messages.
     *
     * The dependency runs this way round deliberately. Only the outbox knows
     * whether the provider took a message or refused it, and a campaign cannot
     * find that out by asking later without polling thousands of rows. So the
     * outbox reports, and `CampaignRecipient.messageId` is what it reports
     * against. CampaignsService injects this service in turn, which is why both
     * sides are behind a forwardRef.
     */
    @Inject(forwardRef(() => CampaignsService))
    private readonly campaigns: CampaignsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(OMNICHANNEL_DELIVERY_JOB, (payload, ctx) =>
      this.deliver(payload as DeliveryJobPayload, ctx),
    );
  }

  // ---------------------------------------------------------------- Consent

  /** Record one immutable grant/revocation. The newest applicable event wins. */
  async recordConsent(user: AuthUser, input: RecordConsentDto) {
    const party = await this.assertPartyAccess(user, input.partyId);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException('Consent time cannot be in the future.');
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    if (expiresAt && expiresAt <= occurredAt) {
      throw new BadRequestException('Consent expiry must be later than the consent time.');
    }

    if (input.contactPointId) {
      const contact = await this.prisma.contactPoint.findFirst({
        where: {
          id: input.contactPointId,
          organisationId: user.organisationId,
          partyId: input.partyId,
        },
        select: { id: true },
      });
      if (!contact) throw new BadRequestException('Contact point does not belong to this customer.');
    }

    const dedupeKey = input.idempotencyKey
      ? `omnichannel:consent:${input.idempotencyKey}`
      : null;
    const metadata = compactJson({
      purpose: input.purpose,
      source: input.source,
      contactPointId: input.contactPointId,
      expiresAt: expiresAt?.toISOString(),
      reference: input.reference,
    });

    let event: { id: string; occurredAt: Date };
    try {
      event = await this.prisma.activityEvent.create({
        data: {
          organisationId: user.organisationId,
          storeId: party.storeId,
          partyId: party.id,
          actorUserId: user.id,
          type: `consent.${input.status}`,
          summary: `${input.channel} ${input.purpose} consent ${input.status}`,
          entityType: 'Party',
          entityId: party.id,
          channel: input.channel,
          sourceSystem: input.source,
          occurredAt,
          dedupeKey,
          metadata,
        },
        select: { id: true, occurredAt: true },
      });
    } catch (error) {
      if (!dedupeKey || !isUniqueViolation(error)) throw error;
      const prior = await this.prisma.activityEvent.findFirst({
        where: { organisationId: user.organisationId, dedupeKey },
        select: { id: true, occurredAt: true, partyId: true, channel: true, type: true, metadata: true },
      });
      const priorMeta = jsonObject(prior?.metadata);
      if (
        !prior ||
        prior.partyId !== input.partyId ||
        prior.channel !== input.channel ||
        prior.type !== `consent.${input.status}` ||
        priorMeta.purpose !== input.purpose
      ) {
        throw new BadRequestException('That idempotency key was already used for another consent event.');
      }
      event = { id: prior.id, occurredAt: prior.occurredAt };
    }

    await this.audit.record(user, {
      action: `omnichannel.consent.${input.status}`,
      entityType: 'Party',
      entityId: party.id,
      storeId: party.storeId,
      summary: `${input.channel} ${input.purpose} consent ${input.status}`,
      metadata: { channel: input.channel, purpose: input.purpose, source: input.source },
    });

    return {
      eventId: event.id,
      partyId: party.id,
      channel: input.channel,
      purpose: input.purpose,
      state: input.status,
      occurredAt: event.occurredAt,
      expiresAt: expiresAt ?? null,
    };
  }

  /**
   * What this tenant treats as permission to send marketing.
   *
   * Read per send rather than cached: it is one indexed lookup by primary key,
   * and a business that turns the permissive basis off has turned it off —
   * finding out a few minutes later is not good enough for a decision about
   * messaging customers.
   *
   * Absent means `explicit`, the stricter reading. A tenant that has never
   * made this decision has not made it permissively.
   */
  private async marketingConsentBasis(
    organisationId: string,
  ): Promise<'explicit' | 'implied'> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const value = ((org?.settings ?? {}) as Record<string, unknown>).marketingConsentBasis;
    return value === 'implied' ? 'implied' : 'explicit';
  }

  async consentFor(
    user: AuthUser,
    partyId: string,
    channel: OmnichannelChannel,
    purpose: MessagePurpose,
  ): Promise<ConsentSnapshot> {
    await this.assertPartyAccess(user, partyId);
    return this.resolveConsent(user.organisationId, partyId, channel, purpose);
  }

  /** Used by verified provider webhooks when a customer sends STOP/unsubscribe. */
  async recordProviderOptOut(input: {
    organisationId: string;
    partyId: string;
    channel: OmnichannelChannel;
    providerEventId: string;
    occurredAt?: Date;
  }): Promise<void> {
    const party = await this.prisma.party.findFirst({
      where: { id: input.partyId, organisationId: input.organisationId },
      select: { id: true, storeId: true },
    });
    if (!party) throw new NotFoundException('Customer not found');
    try {
      await this.prisma.activityEvent.create({
        data: {
          organisationId: input.organisationId,
          storeId: party.storeId,
          partyId: party.id,
          type: 'consent.revoked',
          summary: `${input.channel} all-purpose consent revoked by recipient`,
          entityType: 'Party',
          entityId: party.id,
          channel: input.channel,
          sourceSystem: 'provider',
          occurredAt: input.occurredAt ?? new Date(),
          dedupeKey: `omnichannel:optout:${input.channel}:${input.providerEventId}`,
          metadata: { purpose: 'all', source: 'inbound_message' },
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  private async resolveConsent(
    organisationId: string,
    partyId: string,
    channel: string,
    purpose: MessagePurpose,
  ): Promise<ConsentSnapshot> {
    const rows = await this.prisma.activityEvent.findMany({
      where: {
        organisationId,
        partyId,
        channel,
        type: { in: ['consent.granted', 'consent.revoked'] },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: { id: true, type: true, occurredAt: true, metadata: true },
    });

    for (const row of rows) {
      const metadata = jsonObject(row.metadata);
      const eventPurpose = consentPurpose(metadata.purpose);
      if (!eventPurpose) continue;
      if (eventPurpose !== purpose && eventPurpose !== 'all') continue;
      const expiresAt = typeof metadata.expiresAt === 'string' ? new Date(metadata.expiresAt) : undefined;
      const state: ConsentState = row.type === 'consent.granted' ? 'granted' : 'revoked';
      if (state === 'granted' && expiresAt && expiresAt <= new Date()) {
        return {
          state: 'unknown',
          purpose: eventPurpose,
          channel,
          eventId: row.id,
          occurredAt: row.occurredAt,
          expiresAt,
          source: typeof metadata.source === 'string' ? metadata.source : undefined,
        };
      }
      return {
        state,
        purpose: eventPurpose,
        channel,
        eventId: row.id,
        occurredAt: row.occurredAt,
        expiresAt,
        source: typeof metadata.source === 'string' ? metadata.source : undefined,
      };
    }

    return { state: 'unknown', purpose, channel };
  }

  // -------------------------------------------------------------- Templates

  async listTemplates(user: AuthUser, integrationId?: string) {
    const rows = await this.prisma.integrationAsset.findMany({
      where: {
        organisationId: user.organisationId,
        kind: TEMPLATE_ASSET_KIND,
        ...(integrationId ? { integrationId } : {}),
      },
      orderBy: [{ name: 'asc' }, { externalId: 'asc' }],
      include: { integration: { select: { id: true, name: true, providerCode: true, status: true } } },
    });
    return rows.map((row) => ({ ...row, metadata: templateMetadata(row.metadata) }));
  }

  async upsertTemplate(
    user: AuthUser,
    integrationId: string,
    input: UpsertMessageTemplateDto,
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organisationId: user.organisationId },
      select: { id: true, providerCode: true },
    });
    if (!integration) throw new NotFoundException('Integration not found');
    if (integration.providerCode !== 'whatsapp_cloud' || input.channel !== 'whatsapp') {
      throw new BadRequestException('This template does not match the selected messaging integration.');
    }

    /*
     * Recording a template is a local act; approving one is not. This writes the
     * operator's declaration and preserves whatever the provider last said, but
     * it can never set or raise `providerStatus` — only TemplateSyncService can,
     * and only from what Meta actually returned.
     */
    /*
     * Identity is name AND language, never name alone. Meta approves
     * `order_update` in en_US and in hi_IN independently, and the old key —
     * `@@unique([integrationId, kind, externalId])` over the bare name — could
     * only hold one of them. Recording the second language silently rewrote the
     * first one's row, so an approved English verdict became the Hindi row's
     * verdict and authorised a send Meta had never reviewed.
     */
    const key = templateKey(input.name, input.languageCode);
    if (!key) {
      throw new BadRequestException('A template needs a valid name and language code.');
    }
    const existing = await this.prisma.integrationAsset.findFirst({
      where: { integrationId, kind: TEMPLATE_ASSET_KIND, externalId: key },
      select: { metadata: true },
    });
    const previous = existing ? templateMetadata(existing.metadata) : null;
    const metadata: TemplateMetadata = {
      channel: input.channel,
      languageCode: input.languageCode,
      category: input.category,
      approvalStatus: input.status,
      providerStatus: previous?.providerStatus ?? 'UNKNOWN',
      providerSyncedAt: previous?.providerSyncedAt ?? null,
      ...(input.bodyPreview ? { bodyPreview: input.bodyPreview } : {}),
      variables: input.variables ?? [],
      recordedAt: new Date().toISOString(),
    };

    const asset = await this.prisma.integrationAsset.upsert({
      where: {
        integrationId_kind_externalId: {
          integrationId,
          kind: TEMPLATE_ASSET_KIND,
          externalId: key,
        },
      },
      create: {
        organisationId: user.organisationId,
        integrationId,
        kind: TEMPLATE_ASSET_KIND,
        // `externalId` carries the composite identity; `name` stays the bare
        // provider template name, because that is what the Graph send call needs.
        externalId: key,
        name: input.name,
        metadata: metadata as unknown as Prisma.InputJsonValue,
        isActive: input.status !== 'disabled',
      },
      update: {
        name: input.name,
        metadata: metadata as unknown as Prisma.InputJsonValue,
        isActive: input.status !== 'disabled',
      },
    });

    await this.audit.record(user, {
      action: 'omnichannel.template.upsert',
      entityType: 'IntegrationAsset',
      entityId: asset.id,
      summary: `Recorded ${input.name} as ${input.status}`,
      metadata: {
        integrationId,
        channel: input.channel,
        languageCode: input.languageCode,
        category: input.category,
        approvalStatus: input.status,
      },
    });
    return { ...asset, metadata };
  }

  // ----------------------------------------------------------------- Outbox

  /**
   * Send to a bare phone number, through the same policy as everything else.
   *
   * This exists for `POST /integrations/whatsapp/send`, which predates the
   * omnichannel module and called the provider directly: no consent check, no
   * opt-out check, no 24-hour window, no provider-approved template, no outbox
   * row, no delivery job, no audit. Any store manager could message any number
   * in the tenant, including one that had answered STOP.
   *
   * A phone number is not an authorisation, so the resolution is deliberate:
   * the number is normalised, matched to a customer this user is allowed to see
   * (a number belonging to another store's customer is refused exactly like a
   * direct id would be), and the thread it belongs to is reused rather than
   * forked. From there `queue()` owns every decision.
   */
  async queueToContact(
    user: AuthUser,
    input: {
      to: string;
      purpose: MessagePurpose;
      body?: string;
      templateName?: string;
      languageCode?: string;
      templateComponents?: unknown[];
      idempotencyKey?: string;
      /** The broadcast this send belongs to; recorded on the message. */
      campaignId?: string;
      /**
       * The customer this send is for, when the caller already knows.
       *
       * A broadcast picks people BY customer record and then hands this method
       * a phone number, which re-derives the identity from a ContactPoint row.
       * 78 of one campaign's recipients have their number on the Party and no
       * ContactPoint for it, so the thread was created anonymous and the worker
       * then refused marketing to an anonymous thread — customers the sender
       * had named, dropped for not being identifiable.
       *
       * Used only when the lookup finds nothing, and still checked through
       * assertPartyAccess: a hint is not permission.
       */
      partyId?: string;
    },
    document?: QueuedDocument,
    /**
     * Set when the caller already proved the right to message this number
     * through a record they may act on (their own quote). A salesperson then
     * reaches the number's customer even if another record of theirs does not
     * link them; branch scope still applies.
     */
    opts: { recordAuthorised?: boolean } = {},
  ) {
    const org = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { country: true },
    });
    const normalized = this.identity.normalize('whatsapp', input.to, org?.country ?? 'IN');
    if (!normalized) {
      throw new BadRequestException('That is not a usable WhatsApp number.');
    }

    // Tenant-scoped by the query itself: another organisation's contact point
    // is not visible here even when both tenants hold the same number.
    const holder = await this.prisma.contactPoint.findFirst({
      where: {
        organisationId: user.organisationId,
        valueNormalized: normalized,
        kind: { in: ['whatsapp', 'phone'] },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { partyId: true },
    });
    // Store scope is enforced for a KNOWN customer. An unmatched number stays
    // anonymous — it is still bound by consent, window and template rules, and
    // marketing to it is refused outright by the policy.
    const knownPartyId = holder?.partyId ?? input.partyId ?? null;
    const party = knownPartyId
      ? await this.assertPartyAccess(user, knownPartyId, opts.recordAuthorised)
      : null;

    let templateAssetId: string | undefined;
    if (input.templateName) {
      const key = templateKey(input.templateName, input.languageCode);
      if (!key) {
        throw new BadRequestException(
          'Sending a template needs its name and its language code, for example en_US.',
        );
      }
      const asset = await this.prisma.integrationAsset.findFirst({
        where: {
          organisationId: user.organisationId,
          kind: TEMPLATE_ASSET_KIND,
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
      // Whether it may actually be SENT is loadApprovedTemplate's decision
      // inside queue(), which is the provider's verdict and its age.
      templateAssetId = asset.id;
    }

    const targetStoreId = await this.resolveBareNumberStore(user, party?.storeId ?? null);
    const conversation = await this.findOrCreateContactThread(user, {
      normalized,
      partyId: party?.id ?? null,
      storeId: targetStoreId,
    });
    // A pre-existing thread may still point at a branch that has since closed,
    // or at the import holding bucket created before that distinction existed.
    // Starting a fresh outbound exchange there would turn historical routing
    // metadata into a new operational write.
    if (conversation.storeId) {
      this.scope.assertStoreAllowed(user, conversation.storeId);
      await this.scope.assertTradingStore(conversation.storeId);
    }

    return this.queue(user, conversation.id, {
      purpose: input.purpose,
      body: input.body,
      templateAssetId,
      templateComponents: input.templateComponents,
      idempotencyKey: input.idempotencyKey,
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    } as QueueOmnichannelMessageDto & { campaignId?: string }, document, opts.recordAuthorised);
  }

  /**
   * Whether this channel can reach anybody for this tenant, in the shape the
   * pure policy takes.
   *
   * A dry-run channel counts as deliverable ON PURPOSE. The path is complete
   * and running it is how a tenant checks a template before their sending
   * domain is verified; the adapter reports `dryRun` on the result and the
   * message is never recorded as sent. Refusing here instead would make the
   * unconfigured state indistinguishable from an unbuilt one.
   */
  private async channelDeliverable(organisationId: string, channel: string) {
    const state = await this.adapters.deliverability(organisationId, channel);
    return { deliverable: state.state !== 'unavailable', reason: state.reason };
  }

  /**
   * The thread for a number, created only if this tenant has none.
   *
   * Keyed on `@@unique([organisationId, channel, externalThreadId])`, the same
   * key inbound uses, so an outbound-first message and the customer's reply land
   * in one thread instead of two. A concurrent create loses the race harmlessly
   * and re-reads the winner.
   */
  private async findOrCreateContactThread(
    user: AuthUser,
    input: { normalized: string; partyId: string | null; storeId: string | null },
  ) {
    const where = {
      organisationId_channel_externalThreadId: {
        organisationId: user.organisationId,
        channel: 'whatsapp',
        externalThreadId: input.normalized,
      },
    };
    const existing = await this.prisma.conversation.findUnique({ where });
    if (existing) return existing;
    try {
      return await this.prisma.conversation.create({
        data: {
          organisationId: user.organisationId,
          channel: 'whatsapp',
          externalThreadId: input.normalized,
          partyId: input.partyId,
          storeId: input.storeId,
          handling: 'human',
          assignedUserId: user.id,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.conversation.findUnique({ where });
      if (!raced) throw error;
      return raced;
    }
  }

  /**
   * Pick an operational branch for an outbound-first, bare-number thread.
   *
   * A customer's branch wins. For an unknown number a single active physical
   * branch in the caller's scope is unambiguous; broad users with several
   * branches keep an organisation-level thread instead of silently using the
   * first (which may be the import holding bucket).
   */
  private async resolveBareNumberStore(
    user: AuthUser,
    partyStoreId: string | null,
  ): Promise<string | null> {
    if (partyStoreId) {
      this.scope.assertStoreAllowed(user, partyStoreId);
      await this.scope.assertTradingStore(partyStoreId);
      return partyStoreId;
    }

    if (!user.storeIds.length) return null;
    const candidates = await this.prisma.store.findMany({
      where: {
        id: { in: user.storeIds },
        organisationId: user.organisationId,
        isAggregate: false,
        isHolding: false,
        attendanceOnly: false,
        status: 'active',
        isActive: true,
      },
      select: { id: true },
      take: 2,
    });
    return candidates.length === 1 ? candidates[0].id : null;
  }

  /**
   * Queue a policy-checked outbound message. Existing CRM/AI queued messages are
   * also discovered by sweepQueued, so adoption does not require rewriting
   * every producer in one release.
   */
  async queue(
    user: AuthUser,
    conversationId: string,
    /*
     * `campaignId` is intersected here rather than added to the DTO itself.
     * The DTO is the shape of a request body and the pipe rejects unknown
     * fields, so putting it there would let any caller of the send endpoint
     * tag a message as part of somebody's broadcast. Only this module's own
     * callers can pass it.
     */
    input: QueueOmnichannelMessageDto & { campaignId?: string },
    document?: QueuedDocument,
    recordAuthorised = false,
  ) {
    const conversation = await this.conversations.assertCanAccess(user, conversationId, recordAuthorised);
    if (!input.body?.trim() && !input.templateAssetId) {
      throw new BadRequestException('A message body or approved template is required.');
    }
    if (document && !document.storageKey.startsWith(`org/${user.organisationId}/`)) {
      throw new BadRequestException('That document does not belong to this organisation.');
    }
    this.assertComponentsBounded(input.templateComponents);

    const template = input.templateAssetId
      ? await this.loadApprovedTemplate(user.organisationId, input.templateAssetId)
      : null;
    const consent = conversation.partyId
      ? await this.resolveConsent(
          user.organisationId,
          conversation.partyId,
          conversation.channel,
          input.purpose,
        )
      : ({ state: 'unknown' } as ConsentSnapshot);
    const decision = evaluateDeliveryPolicy({
      channel: conversation.channel,
      purpose: input.purpose,
      consent: consent.state,
      hasApprovedTemplate: !!template,
      lastInboundAt: conversation.lastInboundAt,
      marketingConsentBasis: await this.marketingConsentBasis(user.organisationId),
      channelDeliverable: await this.channelDeliverable(
        user.organisationId,
        conversation.channel,
      ),
    });
    if (!decision.allowed) throw new BadRequestException(decision.reason);
    if (input.purpose === 'marketing' && !conversation.partyId) {
      throw new BadRequestException('Marketing messages require a customer with recorded consent.');
    }
    await this.resolveRecipient(user.organisationId, conversation);

    const messageId = randomUUID();
    const now = new Date();
    const dedupeKey = input.idempotencyKey
      ? `omnichannel:queue:${input.idempotencyKey}`
      : null;
    const instructions: MessageInstructions = {
      purpose: input.purpose,
      ...(template ? { templateAssetId: template.id } : {}),
      ...(input.templateComponents ? { templateComponents: input.templateComponents } : {}),
      ...(document ? { document } : {}),
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      queuedAt: now.toISOString(),
    };

    let message: Awaited<ReturnType<PrismaService['message']['create']>>;
    let deduplicated = false;
    try {
      message = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            id: messageId,
            organisationId: user.organisationId,
            conversationId,
            direction: 'outbound',
            authorType: 'agent',
            authorUserId: user.id,
            body: input.body?.trim() || null,
            // Never a URL: the document is private and is uploaded straight to
            // the provider at delivery. The type is what the inbox shows.
            ...(document ? { mediaType: 'document' } : {}),
            status: 'queued',
            payload: { omnichannel: instructions } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: now,
            handling: 'human',
            assignedUserId: conversation.assignedUserId ?? user.id,
          },
        });
        await tx.activityEvent.create({
          data: {
            organisationId: user.organisationId,
            storeId: conversation.storeId,
            partyId: conversation.partyId,
            actorUserId: user.id,
            type: 'message.queued',
            summary: `${user.name} queued a ${input.purpose} message on ${conversation.channel}`,
            entityType: 'Message',
            entityId: created.id,
            channel: conversation.channel,
            dedupeKey,
            metadata: compactJson({
              purpose: input.purpose,
              templateAssetId: template?.id,
              document: document?.filename,
            }),
          },
        });
        return created;
      });
    } catch (error) {
      if (!dedupeKey || !isUniqueViolation(error)) throw error;
      const prior = await this.prisma.activityEvent.findFirst({
        where: {
          organisationId: user.organisationId,
          dedupeKey,
          type: 'message.queued',
          entityType: 'Message',
        },
        select: { entityId: true },
      });
      if (!prior?.entityId) {
        throw new BadRequestException('That idempotency key was already used for another operation.');
      }
      const existing = await this.prisma.message.findFirst({
        where: { id: prior.entityId, organisationId: user.organisationId, conversationId },
      });
      if (!existing) {
        throw new BadRequestException('That idempotency key belongs to another message.');
      }
      message = existing;
      deduplicated = true;
    }

    const job = await this.enqueueMessage(message.organisationId, message.id, user.id);
    return { message, job, deduplicated, policy: { mode: decision.mode } };
  }


  /**
   * Deliver a reply the assistant wrote, with no person in the loop.
   *
   * Separate from `queue()` for three reasons, each of which would be a real
   * defect if this reused that method with a synthetic principal:
   *
   *  1. `queue()` sets `handling: 'human'`, which is correct when a colleague
   *     takes a thread over and wrong here — it would silently make auto-reply
   *     fire exactly once per conversation and then go quiet forever.
   *  2. `queue()` stamps `authorUserId`, which is a foreign key to a real
   *     person. Inventing an id to satisfy it would either fail the insert or
   *     put a phantom employee's name on customer messages.
   *  3. The assistant already wrote a message row. Composing a second would
   *     leave two outbound records for one reply and make the thread read as
   *     though the customer was answered twice.
   *
   * What it does NOT do differently is safety. Consent, opt-out, the 24-hour
   * window and the approved-template rule are evaluated by the same
   * `evaluateDeliveryPolicy` on the same inputs, and delivery still happens by
   * marking the row with `payload.omnichannel` and handing it to the durable job
   * runner. There is no path here that reaches a provider directly, and a
   * refusal is returned as a reason rather than thrown, because "consent was
   * withdrawn" is an expected answer, not an incident.
   */
  /**
   * Deliver a reply a PERSON typed into the CRM inbox.
   *
   * ## Why this exists
   *
   * `ConversationsService.queueOutbound` used to write the message and stop,
   * telling the salesperson "it will not reach the customer until a messaging
   * integration is connected". That sentence was true when nothing could send.
   * With a connected number it became a lie the screen told the one person who
   * had no way to check: they typed a reply to a waiting customer, saw it
   * appear in the thread, and it went nowhere. A store manager chasing a lead
   * has no worse failure than a reply that looks sent.
   *
   * ## What it does NOT do
   *
   * It never sends outside the 24-hour customer-care window, because a reply
   * typed in a box is free text and free text is refused out there by WhatsApp,
   * not by us. It carries no template for the same reason `queueAiReply` does
   * not: a template is a pre-approved artefact chosen deliberately, and picking
   * one on a person's behalf would start a conversation they meant to continue.
   * Outside the window the message is still SAVED, and the reason comes back in
   * words the salesperson can act on.
   *
   * Consent is checked exactly as it is for every other producer here. A
   * customer who opted out is not messaged because a person rather than a bot
   * typed it.
   */
  async queueAgentReply(input: {
    organisationId: string;
    conversationId: string;
    authorUserId: string;
    body: string | null;
    /** A key in our own private storage, never a URL handed to anybody. */
    mediaUrl: string | null;
    mediaType: string | null;
    /** What the customer sees the file called; images ignore it. */
    mediaFilename?: string | null;
  }) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, organisationId: input.organisationId },
      select: {
        id: true, channel: true, partyId: true, storeId: true,
        externalThreadId: true, lastInboundAt: true,
        party: {
          select: {
            phone: true, whatsapp: true,
            contactPoints: { select: { kind: true, value: true } },
          },
        },
      },
    });
    if (!conversation) throw new BadRequestException('Conversation not found');

    const refuse = async (reason: string) => {
      // Saved, not sent, and the reason travels back with it. The agent keeps
      // their words; nobody is told they were delivered.
      const message = await this.prisma.message.create({
        data: {
          organisationId: input.organisationId,
          conversationId: conversation.id,
          direction: 'outbound',
          authorType: 'agent',
          authorUserId: input.authorUserId,
          body: input.body,
          mediaUrl: input.mediaUrl,
          mediaType: input.mediaType,
          status: 'queued',
        },
      });
      return { message, queued: false, reason, jobId: undefined as string | undefined };
    };

    if (!conversation.partyId) {
      return refuse(
        'Saved to the conversation. No customer is attached to this thread yet, so consent cannot be checked and nothing was sent.',
      );
    }

    const consent = await this.resolveConsent(
      input.organisationId,
      conversation.partyId,
      conversation.channel,
      'service',
    );

    const decision = evaluateDeliveryPolicy({
      channel: conversation.channel,
      purpose: 'service',
      consent: consent.state,
      hasApprovedTemplate: false,
      lastInboundAt: conversation.lastInboundAt,
      channelDeliverable: await this.channelDeliverable(
        input.organisationId,
        conversation.channel,
      ),
    });
    if (!decision.allowed) {
      return refuse(`Saved to the conversation, but not sent. ${decision.reason}`);
    }

    try {
      await this.resolveRecipient(input.organisationId, conversation);
    } catch (err) {
      return refuse(
        `Saved to the conversation. ${err instanceof Error ? err.message : 'No reachable address for this customer.'}`,
      );
    }

    const now = new Date();
    const instructions: MessageInstructions = {
      purpose: 'service',
      queuedAt: now.toISOString(),
      /*
       * An attached photograph travels as the same instruction a quote PDF
       * uses, so it goes down one delivery path rather than a second one
       * written beside it. `mediaUrl` on an outbound message is a key in our
       * own private storage, never a URL we hand to anybody.
       */
      ...(input.mediaUrl && input.mediaType
        ? {
            document: {
              storageKey: input.mediaUrl,
              filename: input.mediaFilename?.trim() || 'photo.jpg',
              mimeType: input.mediaType as AttachmentMime,
            },
          }
        : {}),
    };

    // Created WITH the delivery instruction, rather than written and promoted.
    // `sweepQueued` treats `payload.omnichannel` as the instruction itself, so a
    // row that carries it has unambiguously asked to be delivered.
    const message = await this.prisma.message.create({
      data: {
        organisationId: input.organisationId,
        conversationId: conversation.id,
        direction: 'outbound',
        authorType: 'agent',
        authorUserId: input.authorUserId,
        body: input.body,
        mediaUrl: input.mediaUrl,
        mediaType: input.mediaType,
        status: 'queued',
        payload: { omnichannel: instructions } as unknown as Prisma.InputJsonValue,
      },
    });

    const job = await this.enqueueMessage(input.organisationId, message.id, undefined);
    return { message, queued: true, reason: 'Sending to the customer on WhatsApp.', jobId: job?.id };
  }

  async queueAiReply(input: {
    organisationId: string;
    conversationId: string;
    /** The draft the assistant already stored. Promoted, never duplicated. */
    messageId: string;
  }): Promise<{ queued: boolean; reason: string; jobId?: string }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, organisationId: input.organisationId },
      select: {
        id: true, channel: true, partyId: true, storeId: true,
        externalThreadId: true, lastInboundAt: true,
        party: {
          select: {
            phone: true, whatsapp: true,
            contactPoints: { select: { kind: true, value: true } },
          },
        },
      },
    });
    if (!conversation) return { queued: false, reason: 'Conversation not found.' };
    if (!conversation.partyId) {
      return { queued: false, reason: 'No customer is attached, so consent cannot be checked.' };
    }

    const consent = await this.resolveConsent(
      input.organisationId,
      conversation.partyId,
      conversation.channel,
      'service',
    );

    /*
     * An assistant reply is always `service` purpose and never carries a
     * template. That is a deliberate ceiling, not an omission: a template is a
     * pre-approved marketing artefact, and letting an unattended assistant pick
     * one would let it start conversations rather than continue them. Outside
     * the 24-hour window this therefore refuses, which is the correct outcome —
     * the draft is still there for a person to send properly.
     */
    const decision = evaluateDeliveryPolicy({
      channel: conversation.channel,
      purpose: 'service',
      consent: consent.state,
      hasApprovedTemplate: false,
      lastInboundAt: conversation.lastInboundAt,
      channelDeliverable: await this.channelDeliverable(
        input.organisationId,
        conversation.channel,
      ),
    });
    if (!decision.allowed) {
      return { queued: false, reason: decision.reason ?? 'Delivery policy refused this message.' };
    }

    try {
      await this.resolveRecipient(input.organisationId, conversation);
    } catch (err) {
      return {
        queued: false,
        reason: err instanceof Error ? err.message : 'No reachable address for this customer.',
      };
    }

    const now = new Date();
    const instructions: MessageInstructions = {
      purpose: 'service',
      queuedAt: now.toISOString(),
    };

    // Promote the existing draft in place. The guard on `status: 'draft'` makes
    // a concurrent second attempt a no-op rather than a second send.
    const promoted = await this.prisma.message.updateMany({
      where: {
        id: input.messageId,
        organisationId: input.organisationId,
        conversationId: conversation.id,
        status: 'draft',
      },
      data: {
        status: 'queued',
        payload: { omnichannel: instructions } as unknown as Prisma.InputJsonValue,
      },
    });
    if (promoted.count === 0) {
      return { queued: false, reason: 'The draft was already sent, approved or withdrawn.' };
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now },
    });

    await this.prisma.activityEvent.create({
      data: {
        organisationId: input.organisationId,
        storeId: conversation.storeId,
        partyId: conversation.partyId,
        type: 'message.queued',
        summary: 'The assistant replied automatically and the message was queued for delivery.',
        entityType: 'Message',
        entityId: input.messageId,
        channel: conversation.channel,
        dedupeKey: `ai-autoreply:${input.messageId}`,
        metadata: compactJson({ purpose: 'service', automatic: true }),
      },
    });

    const job = await this.enqueueMessage(input.organisationId, input.messageId, undefined);
    return { queued: true, reason: 'Queued for delivery.', jobId: job?.id };
  }

  /**
   * Queue a notice from the business to one of its own staff — the morning
   * digest — through the same outbox a customer message uses.
   *
   * The digest used to call the provider directly: no outbox row, no durable
   * retry, no dead letter, no delivery receipt, and a failure was a line in a
   * log. Everything below is the customer path, with the two differences an
   * employee genuinely needs:
   *
   *  - THE DESTINATION IS A PERSON ON THE STAFF, NOT A NUMBER. It is read from an
   *    active, approved user of this organisation — never from a value a caller
   *    supplies — and read AGAIN by the worker, so somebody deactivated between
   *    the queue and the send is not messaged.
   *  - THE THREAD IS A STAFF THREAD. `audience: 'staff'`, keyed so that no inbound
   *    sender can ever land in it, and kept out of the customer inbox and its
   *    figures.
   *
   * Consent is not waived: an employee who is also a customer and has opted out
   * on that record is refused like anyone else. Refusals are returned rather than
   * thrown, because "no approved template" on a scheduler run is an expected
   * answer, not an incident.
   */
  async queueStaffNotice(input: {
    organisationId: string;
    /** The branch the notice belongs to, and so the number it leaves from. */
    storeId: string;
    recipientUserId: string;
    templateName: string;
    languageCode: string;
    templateComponents: unknown[];
    /** Stable per notice, so a scheduler retry resolves to the same message. */
    idempotencyKey: string;
    /** What the outbox row shows. No customer detail — it is read on a lock screen. */
    summary: string;
  }): Promise<StaffNoticeResult> {
    const refuse = (code: string, reason: string): StaffNoticeResult => ({
      queued: false,
      code,
      reason,
    });
    const org = input.organisationId;
    this.assertComponentsBounded(input.templateComponents);

    const staff = await this.resolveStaffRecipient(org, input.recipientUserId);
    if ('reason' in staff) return refuse('recipient_missing', staff.reason);

    const store = await this.prisma.store.findFirst({
      where: {
        id: input.storeId,
        organisationId: org,
        isAggregate: false,
        isHolding: false,
        // This goes to a member of staff, not to a customer, so an
        // attendance-only office sends its own people their digest; only the
        // import bucket has nobody to send on behalf of.
        status: { not: 'closed' },
      },
      select: { id: true },
    });
    if (!store) {
      return refuse('store_missing', 'The branch sending this notice is not part of this organisation.');
    }

    const template = await this.sendableTemplateByName(org, input.templateName, input.languageCode);
    if ('reason' in template) return refuse('template_unavailable', template.reason);

    const consent = staff.partyId
      ? await this.resolveConsent(org, staff.partyId, 'whatsapp', 'service')
      : ({ state: 'unknown' } as ConsentSnapshot);
    const decision = evaluateDeliveryPolicy({
      channel: 'whatsapp',
      purpose: 'service',
      consent: consent.state,
      hasApprovedTemplate: true,
      lastInboundAt: null,
      channelDeliverable: await this.channelDeliverable(org, 'whatsapp'),
    });
    if (!decision.allowed) return refuse(decision.code, decision.reason);

    const conversation = await this.findOrCreateStaffThread(org, store.id, staff.userId);
    const dedupeKey = `omnichannel:staff-notice:${input.idempotencyKey}`;
    const now = new Date();
    const instructions: MessageInstructions = {
      purpose: 'service',
      templateAssetId: template.id,
      templateComponents: input.templateComponents,
      queuedAt: now.toISOString(),
      staffUserId: staff.userId,
    };

    let messageId: string;
    let deduplicated = false;
    try {
      messageId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            organisationId: org,
            conversationId: conversation.id,
            direction: 'outbound',
            authorType: 'system',
            body: input.summary.slice(0, 500),
            status: 'queued',
            payload: { omnichannel: instructions } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: now },
        });
        // The dedupe key is unique: a second queue for the same notice fails
        // here and resolves to the message the first one created.
        await tx.activityEvent.create({
          data: {
            organisationId: org,
            storeId: store.id,
            type: 'message.queued',
            summary: `Staff notice queued on WhatsApp`,
            entityType: 'Message',
            entityId: created.id,
            channel: 'whatsapp',
            dedupeKey,
            metadata: compactJson({ purpose: 'service', audience: 'staff', templateAssetId: template.id }),
          },
        });
        return created.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const prior = await this.prisma.activityEvent.findFirst({
        where: { organisationId: org, dedupeKey, type: 'message.queued', entityType: 'Message' },
        select: { entityId: true },
      });
      if (!prior?.entityId) throw error;
      messageId = prior.entityId;
      deduplicated = true;
    }

    const job = await this.enqueueMessage(org, messageId, undefined);
    if (!deduplicated) {
      await this.audit.recordSystem(org, 'staff_digest', {
        action: 'omnichannel.staff_notice_queued',
        entityType: 'Message',
        entityId: messageId,
        storeId: store.id,
        summary: `Queued a WhatsApp staff notice (${input.templateName}) for delivery.`,
        metadata: { recipientUserId: staff.userId, templateAssetId: template.id, jobId: job?.id ?? null },
      });
    }
    return { queued: true, messageId, jobId: job?.id, deduplicated };
  }

  /**
   * Queue a notice the business sends a CUSTOMER on its own initiative — the
   * automatic feedback ask a week after a visit — with no person pressing send.
   *
   * `queue()` needs a signed-in person and `queueAiReply()` answers a message the
   * customer sent. This is neither, so it is its own door, and it is not a
   * shortcut: the customer's WhatsApp contact, an archived record, the
   * provider-approved template, consent and the 24-hour window are all decided
   * here exactly as they are for a colleague's message, the worker decides them
   * again before sending, and the result is an ordinary outbox message with a
   * durable job, retries, a dead letter and a delivery receipt.
   *
   * A refusal is returned with a reason rather than thrown, so the caller can do
   * the honest thing with it — put the ask in front of a person instead of
   * claiming it was sent.
   */
  async queueCustomerNotice(input: {
    organisationId: string;
    partyId: string;
    /** The branch the notice belongs to, when the customer has none of their own. */
    storeId: string | null;
    purpose: MessagePurpose;
    templateName: string;
    languageCode: string;
    templateComponents: unknown[];
    idempotencyKey: string;
    summary: string;
    automation: SystemActor;
  }): Promise<StaffNoticeResult> {
    const refuse = (code: string, reason: string): StaffNoticeResult => ({ queued: false, code, reason });
    const org = input.organisationId;
    this.assertComponentsBounded(input.templateComponents);

    const party = await this.prisma.party.findFirst({
      where: { id: input.partyId, organisationId: org },
      select: {
        id: true,
        storeId: true,
        archivedAt: true,
        phone: true,
        whatsapp: true,
        contactPoints: {
          where: { kind: { in: ['whatsapp', 'phone'] } },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { kind: true, value: true },
        },
        organisation: { select: { country: true } },
      },
    });
    if (!party) return refuse('recipient_missing', 'That customer is not part of this organisation.');
    // Archived means "take them out of the working lists". An automatic message
    // is the most working-list thing there is.
    if (party.archivedAt) return refuse('recipient_archived', 'This customer has been archived.');

    const raw =
      party.contactPoints.find((c) => c.kind === 'whatsapp')?.value ??
      party.contactPoints.find((c) => c.kind === 'phone')?.value ??
      party.whatsapp ??
      party.phone;
    const normalized = raw ? this.identity.normalize('whatsapp', raw, party.organisation?.country ?? 'IN') : null;
    if (!normalized) return refuse('recipient_missing', 'This customer has no usable WhatsApp number.');

    const template = await this.sendableTemplateByName(org, input.templateName, input.languageCode);
    if ('reason' in template) return refuse('template_unavailable', template.reason);

    const thread = await this.prisma.conversation.findUnique({
      where: {
        organisationId_channel_externalThreadId: {
          organisationId: org,
          channel: 'whatsapp',
          externalThreadId: normalized,
        },
      },
    });
    const consent = await this.resolveConsent(org, party.id, 'whatsapp', input.purpose);
    const decision = evaluateDeliveryPolicy({
      channel: 'whatsapp',
      purpose: input.purpose,
      consent: consent.state,
      hasApprovedTemplate: true,
      lastInboundAt: thread?.lastInboundAt ?? null,
      channelDeliverable: await this.channelDeliverable(org, 'whatsapp'),
    });
    if (!decision.allowed) return refuse(decision.code, decision.reason);

    const conversation = thread ?? (await this.createSystemContactThread(org, normalized, party.id, party.storeId ?? input.storeId));
    const dedupeKey = `omnichannel:system-notice:${input.idempotencyKey}`;
    const now = new Date();
    const instructions: MessageInstructions = {
      purpose: input.purpose,
      templateAssetId: template.id,
      templateComponents: input.templateComponents,
      queuedAt: now.toISOString(),
    };

    let messageId: string;
    let deduplicated = false;
    try {
      messageId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            organisationId: org,
            conversationId: conversation.id,
            direction: 'outbound',
            authorType: 'system',
            body: input.summary.slice(0, 500),
            status: 'queued',
            payload: { omnichannel: instructions } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } });
        await tx.activityEvent.create({
          data: {
            organisationId: org,
            storeId: conversation.storeId,
            partyId: party.id,
            type: 'message.queued',
            summary: `${SYSTEM_ACTORS[input.automation]} queued a WhatsApp ${input.purpose} message`,
            entityType: 'Message',
            entityId: created.id,
            channel: 'whatsapp',
            dedupeKey,
            metadata: compactJson({ purpose: input.purpose, automation: input.automation, templateAssetId: template.id }),
          },
        });
        return created.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const prior = await this.prisma.activityEvent.findFirst({
        where: { organisationId: org, dedupeKey, type: 'message.queued', entityType: 'Message' },
        select: { entityId: true },
      });
      if (!prior?.entityId) throw error;
      messageId = prior.entityId;
      deduplicated = true;
    }

    const job = await this.enqueueMessage(org, messageId, undefined);
    if (!deduplicated) {
      await this.audit.recordSystem(org, input.automation, {
        action: 'omnichannel.system_notice_queued',
        entityType: 'Message',
        entityId: messageId,
        storeId: conversation.storeId,
        summary: `Queued a WhatsApp ${input.purpose} template (${input.templateName}) for a customer.`,
        metadata: { partyId: party.id, templateAssetId: template.id, jobId: job?.id ?? null },
      });
    }
    return { queued: true, messageId, jobId: job?.id, deduplicated };
  }

  /** A customer thread opened by the business, keyed like inbound so a reply joins it. */
  private async createSystemContactThread(
    organisationId: string,
    normalized: string,
    partyId: string,
    storeId: string | null,
  ) {
    const where = {
      organisationId_channel_externalThreadId: {
        organisationId,
        channel: 'whatsapp',
        externalThreadId: normalized,
      },
    };
    try {
      return await this.prisma.conversation.create({
        data: { organisationId, channel: 'whatsapp', externalThreadId: normalized, partyId, storeId },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.conversation.findUnique({ where });
      if (!raced) throw error;
      return raced;
    }
  }

  /** A template registered under this name and language AND approved by the provider. */
  private async sendableTemplateByName(organisationId: string, name: string, languageCode: string) {
    const key = templateKey(name, languageCode);
    const asset = key
      ? await this.prisma.integrationAsset.findFirst({
          where: {
            organisationId,
            kind: TEMPLATE_ASSET_KIND,
            externalId: key,
            integration: { providerCode: 'whatsapp_cloud' },
          },
          select: { id: true },
        })
      : null;
    if (!asset) {
      return {
        reason: `No "${name}" template in "${languageCode}" is registered for this organisation. Synchronise templates first.`,
      };
    }
    try {
      return await this.loadApprovedTemplate(organisationId, asset.id);
    } catch (error) {
      return { reason: errorMessage(error) };
    }
  }

  /**
   * The WhatsApp number of an active, approved member of this organisation, or
   * the reason there is none.
   */
  private async resolveStaffRecipient(
    organisationId: string,
    userId: string,
  ): Promise<{ userId: string; recipient: string; partyId: string | null } | { reason: string }> {
    const staff = await this.prisma.user.findFirst({
      where: { id: userId, organisationId, isActive: true, approvalStatus: 'approved' },
      select: { id: true, phone: true, partyId: true, organisation: { select: { country: true } } },
    });
    if (!staff) return { reason: 'That person is not an active member of this organisation.' };
    if (!staff.phone) return { reason: 'This staff member has no phone number on file.' };
    const recipient = this.identity.normalize('whatsapp', staff.phone, staff.organisation?.country ?? 'IN');
    if (!recipient) return { reason: 'This staff member\'s phone number is not a usable WhatsApp number.' };
    return { userId: staff.id, recipient, partyId: staff.partyId };
  }

  /**
   * One staff thread per branch and person.
   *
   * Keyed `staff:<store>:<user>`, which no inbound provider id can ever equal, so
   * a reply from that employee's phone opens or finds an ordinary thread instead
   * of landing among the notices.
   */
  private async findOrCreateStaffThread(organisationId: string, storeId: string, userId: string) {
    const where = {
      organisationId_channel_externalThreadId: {
        organisationId,
        channel: 'whatsapp',
        externalThreadId: `staff:${storeId}:${userId}`,
      },
    };
    const existing = await this.prisma.conversation.findUnique({ where });
    if (existing) return existing;
    try {
      return await this.prisma.conversation.create({
        data: {
          organisationId,
          channel: 'whatsapp',
          externalThreadId: `staff:${storeId}:${userId}`,
          audience: 'staff',
          storeId,
          subject: 'Staff notices',
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.conversation.findUnique({ where });
      if (!raced) throw error;
      return raced;
    }
  }

  /**
   * Find queued rows THIS MODULE COMPOSED and give each exactly one durable job.
   *
   * The filter on `payload.omnichannel` is the whole safety of this method, so
   * it is worth saying why. `status: 'queued'` is not a request to deliver — it
   * predates this module and already means something else to two other
   * producers. `ConversationsService.queueOutbound` documents it as "'queued',
   * NOT 'sent' … nothing in this repository can deliver a message", and its API
   * response tells the caller the message "will not reach the customer until a
   * messaging integration is connected". `AiDraftsService` writes an approved
   * draft the same way, and the CRM screen and the AI draft panel both render
   * that promise back to the user as "Reply saved".
   *
   * An unfiltered sweep would turn both of those into real customer sends on the
   * next scheduler tick — every historical row included, oldest first, in every
   * tenant at once. The first minute after deploy would deliver a backlog nobody
   * re-read, against a UI still saying it had not been sent.
   *
   * So adoption is opt-in and the marker is the delivery instruction itself:
   * only a message carrying `payload.omnichannel` asked to be delivered, and it
   * carries the purpose, template and consent decision this module needs anyway.
   * Migrating the CRM and AI paths is a deliberate change to those producers —
   * their contract, their copy, their consent story — not a side effect here.
   */
  async sweepQueued(organisationId?: string, limit = 200) {
    const messages = await this.prisma.message.findMany({
      where: {
        ...(organisationId ? { organisationId } : {}),
        direction: 'outbound',
        status: 'queued',
        payload: { path: ['omnichannel'], not: Prisma.DbNull },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
      select: { id: true, organisationId: true, authorUserId: true },
    });
    let created = 0;
    let deduplicated = 0;
    for (const message of messages) {
      const job = await this.enqueueMessage(
        message.organisationId,
        message.id,
        message.authorUserId ?? undefined,
      );
      if (job.deduplicated) deduplicated++;
      else created++;
    }
    return { discovered: messages.length, created, deduplicated };
  }

  async listOutbox(user: AuthUser, opts: { status?: string; limit?: number } = {}) {
    const allowedStatuses = ['queued', 'sent', 'delivered', 'read', 'failed'];
    if (opts.status && !allowedStatuses.includes(opts.status)) {
      throw new BadRequestException(`status must be one of: ${allowedStatuses.join(', ')}.`);
    }
    const conversationScope =
      user.role === 'head_office'
        ? { OR: [{ storeId: { in: user.storeIds } }, { storeId: null }] }
        : { storeId: { in: user.storeIds } };
    const rows = await this.prisma.message.findMany({
      where: {
        organisationId: user.organisationId,
        direction: 'outbound',
        ...(opts.status ? { status: opts.status } : {}),
        conversation: { organisationId: user.organisationId, ...conversationScope },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
      include: {
        conversation: {
          select: {
            id: true,
            channel: true,
            storeId: true,
            party: { select: { id: true, name: true } },
          },
        },
      },
    });
    const keys = rows.map((row) => deliveryJobKey(user.organisationId, row.id));
    const jobs = keys.length
      ? await this.prisma.jobTask.findMany({
          where: {
            organisationId: user.organisationId,
            kind: OMNICHANNEL_DELIVERY_JOB,
            idempotencyKey: { in: keys },
          },
          select: { id: true, idempotencyKey: true, status: true, attempts: true, lastError: true, runAt: true },
        })
      : [];
    const jobsByKey = new Map(jobs.map((job) => [job.idempotencyKey, job]));
    return rows.map((row) => ({
      ...row,
      job: jobsByKey.get(deliveryJobKey(user.organisationId, row.id)) ?? null,
    }));
  }

  async retryMessage(user: AuthUser, messageId: string) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, organisationId: user.organisationId, direction: 'outbound' },
      select: { id: true, status: true, conversationId: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    await this.conversations.assertCanAccess(user, message.conversationId);
    if (['sent', 'delivered', 'read'].includes(message.status)) {
      throw new BadRequestException('A delivered message cannot be queued again.');
    }

    const key = deliveryJobKey(user.organisationId, message.id);
    const existing = await this.prisma.jobTask.findUnique({ where: { idempotencyKey: key } });
    await this.prisma.message.update({
      where: { id: message.id },
      data: { status: 'queued', error: null },
    });
    if (!existing) return this.enqueueMessage(user.organisationId, message.id, user.id);
    if (existing.status === 'pending' || existing.status === 'running') {
      return { id: existing.id, deduplicated: true, status: existing.status };
    }
    const job = await this.jobs.retry(user.organisationId, existing.id);
    if (!job) throw new BadRequestException('Delivery job cannot be retried in its current state.');
    return { id: job.id, deduplicated: false, status: job.status };
  }

  /** Apply a verified provider receipt after tenant ownership has been resolved. */
  async applyDeliveryReceipt(input: {
    organisationId: string;
    providerMessageId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    providerEventId?: string;
    occurredAt?: Date;
    error?: string;
  }) {
    const message = await this.prisma.message.findFirst({
      where: {
        organisationId: input.organisationId,
        externalId: input.providerMessageId,
        direction: 'outbound',
      },
      include: { conversation: { select: { partyId: true, storeId: true, channel: true } } },
    });
    if (!message) return { matched: false, updated: false };

    /*
     * Receipts arrive out of order, so state only ever moves forward.
     *
     * `failed` ranks alongside `sent`: both mean the provider has answered for
     * this attempt. Omitting it — as this map first did — made `failed` rank 0
     * via the `?? 0` fallback, so a late `sent` receipt for a message the
     * provider had already rejected walked it backwards from failed to sent. The
     * outbox would then show a delivered-looking message that never left, which
     * is the exact lie the rest of this module is built to avoid.
     */
    const rank: Record<string, number> = { queued: 0, sent: 1, failed: 1, delivered: 2, read: 3 };
    if (input.status !== 'failed' && (rank[message.status] ?? 0) >= rank[input.status]) {
      return { matched: true, updated: false, messageId: message.id, status: message.status };
    }
    if (input.status === 'failed' && ['delivered', 'read'].includes(message.status)) {
      return { matched: true, updated: false, messageId: message.id, status: message.status };
    }

    const error = input.status === 'failed' ? safeProviderError(input.error ?? 'Provider reported delivery failure.') : null;
    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: { status: input.status, error },
    });
    await this.activity.record({
      organisationId: input.organisationId,
      storeId: message.conversation.storeId,
      partyId: message.conversation.partyId,
      type: `message.${input.status}`,
      summary: `Provider marked a ${message.conversation.channel} message ${input.status}`,
      entityType: 'Message',
      entityId: message.id,
      channel: message.conversation.channel,
      sourceSystem: 'provider',
      occurredAt: input.occurredAt,
      dedupeKey: input.providerEventId
        ? `omnichannel:receipt:${input.providerEventId}`
        : `omnichannel:receipt:${input.providerMessageId}:${input.status}`,
      metadata: { providerMessageId: input.providerMessageId },
    });
    await this.reportCampaignOutcome(
      { id: message.id, organisationId: input.organisationId },
      input.status,
      error,
      input.occurredAt,
    );
    return { matched: true, updated: true, messageId: updated.id, status: updated.status };
  }

  /**
   * Pass one message's outcome to the campaign that queued it, if a campaign
   * did.
   *
   * Never allowed to break delivery. A broadcast's bookkeeping failing is not a
   * reason to fail — and so retry — a message the provider has already taken,
   * which would send it to the customer twice.
   */
  private async reportCampaignOutcome(
    message: { id: string; organisationId: string },
    status: 'sent' | 'delivered' | 'read' | 'failed',
    error?: string | null,
    occurredAt?: Date,
  ): Promise<void> {
    try {
      await this.campaigns.applyMessageOutcome({
        organisationId: message.organisationId,
        messageId: message.id,
        status,
        error,
        occurredAt,
      });
    } catch (err) {
      this.log.warn(
        `Message ${message.id} is ${status} but its campaign recipient was not updated: ${errorMessage(err)}`,
      );
    }
  }

  // --------------------------------------------------------------- Delivery

  private enqueueMessage(organisationId: string, messageId: string, createdById?: string) {
    return this.jobs.enqueue({
      kind: OMNICHANNEL_DELIVERY_JOB,
      organisationId,
      payload: { messageId },
      idempotencyKey: deliveryJobKey(organisationId, messageId),
      maxAttempts: DELIVERY_MAX_ATTEMPTS,
      createdById,
    });
  }

  private async deliver(payload: DeliveryJobPayload, ctx: JobContext) {
    if (!ctx.organisationId || !payload || typeof payload.messageId !== 'string') {
      throw new Error('Delivery job is missing its tenant or message id.');
    }
    const message = await this.prisma.message.findFirst({
      where: {
        id: payload.messageId,
        organisationId: ctx.organisationId,
        direction: 'outbound',
      },
      include: {
        conversation: {
          include: {
            party: {
              select: {
                id: true,
                phone: true,
                whatsapp: true,
                contactPoints: {
                  where: { kind: { in: ['whatsapp', 'phone'] } },
                  orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                  select: { kind: true, value: true },
                },
              },
            },
          },
        },
      },
    });
    if (!message) throw new Error('Outbound message no longer exists in this tenant.');
    if (['sent', 'delivered', 'read'].includes(message.status)) {
      return { delivered: true, alreadySettled: true, status: message.status };
    }

    const instructions = messageInstructions(message.payload);
    let template: Awaited<ReturnType<OmnichannelService['loadApprovedTemplate']>> | null = null;
    if (instructions.templateAssetId) {
      try {
        template = await this.loadApprovedTemplate(ctx.organisationId, instructions.templateAssetId);
      } catch (error) {
        return this.failPermanently(message, 'template_unavailable', errorMessage(error));
      }
    }
    /*
     * A staff notice's recipient is the employee, read again now: somebody
     * deactivated, or whose number changed, since the notice was queued is not
     * messaged at the old number.
     */
    const isStaffNotice = message.conversation.audience === 'staff';
    const staff = isStaffNotice
      ? instructions.staffUserId
        ? await this.resolveStaffRecipient(ctx.organisationId, instructions.staffUserId)
        : { reason: 'The staff notice does not name its recipient.' }
      : null;
    if (staff && 'reason' in staff) {
      return this.failPermanently(message, 'recipient_missing', staff.reason);
    }
    const consentPartyId = staff ? staff.partyId : message.conversation.partyId;
    const consent = consentPartyId
      ? await this.resolveConsent(
          ctx.organisationId,
          consentPartyId,
          message.conversation.channel,
          instructions.purpose,
        )
      : ({ state: 'unknown' } as ConsentSnapshot);
    const policy = evaluateDeliveryPolicy({
      channel: message.conversation.channel,
      purpose: instructions.purpose,
      consent: consent.state,
      hasApprovedTemplate: !!template,
      lastInboundAt: message.conversation.lastInboundAt,
      marketingConsentBasis: await this.marketingConsentBasis(ctx.organisationId),
      // The worker is the authority, so the check happens here and not only
      // where the message was queued: a queued message can be days old and the
      // connection it depended on may have been revoked since.
      channelDeliverable: await this.channelDeliverable(
        ctx.organisationId,
        message.conversation.channel,
      ),
    });
    if (!policy.allowed) return this.failPermanently(message, policy.code, policy.reason);
    if (instructions.purpose === 'marketing' && !message.conversation.partyId) {
      return this.failPermanently(
        message,
        'consent_required',
        // Says the actual condition. It used to read "requires a customer with
        // recorded consent", which sent somebody looking for a consent record
        // when the thread simply was not linked to a customer at all.
        'This conversation is not linked to a customer, so a marketing message cannot be sent on it.',
      );
    }
    /*
     * An attachment is delivered from `instructions.document`, which names a
     * key in our own private storage. A media message carrying no instruction
     * has no bytes we can fetch — an older queued row, or an inbound media URL
     * copied onto an outbound message — so it still stops here instead of
     * going out as bare text and being reported as delivered. A photograph
     * that HAS its instruction and no caption is a message in its own right.
     */
    const content = evaluateSendableContent({
      hasApprovedTemplate: !!template,
      body: message.body,
      hasAttachmentInstruction: !!instructions.document,
      claimsAttachment: !!(message.mediaUrl || message.mediaType),
    });
    if (!content.sendable) {
      return this.failPermanently(message, content.code, content.reason);
    }
    let documentBytes: Buffer | null = null;
    if (instructions.document) {
      documentBytes = await this.storage.readPrivate(
        ctx.organisationId,
        instructions.document.storageKey,
      );
      if (!documentBytes) {
        return this.failPermanently(
          message,
          'attachment_missing',
          'The document for this message is no longer stored. Send it again from its record.',
        );
      }
    }

    let recipient: string;
    if (staff) {
      recipient = staff.recipient;
    } else {
      try {
        recipient = await this.resolveRecipient(ctx.organisationId, message.conversation);
      } catch (error) {
        return this.failPermanently(message, 'recipient_missing', errorMessage(error));
      }
    }

    /*
     * WHICH NUMBER this leaves from.
     *
     * The thread's own number first — a customer who wrote to the Surat line is
     * answered from the Surat line, because that is where their 24-hour window is
     * open. A thread that has none (started from inside CaratOS, or older than
     * multi-number routing) falls back to the branch's route. With one number
     * connected both are ignored and nothing changes; with several and neither
     * set, the resolver refuses and says which branch needs mapping rather than
     * sending as the wrong one.
     *
     * WHO it is for narrows that to the numbers allowed to carry it. A customer
     * thread may NOT leave from a line marked as an internal staff line, even
     * when that is the number the thread is pinned to or the branch is mapped
     * to: a quotation arriving from the business's operations number is replied
     * to on a line where the sales bot is not listening. Staff notices keep the
     * resolution they have always had — `internalRoute` is how the digests pick
     * the operations line, and narrowing them here would refuse the
     * single-number tenants that have nowhere else to send.
     */
    const senderRoute = {
      assetId: message.conversation.senderAssetId,
      storeId: message.conversation.storeId,
      ...(isStaffNotice ? {} : { audience: 'customer' as const }),
    };

    /*
     * A template whose header is a picture has to carry that picture on EVERY
     * send. The approved template holds the file Meta reviewed, not the file
     * it delivers, so a send with body components only is malformed and Meta
     * refuses it -- 125 times in one broadcast, with a message that mentions
     * neither headers nor pictures.
     *
     * Only when nothing is attached. A message that brings its own file still
     * goes down the media path below, which has always built the header from
     * those bytes; that is why a quotation's PDF header works and why it must
     * keep winning over the template's own specimen.
     */
    let templateComponents = instructions.templateComponents;
    if (template && !instructions.document) {
      const plan = planMediaHeader(template.name ?? '', template.stored);
      if (plan.kind === 'refuse') {
        return this.failPermanently(message, 'template_header_missing', plan.reason);
      }
      if (plan.kind !== 'none') {
        const uploaded = await this.uploadHeaderMedia(ctx.organisationId, plan, senderRoute);
        if (uploaded.id === null) {
          // Transient on purpose: the picture exists, this attempt at moving it
          // did not work. Sending anyway would be refused by Meta for a reason
          // nobody could act on.
          const reason = safeProviderError(uploaded.reason);
          await this.markTransientFailure(message, reason, ctx.attempt);
          throw new Error(reason);
        }
        templateComponents = withMediaHeader(templateComponents, plan.format, uploaded.id);
      }
    }

    const result = instructions.document && documentBytes
      ? // A photograph has to arrive as an image. Sent as a document it is
        // delivered correctly and is still useless: WhatsApp shows the customer
        // a file to download rather than the ring they asked to see.
        await this.whatsapp[
          attachmentKind(instructions.document.mimeType) === 'image' ? 'sendImage' : 'sendDocument'
        ](
          ctx.organisationId,
          recipient,
          {
            buffer: documentBytes,
            filename: instructions.document.filename,
            mimeType: instructions.document.mimeType,
            caption: message.body?.trim() || undefined,
          },
          senderRoute,
          template
            ? {
                name: template.name ?? '',
                languageCode: template.metadata.languageCode,
                components: templateComponents,
              }
            : undefined,
        )
      : template
      ? await this.whatsapp.sendTemplate(
          ctx.organisationId,
          recipient,
          // `name`, not `externalId`: the latter is the local composite
          // identity (`name:language`) and Meta would not recognise it.
          template.name ?? '',
          template.metadata.languageCode,
          // A carousel's pictures are uploaded fresh for THIS send and the
          // component is appended to whatever the caller already built.
          await this.withCarousel(
            ctx.organisationId,
            template.stored,
            templateComponents,
            senderRoute,
          ),
          senderRoute,
        )
      : await this.whatsapp.sendText(
          ctx.organisationId,
          recipient,
          message.body!.trim(),
          senderRoute,
        );

    if (!result.delivered || result.dryRun || !result.messageId) {
      const reason = safeProviderError(
        result.error ?? result.reason ?? (!result.messageId ? 'Provider accepted no message id.' : 'Provider refused delivery.'),
      );
      await this.markTransientFailure(message, reason, ctx.attempt);
      throw new Error(reason);
    }

    /*
     * Pin the thread to the number that just carried it, if it had none.
     *
     * This is what makes an outbound-first conversation stable: the branch route
     * chose the number for the FIRST message, and from here every later reply
     * uses the same one even if the branch is later re-routed. A customer's
     * thread must not migrate between numbers because an administrator changed a
     * setting — that would silently start a second thread on their phone.
     *
     * Fire-and-forget: a message that has left must not be reported as failed
     * because a bookkeeping write did not land.
     */
    if (!message.conversation.senderAssetId && result.senderAssetId) {
      void this.prisma.conversation
        .updateMany({
          where: { id: message.conversationId, senderAssetId: null },
          data: { senderAssetId: result.senderAssetId },
        })
        .catch(() => undefined);
    }

    const sentAt = new Date();
    const currentPayload = jsonObject(message.payload);
    const updatedPayload = {
      ...currentPayload,
      delivery: {
        provider: 'whatsapp_cloud',
        credentialScope: result.credentialScope,
        acceptedAt: sentAt.toISOString(),
        attempt: ctx.attempt,
      },
    };
    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        status: 'sent',
        externalId: result.messageId,
        error: null,
        sentAt,
        payload: updatedPayload as Prisma.InputJsonValue,
      },
    });
    // A feedback ask counts as sent when the PROVIDER took it, not when it was
    // composed — the response rate is measured against this.
    const asked = await this.prisma.feedbackRequest.findMany({
      where: { organisationId: ctx.organisationId, messageId: message.id, sentAt: null },
      select: { id: true, checkInId: true },
    });
    if (asked.length) {
      await this.prisma.feedbackRequest.updateMany({
        where: { id: { in: asked.map((a) => a.id) } },
        data: { sentAt, status: 'sent' },
      });
      /*
       * The walk-in register's own "NPS message sent" column.
       *
       * It is a copy of what FeedbackRequest already knows, and deliberately
       * so: head office reconciles the register against their sheet, and a
       * column that is only true after a join is a column they cannot check.
       * Written here rather than at compose time for the same reason as
       * `sentAt` — the register should say what actually left the building.
       */
      const visits = asked.map((a) => a.checkInId).filter((id): id is string => !!id);
      if (visits.length) {
        await this.prisma.checkIn.updateMany({
          where: { id: { in: visits }, npsMessageSentAt: null },
          data: { npsMessageSentAt: sentAt },
        });
      }
    }
    await this.activity.record({
      organisationId: ctx.organisationId,
      storeId: message.conversation.storeId,
      partyId: message.conversation.partyId,
      type: 'message.sent',
      summary: `WhatsApp accepted an outbound ${instructions.purpose} message`,
      entityType: 'Message',
      entityId: message.id,
      channel: 'whatsapp',
      sourceSystem: 'whatsapp_cloud',
      dedupeKey: `omnichannel:sent:${message.id}`,
      metadata: { providerMessageId: result.messageId },
    });
    await this.reportCampaignOutcome(message, 'sent', null, sentAt);
    return { delivered: true, status: 'sent', messageId: message.id, providerMessageId: result.messageId };
  }

  /**
   * Put the template's header file in the phone number's media store for THIS
   * send, and hand back its media id.
   *
   * Our own copy is used when we have one. When we do not -- which is every
   * template created at Meta rather than here -- the bytes are read back from
   * the address the template sync recorded, Meta's own CDN copy of the file it
   * approved. That is the picture the client chose and the one Meta already
   * agreed to, so it is the right thing to deliver; it is fetched rather than
   * handed over as a link for the reason in `buildMediaHeaderComponent`.
   */
  private async uploadHeaderMedia(
    organisationId: string,
    plan: Extract<MediaHeaderPlan, { kind: 'stored' | 'approved' }>,
    route: { assetId?: string | null; storeId?: string | null; audience?: 'customer' },
  ): Promise<{ id: string } | { id: null; reason: string }> {
    let bytes: Buffer | null = null;
    let mimeType: string;

    if (plan.kind === 'stored') {
      bytes = await this.storage.readPrivate(organisationId, plan.storageKey);
      if (!bytes) {
        return { id: null, reason: `The template's header file is no longer stored (${plan.storageKey}).` };
      }
      mimeType = plan.storageKey.endsWith('.png') ? 'image/png' : 'image/jpeg';
    } else {
      try {
        const res = await fetch(plan.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) {
          return { id: null, reason: `The provider's copy of the header file could not be read (HTTP ${res.status}).` };
        }
        bytes = Buffer.from(await res.arrayBuffer());
        mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
      } catch (error) {
        return { id: null, reason: `The provider's copy of the header file could not be read: ${errorMessage(error)}` };
      }
    }

    const uploaded = await this.whatsapp.uploadMedia(organisationId, { buffer: bytes, mimeType }, route);
    return uploaded.id ? { id: uploaded.id } : { id: null, reason: `Header file upload failed: ${uploaded.reason}` };
  }

  /**
   * Add the carousel component to a send, uploading each card's picture.
   *
   * Nothing happens for an ordinary template: the caller's components are
   * returned untouched. For a carousel, every card's image is uploaded to the
   * phone number's media store FOR THIS SEND — a media id is short-lived, and
   * the asset handle used at creation is not accepted here.
   *
   * If any card fails, the whole carousel is abandoned and the original
   * components are returned, so the send fails at Meta with a real reason
   * rather than arriving with holes where pictures should be. A half-drawn
   * carousel is worse than a refusal.
   */
  private async withCarousel(
    organisationId: string,
    metadata: unknown,
    components: unknown[] | undefined,
    route: { assetId?: string | null; storeId?: string | null; audience?: 'customer' },
  ): Promise<unknown[] | undefined> {
    const keys = carouselImageKeys(metadata);
    if (!keys) return components;

    const media: CarouselCardMedia[] = [];
    for (const key of keys) {
      const bytes = await this.storage.readPrivate(organisationId, key);
      if (!bytes) {
        this.log.warn(`Carousel card image missing (${key}); sending without the carousel.`);
        return components;
      }
      const uploaded = await this.whatsapp.uploadMedia(
        organisationId,
        { buffer: bytes, mimeType: key.endsWith('.png') ? 'image/png' : 'image/jpeg' },
        route,
      );
      if (!uploaded.id) {
        this.log.warn(`Carousel card upload failed: ${uploaded.reason}`);
        return components;
      }
      media.push({ mediaId: uploaded.id });
    }

    const rest = (components ?? []).filter((c) => (c as { type?: string })?.type !== 'carousel');
    return [...rest, buildCarouselSendComponent(media)];
  }
  private async failPermanently(
    message: { id: string; organisationId: string; payload: unknown },
    code: string,
    reason: string,
  ) {
    const safeReason = safeProviderError(reason);
    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        status: 'failed',
        error: `${code}: ${safeReason}`.slice(0, 2000),
        payload: {
          ...jsonObject(message.payload),
          delivery: { blockedAt: new Date().toISOString(), code },
        } as Prisma.InputJsonValue,
      },
    });
    await this.reportCampaignOutcome(message, 'failed', `${code}: ${safeReason}`);
    return { delivered: false, blocked: true, code, reason: safeReason, messageId: message.id };
  }

  private async markTransientFailure(
    message: { id: string; organisationId: string; payload: unknown },
    reason: string,
    attempt: number,
  ): Promise<void> {
    const exhausted = attempt >= DELIVERY_MAX_ATTEMPTS;
    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        status: exhausted ? 'failed' : 'queued',
        error: reason.slice(0, 2000),
        payload: {
          ...jsonObject(message.payload),
          delivery: {
            failedAt: new Date().toISOString(),
            attempt,
            retrying: !exhausted,
          },
        } as Prisma.InputJsonValue,
      },
    });
    // Only once there is nothing left to try. A recipient whose message is
    // between attempts is still queued, and saying 'failed' in the meantime
    // would have a manager chasing a message that is about to go out.
    if (exhausted) await this.reportCampaignOutcome(message, 'failed', reason);
  }

  private async loadApprovedTemplate(organisationId: string, assetId: string) {
    const asset = await this.prisma.integrationAsset.findFirst({
      where: {
        id: assetId,
        organisationId,
        kind: TEMPLATE_ASSET_KIND,
        isActive: true,
        integration: { providerCode: 'whatsapp_cloud' },
      },
      include: { integration: { select: { id: true, status: true, providerCode: true } } },
    });
    if (!asset) throw new BadRequestException('Message template not found for this tenant.');
    const metadata = templateMetadata(asset.metadata);
    /*
     * The gate used to be `metadata.approvalStatus !== 'approved'` — one string
     * a head-office user typed into a form. It is now the provider's own verdict
     * plus how old that verdict is, because Meta pauses templates for quality
     * without telling anyone and a week-old approval is a guess.
     */
    const verdict = templateSendability({
      isActive: asset.isActive,
      providerStatus: metadata.providerStatus,
      providerSyncedAt: asset.lastVerifiedAt ?? null,
    });
    if (!verdict.sendable) throw new BadRequestException(verdict.reason);
    /*
     * `metadata` is the allow-list projection the screens read; `stored` is
     * what is actually on the row. Delivery needs the second one, because the
     * fields that say where a template's pictures live -- `headerImageKey`,
     * `cardImageKeys` -- are deliberately not part of what a browser is told,
     * and the projection drops them. Passing the projection to the deliverer
     * left `carouselImageKeys` reading a field that had already been stripped.
     */
    return { ...asset, metadata, stored: jsonObject(asset.metadata) };
  }

  private async resolveRecipient(
    organisationId: string,
    conversation: {
      externalThreadId?: string | null;
      partyId?: string | null;
      party?: {
        phone?: string | null;
        whatsapp?: string | null;
        contactPoints?: { kind: string; value: string }[];
      } | null;
    },
  ): Promise<string> {
    let party = conversation.party;
    if (!party && conversation.partyId) {
      party = await this.prisma.party.findFirst({
        where: { id: conversation.partyId, organisationId },
        select: {
          phone: true,
          whatsapp: true,
          contactPoints: {
            where: { kind: { in: ['whatsapp', 'phone'] } },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: { kind: true, value: true },
          },
        },
      });
    }
    const contact = party?.contactPoints?.find((point) => point.kind === 'whatsapp')?.value
      ?? party?.contactPoints?.find((point) => point.kind === 'phone')?.value
      ?? party?.whatsapp
      ?? party?.phone
      ?? conversation.externalThreadId;
    const digits = contact?.replace(/\D/g, '') ?? '';
    if (digits.length < 6 || digits.length > 20) {
      throw new BadRequestException('No usable WhatsApp recipient is linked to this conversation.');
    }
    return contact!;
  }

  private async assertPartyAccess(user: AuthUser, partyId: string, recordAuthorised = false) {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, ...(recordAuthorised ? { organisationId: user.organisationId } : readableParty(user)) },
      select: { id: true, storeId: true },
    });
    if (!party) throw new NotFoundException('Customer not found');
    const centralAllowed = user.role === 'head_office';
    if ((party.storeId && !user.storeIds.includes(party.storeId)) || (!party.storeId && !centralAllowed)) {
      // A 404 avoids confirming that an out-of-scope customer id exists.
      throw new NotFoundException('Customer not found');
    }
    return party;
  }

  private assertComponentsBounded(components?: unknown[]): void {
    if (!components) return;
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(components), 'utf8');
    } catch {
      throw new BadRequestException('Template components must be valid JSON.');
    }
    if (bytes > MAX_COMPONENT_BYTES) {
      throw new BadRequestException(`Template components exceed ${MAX_COMPONENT_BYTES} bytes.`);
    }
  }
}

function deliveryJobKey(organisationId: string, messageId: string): string {
  return `omnichannel:deliver:${organisationId}:${messageId}`;
}

function messageInstructions(value: unknown): MessageInstructions {
  const root = jsonObject(value);
  const raw = jsonObject(root.omnichannel);
  const document = queuedDocument(raw.document);
  return {
    purpose: raw.purpose === 'marketing' ? 'marketing' : 'service',
    ...(typeof raw.templateAssetId === 'string' ? { templateAssetId: raw.templateAssetId } : {}),
    ...(Array.isArray(raw.templateComponents) ? { templateComponents: raw.templateComponents } : {}),
    ...(document ? { document } : {}),
    ...(typeof raw.queuedAt === 'string' ? { queuedAt: raw.queuedAt } : {}),
    ...(typeof raw.staffUserId === 'string' ? { staffUserId: raw.staffUserId } : {}),
  };
}

function queuedDocument(value: unknown): QueuedDocument | null {
  const raw = jsonObject(value);
  return typeof raw.storageKey === 'string' &&
    typeof raw.filename === 'string' &&
    raw.mimeType === 'application/pdf'
    ? { storageKey: raw.storageKey, filename: raw.filename, mimeType: 'application/pdf' }
    : null;
}

function templateMetadata(value: unknown): TemplateMetadata {
  const raw = jsonObject(value);
  return {
    channel: 'whatsapp',
    languageCode: typeof raw.languageCode === 'string' ? raw.languageCode : 'en',
    category:
      raw.category === 'authentication' || raw.category === 'marketing'
        ? raw.category
        : 'utility',
    approvalStatus:
      raw.approvalStatus === 'approved' ||
      raw.approvalStatus === 'pending' ||
      raw.approvalStatus === 'rejected' ||
      raw.approvalStatus === 'paused' ||
      raw.approvalStatus === 'disabled'
        ? raw.approvalStatus
        : 'pending',
    // Anything unrecognised, and every row written before template sync existed,
    // reads as UNKNOWN with no verdict time — which is not sendable.
    providerStatus: providerTemplateStatus(raw.providerStatus),
    providerSyncedAt: typeof raw.providerSyncedAt === 'string' ? raw.providerSyncedAt : null,
    ...(typeof raw.bodyPreview === 'string' ? { bodyPreview: raw.bodyPreview } : {}),
    ...(typeof raw.bodySource === 'string' ? { bodySource: raw.bodySource } : {}),
    ...(Array.isArray(raw.bodyExamples)
      ? {
          bodyExamples: raw.bodyExamples.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : {}),
    /*
     * The rest of the message. This projection is an ALLOW-LIST — anything not
     * named here is dropped on the way out, which is how the picture, the
     * footer and the buttons reached the database and never reached the
     * screen. Adding a metadata field means adding it in both places.
     */
    ...(typeof raw.isCarousel === 'boolean' ? { isCarousel: raw.isCarousel } : {}),
    ...(typeof raw.headerFormat === 'string' ? { headerFormat: raw.headerFormat } : {}),
    ...(typeof raw.headerText === 'string' ? { headerText: raw.headerText } : {}),
    ...(typeof raw.headerImageUrl === 'string' ? { headerImageUrl: raw.headerImageUrl } : {}),
    ...(typeof raw.footerText === 'string' ? { footerText: raw.footerText } : {}),
    ...(Array.isArray(raw.buttons)
      ? {
          buttons: raw.buttons
            .map((b) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {}))
            .filter((b) => typeof b.text === 'string')
            .map((b) => ({
              type: b.type === 'URL' ? ('URL' as const) : ('QUICK_REPLY' as const),
              text: String(b.text),
              ...(typeof b.url === 'string' ? { url: b.url } : {}),
            })),
        }
      : {}),
    variables: Array.isArray(raw.variables)
      ? raw.variables.filter((item): item is string => typeof item === 'string')
      : [],
    recordedAt: typeof raw.recordedAt === 'string' ? raw.recordedAt : '',
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactJson(value: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Prisma.InputJsonObject;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code === 'P2002'
    : (error as { code?: string } | null)?.code === 'P2002';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeProviderError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|token|secret)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 1800);
}

