import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { StorageService } from '../storage/storage.service';
import { LeadSource, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ResponseSlaService } from './response-sla.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SequenceService } from '../common/sequence.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped } from '../common/sales-scope';
import { ActivityService } from './activity.service';
import { IdentityService, ContactKind } from './identity.service';
import { AdSetRulesService, type AdSetRoutingContext } from './adset-rules.service';
import { AttributionService } from './attribution.service';
import { RequalificationService } from './requalification.service';
import { AdvancedCrmService } from './advanced-crm.service';
import { LeadIntakeService } from './lead-intake.service';
import type { AdReferral } from '../integration/contracts/ad-referral';

/**
 * ConversationsService — the unified inbox (Phase A3).
 *
 * Channel-neutral by construction: nothing here knows what WhatsApp or Instagram
 * is. A channel adapter (Phase A5/A6) calls `ingestInbound` with a normalised
 * message and this decides threading, identity and AI-vs-human handling. Adding
 * a channel therefore means writing an adapter, not touching this file.
 *
 * OUTBOUND SENDING IS NOT IMPLEMENTED HERE. `queueOutbound` records the message
 * and marks it 'queued'; actually delivering it needs a provider integration
 * with real credentials, which does not exist yet. A queued message is honestly
 * labelled as such rather than being reported 'sent' by a function that never
 * contacted a provider.
 */

const HANDLING = ['ai', 'human', 'unassigned'];
const STATUSES = ['open', 'snoozed', 'closed'];

export interface InboundMessage {
  organisationId: string;
  channel: string;
  /** Provider thread id. Falls back to the sender identity when absent. */
  externalThreadId?: string;
  /** Provider message id — the webhook idempotency key. */
  externalId?: string;
  /** How the sender identifies on this channel. */
  senderKind: ContactKind;
  senderValue: string;
  body?: string;
  mediaUrl?: string;
  mediaType?: string;
  sentAt?: Date;
  storeId?: string | null;
  integrationId?: string | null;
  /**
   * WHICH of the tenant's numbers this arrived on.
   *
   * Recorded on the conversation so every reply leaves from the same number. A
   * tenant with eight numbers across two accounts would otherwise answer from
   * whichever was registered first, which starts a second thread on the
   * customer's phone and reads to them as a different business.
   */
  senderAssetId?: string | null;
  payload?: Prisma.InputJsonValue;
  /**
   * The adapter recognised this message as an unambiguous opt-out.
   *
   * The message is still filed — a withdrawal of consent is exactly the thing a
   * human must be able to see in the inbox — but nothing may act on it as sales
   * intent. Re-scoring someone who just asked to be left alone is how an
   * opted-out customer ends up at the top of a call list.
   */
  optOut?: boolean;
  /** Normalised campaign metadata supplied by the channel adapter. */
  routing?: AdSetRoutingContext;
  /**
   * The ad click this message came from, if the adapter measured one.
   *
   * Provider-neutral (`AdReferral`) so the inbox stays channel-agnostic. Absent
   * for the overwhelming majority of messages — only the first message of an
   * ad-originated thread carries one, and absence is never treated as organic.
   */
  adReferral?: AdReferral | null;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly activity: ActivityService,
    private readonly identity: IdentityService,
    private readonly adSetRules: AdSetRulesService,
    private readonly attribution: AttributionService,
    private readonly sequence: SequenceService,
    private readonly audit: AuditService,
    private readonly requalification: RequalificationService,
    private readonly advanced: AdvancedCrmService,
    private readonly intake: LeadIntakeService,
    private readonly sla: ResponseSlaService,
    @Inject(forwardRef(() => OmnichannelService))
    private readonly omnichannel: OmnichannelService,
    private readonly storage: StorageService,
  ) {}

  private readonly logger = new Logger(ConversationsService.name);

  /**
   * Accept an inbound message from a channel adapter.
   *
   * Idempotent on `externalId`: a redelivered webhook returns the message that
   * already exists instead of creating a second copy. Providers retry for days,
   * so this is the difference between one conversation and forty.
   *
   * Takes an organisationId rather than an AuthUser because the caller is a
   * webhook, not a person — the tenant has already been established by the
   * integration the webhook arrived on, never by anything in the payload.
   */
  async ingestInbound(msg: InboundMessage) {
    const organisationId = msg.organisationId;
    const ref = msg.adReferral ?? null;

    // The measured ad ids take precedence over anything the adapter guessed:
    // a rule must fire on what the provider actually reported.
    const routingContext: AdSetRoutingContext | undefined =
      ref || msg.routing
        ? {
            ...(msg.routing ?? {}),
            ...(ref?.adId ? { adId: ref.adId } : {}),
            ...(ref?.adSetId ? { adSetId: ref.adSetId } : {}),
          }
        : undefined;
    const route = await this.adSetRules.resolve(organisationId, routingContext);

    if (msg.externalId) {
      const seen = await this.prisma.message.findUnique({
        where: { organisationId_externalId: { organisationId, externalId: msg.externalId } },
        select: { id: true, conversationId: true },
      });
      if (seen) {
        return { duplicate: true as const, messageId: seen.id, conversationId: seen.conversationId };
      }
    }

    // Identity: who is this? Tenant-scoped by the unique key — a lookup can
    // never reach another organisation's customer even when two tenants have the
    // same number on file.
    const normalized = await this.normalizeSender(organisationId, msg);
    let holder = normalized
      ? await this.prisma.contactPoint.findUnique({
          where: {
            organisationId_kind_valueNormalized: {
              organisationId,
              kind: msg.senderKind,
              valueNormalized: normalized,
            },
          },
          select: { partyId: true },
        })
      : null;

    // An ad click is different from ordinary inbound traffic: the person tapped
    // an ad and opened a chat, so they ARE a customer contact and their number
    // is right there. Leaving that anonymous produced a lead with no phone on
    // it, which is a lead nobody can call.
    //
    // Ordinary (non-ad) messages deliberately keep the old behaviour and stay
    // anonymous until a person attaches them — this does not create a customer
    // for every wrong number that texts the business.
    if (!holder?.partyId && ref && normalized) {
      const resolved = await this.identity.resolveInbound(organisationId, {
        kind: msg.senderKind,
        value: msg.senderValue,
        storeId: route?.storeId ?? null,
        source: 'ctwa',
      });
      if (resolved.partyId) holder = { partyId: resolved.partyId };
    }

    const threadKey = msg.externalThreadId ?? normalized ?? null;
    if (!threadKey) {
      throw new BadRequestException(
        'An inbound message needs either a thread id or a readable sender identity.',
      );
    }

    // 1C: what does this thread already look like? A conversation that has
    // ALREADY been routed keeps its store and owner — a customer who clicks a
    // second ad next week must not silently move an active thread (and its
    // history, and its owner's pipeline) to another branch.
    const priorThread = await this.prisma.conversation.findUnique({
      where: {
        organisationId_channel_externalThreadId: {
          organisationId,
          channel: msg.channel,
          externalThreadId: threadKey,
        },
      },
      select: { id: true, storeId: true, matchedRuleId: true, handling: true, assignedUserId: true },
    });

    /**
     * 1A — is this thread genuinely nobody's yet?
     *
     * The previous test was `!matchedRuleId`, which is WRONG: a conversation a
     * manager assigned by hand has no matched rule, so a later ad would happily
     * seize a thread that already had a store, an owner and a human handling it.
     *
     * Operationally unassigned means all four are absent — no store, no
     * assignee, handling still 'unassigned', and no rule. Any one of them means
     * somebody (a person or an earlier rule) already owns this, and first
     * ownership wins until an authorised user resolves it.
     */
    const operationallyUnassigned =
      !priorThread ||
      (!priorThread.storeId &&
        !priorThread.assignedUserId &&
        priorThread.handling === 'unassigned' &&
        !priorThread.matchedRuleId);

    const applyRoute = Boolean(route) && operationallyUnassigned;

    /**
     * A later ad wanted something DIFFERENT from what this thread already has —
     * a different branch, a different owner, or a different handling mode. Any
     * of those is a decision for a person, not something to apply silently.
     * A later ad that agrees with the current state is not a conflict.
     */
    const routingConflict = Boolean(
      route &&
        priorThread &&
        !operationallyUnassigned &&
        ((route.storeId && route.storeId !== priorThread.storeId) ||
          (route.assignedUserId && route.assignedUserId !== priorThread.assignedUserId) ||
          (route.handling && route.handling !== priorThread.handling)),
    );

    const conversation = await this.prisma.conversation.upsert({
      where: {
        organisationId_channel_externalThreadId: {
          organisationId,
          channel: msg.channel,
          externalThreadId: threadKey,
        },
      },
      create: {
        organisationId,
        channel: msg.channel,
        externalThreadId: threadKey,
        partyId: holder?.partyId ?? null,
        storeId: route?.storeId ?? msg.storeId ?? null,
        integrationId: msg.integrationId ?? null,
        status: 'open',
        handling: route?.handling ?? 'unassigned',
        assignedUserId: route?.assignedUserId ?? null,
        handoffReason: route?.handling === 'human'
          ? `Automation rule "${route.ruleName}" routes this conversation to a person.`
          : null,
        lastMessageAt: msg.sentAt ?? new Date(),
        lastInboundAt: msg.sentAt ?? new Date(),
        senderAssetId: msg.senderAssetId ?? null,
        sourceAdId: ref?.adId ?? null,
        sourceAdSetId: ref?.adSetId ?? null,
        sourceCampaignId: ref?.campaignId ?? null,
        sourceClickId: ref?.clickId ?? null,
        matchedRuleId: route?.ruleId ?? null,
      },
      update: {
        // A thread that was closed and gets a new message is open again — a
        // customer replying to a resolved conversation is not resolved.
        status: 'open',
        lastMessageAt: msg.sentAt ?? new Date(),
        lastInboundAt: msg.sentAt ?? new Date(),
        // Fill in the customer if the thread was anonymous and now resolves.
        ...(holder?.partyId ? { partyId: holder.partyId } : {}),
        /*
         * THE SENDER MOVES WITH THE CUSTOMER; THE BRANCH DOES NOT.
         *
         * A thread is keyed on the customer's own number, so a customer who
         * writes to two of the tenant's numbers lands in ONE conversation. The
         * number to answer on is the one they last wrote to, because that is
         * where their 24-hour customer-care window is open — replying on the
         * other one needs an approved template and arrives as a different
         * business.
         *
         * Deliberately unlike `storeId`, which is set once and never re-routed:
         * moving an active thread (and its history, and its owner's pipeline) to
         * another branch is a decision for a person. Which NUMBER carries the
         * reply is not — it is dictated by where the customer just wrote.
         */
        ...(msg.senderAssetId ? { senderAssetId: msg.senderAssetId } : {}),
        // The ad origin is deliberately NOT updated here. It is set once, when
        // the thread is created, so a customer who later clicks a second ad does
        // not rewrite the ad that originated the conversation — first-touch
        // attribution would otherwise drift to the most recent click. A referral
        // on a later message is still preserved on the Message payload and on
        // its own AttributionTouch, so nothing is lost.
        ...(applyRoute && route ? {
          matchedRuleId: route.ruleId,
          storeId: route.storeId,
          assignedUserId: route.assignedUserId,
          handling: route.handling,
          handoffReason: route.handling === 'human'
            ? `Automation rule "${route.ruleName}" routes this conversation to a person.`
            : null,
        } : {}),
        // A conflicting later ad raises a flag for a person instead of moving
        // the thread. The store, the owner and the handling all stay put.
        ...(routingConflict ? { routingReviewRequired: true } : {}),
      },
      select: { id: true, partyId: true, storeId: true },
    });

    /**
     * 1D — the pre-check above is an optimisation; THIS is the authority.
     *
     * Two simultaneous deliveries of the same provider message both pass the
     * `findUnique` (neither has committed yet) and both arrive here. The unique
     * index on (organisationId, externalId) settles it. The loser must return
     * the winner's message and do nothing else — creating a second lead, a
     * second attribution touch or a second AI draft for one customer message is
     * exactly the damage idempotency exists to prevent.
     */
    let message: { id: string };
    try {
      message = await this.prisma.message.create({
        data: {
          organisationId,
          conversationId: conversation.id,
          direction: 'inbound',
          authorType: 'customer',
          body: msg.body ?? null,
          mediaUrl: msg.mediaUrl ?? null,
          mediaType: msg.mediaType ?? null,
          externalId: msg.externalId ?? null,
          status: 'received',
          sentAt: msg.sentAt ?? new Date(),
          payload: msg.payload,
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        msg.externalId
      ) {
        const winner = await this.prisma.message.findUnique({
          where: { organisationId_externalId: { organisationId, externalId: msg.externalId } },
          select: { id: true, conversationId: true },
        });
        if (winner) {
          return {
            duplicate: true as const,
            messageId: winner.id,
            conversationId: winner.conversationId,
          };
        }
      }
      throw err;
    }

    await this.activity.record({
      organisationId,
      type: 'message.received',
      summary: `Inbound ${msg.channel} message${msg.body ? `: ${truncate(msg.body)}` : ''}`,
      partyId: conversation.partyId,
      storeId: conversation.storeId,
      channel: msg.channel,
      entityType: 'Conversation',
      entityId: conversation.id,
      // Only dedupe when the provider gave a real id; otherwise leave it null so
      // two genuinely identical messages both appear.
      dedupeKey: msg.externalId ? `message:${msg.externalId}` : null,
      occurredAt: msg.sentAt ?? new Date(),
    });

    /*
     * Start the first-response clock.
     *
     * This is the ONLY producer hook the SLA has: everything after it — whether
     * anybody replied, whether it is late, whether it has escalated — is decided
     * by a sweep reading Message rows, so a new outbound path cannot silently
     * cause false breaches. `open` is a no-op when the tenant has no target set,
     * when a clock is already running on this thread, and on a replay.
     *
     * Deliberately AFTER the message is committed, and it swallows its own
     * errors: a measurement failing must never be why a customer's message is
     * not stored.
     */
    await this.sla.open({
      organisationId,
      conversationId: conversation.id,
      storeId: conversation.storeId,
      messageId: message.id,
      at: msg.sentAt ?? new Date(),
    });

    // A later ad pointed somewhere else. Recorded as a ROW, not just a sentence:
    // the original and proposed assignment are operational state somebody has to
    // act on, and state that lives only in a log line cannot be queried,
    // counted or resolved.
    if (routingConflict && route && priorThread) {
      await this.prisma.conversationRoutingConflict.create({
        data: {
          organisationId,
          conversationId: conversation.id,
          originalStoreId: priorThread.storeId,
          originalAssignedUserId: priorThread.assignedUserId,
          originalRuleId: priorThread.matchedRuleId,
          originalHandling: priorThread.handling,
          proposedStoreId: route.storeId,
          proposedAssignedUserId: route.assignedUserId,
          proposedRuleId: route.ruleId,
          proposedRuleName: route.ruleName,
          proposedHandling: route.handling,
          sourceAdId: ref?.adId ?? null,
          sourceAdSetId: ref?.adSetId ?? null,
          sourceCampaignId: ref?.campaignId ?? null,
        },
      });
      await this.activity.record({
        organisationId,
        type: 'conversation.routing_conflict',
        summary:
          `A later ad matched rule "${route.ruleName}", which routes to a different store. ` +
          `This conversation stayed with its original store and owner and is flagged for review.`,
        partyId: conversation.partyId,
        storeId: conversation.storeId,
        channel: msg.channel,
        entityType: 'Conversation',
        entityId: conversation.id,
        occurredAt: msg.sentAt ?? new Date(),
      });
    }

    /**
     * 2A - re-score the conversation now that the customer has said something.
     *
     * Deliberately AFTER the message is committed and deliberately not awaited
     * for its result: an assessment is queued, debounced per conversation, and
     * allowed to fail without touching this request. Replays never reach here -
     * both duplicate paths returned above.
     */
    if (!msg.optOut) {
      await this.requalification.schedule(organisationId, conversation.id);
    }

    // Measured attribution for an ad-originated thread. Best-effort and after
    // the message is safely stored: marketing provenance must never be the
    // reason an inbound customer message fails to persist.
    const leadId = ref
      ? await this.recordAdOrigin(organisationId, ref, conversation, msg.externalId ?? null)
      : null;

    // A tenant may opt a location into the fair assignment queue. This runs
    // only after the inbound message and any ad-origin lead are durable; a
    // malformed policy or an empty roster can therefore never turn a successful
    // provider webhook into a retry. Explicit ad-rule owners still win because
    // the round-robin command is idempotent on an already-owned conversation.
    const automaticAssignment = conversation.storeId
      ? await this.advanced.autoAssignInbound(organisationId, conversation.id, leadId)
      : null;

    return {
      duplicate: false as const,
      messageId: message.id,
      conversationId: conversation.id,
      partyId: conversation.partyId,
      /** The lead this ad click opened, when a store was known. */
      leadId,
      /** True when the sender did not match any customer — surfaced, not hidden. */
      unidentifiedSender: !conversation.partyId,
      routing: route,
      automaticAssignment,
    };
  }

  /**
   * Record where an ad-originated conversation came from.
   *
   * Two rules govern this and they pull against each other:
   *
   *  - A CTWA click IS a lead — the person tapped an ad and opened a chat.
   *  - A Lead requires a store, and a store must NEVER be guessed.
   *
   * So a lead is created only when routing supplied a real store. With no
   * matching rule the conversation stays visible and unassigned (the referral is
   * still preserved on the row), and someone assigns it — rather than the
   * platform inventing a branch and quietly mis-crediting a city's numbers.
   *
   * The touch is written whenever it can be anchored to a party or a lead, and
   * is marked `measured` because the provider reported these ids — as distinct
   * from the `declared` touch a salesperson's source dropdown produces.
   */
  private async recordAdOrigin(
    organisationId: string,
    ref: AdReferral,
    conversation: { id: string; partyId: string | null; storeId: string | null },
    providerMessageId: string | null,
  ): Promise<string | null> {
    try {
      let leadId: string | null = null;

      if (conversation.storeId) {
        // 1A: reuse is scoped to the DESTINATION STORE, not just the tenant.
        //
        // A customer who clicks a Hyderabad ad must not have that attribution
        // attached to their open Mumbai lead — the Hyderabad branch would never
        // see the enquiry and Mumbai's numbers would absorb the credit.
        //
        // Whether one customer should instead carry a single organisation-wide
        // lead across branches is a product decision nobody has made. Store
        // scoping is the conservative reading (it cannot mis-credit a branch),
        // and the decision is recorded in docs/DECISIONS.md rather than assumed.
        const existing = conversation.partyId
          ? await this.prisma.lead.findFirst({
              where: {
                organisationId,
                partyId: conversation.partyId,
                storeId: conversation.storeId,
                outcome: 'open',
              },
              select: { id: true },
              orderBy: { createdAt: 'desc' },
            })
          : null;

        if (existing) {
          leadId = existing.id;
        } else {
          const party = conversation.partyId
            ? await this.prisma.party.findFirst({
                where: { id: conversation.partyId, organisationId },
                select: { name: true, phone: true, whatsapp: true },
              })
            : null;
          /**
           * 1C — check-then-create is NOT the concurrency protection.
           *
           * Two messages carrying the same click can arrive together, both see
           * no open lead, and both create one. `originKey` plus the unique index
           * on (organisationId, originKey) is what actually prevents that; the
           * lookup above is only an optimisation.
           *
           * The key is the CLICK where the provider gave one, because a click is
           * the thing that happened once. It falls back to the conversation when
           * there is no click id. It is NULL for every human-created lead, so
           * this constrains automatic creation only and never caps how many
           * genuine opportunities a customer may have.
           */
          const originKey = ref.clickId ? `click:${ref.clickId}` : `convo:${conversation.id}`;
          const seq = await this.sequence.next('LD:global');
          try {
            const created = await this.prisma.lead.create({
              data: {
                organisationId,
                ref: `LD-${5000 + seq}`,
                storeId: conversation.storeId,
                partyId: conversation.partyId,
                customerName: party?.name ?? 'WhatsApp customer',
                // The number the person actually messaged from. A lead nobody
                // can call is not a lead, which is what the anonymous version
                // produced.
                phone: party?.phone ?? party?.whatsapp ?? null,
                source: 'whatsapp',
                interest: ref.headline ?? null,
                originKey,
              },
              select: { id: true },
            });
            leadId = created.id;
          } catch (err) {
            // Lost the race. The other delivery created this lead; returning
            // theirs IS the correct outcome, not an error.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              const winner = await this.prisma.lead.findFirst({
                where: { organisationId, originKey },
                select: { id: true },
              });
              if (!winner) throw err;
              leadId = winner.id;
            } else {
              throw err;
            }
          }
        }
      }

      const subject = leadId ? { leadId, partyId: null } : { leadId: null, partyId: conversation.partyId };
      if (!subject.leadId && !subject.partyId) return null;

      await this.attribution.recordTouch(organisationId, {
        ...subject,
        channel: 'ad',
        source: ref.sourceType ?? 'ad',
        medium: 'click_to_message',
        externalCampaignId: ref.campaignId,
        externalAdSetId: ref.adSetId,
        externalAdId: ref.adId,
        clickId: ref.clickId,
        evidence: 'measured',
        dedupeKey: adTouchDedupeKey(ref, conversation.id, providerMessageId, subject),
        metadata: {
          conversationId: conversation.id,
          headline: ref.headline,
          sourceUrl: ref.sourceUrl,
          providerReferral: ref.raw,
        } as Prisma.InputJsonValue,
      });

      return leadId;
    } catch (err) {
      // Never fatal: the customer's message is already saved and visible.
      this.logger.error(
        `Ad origin not recorded for conversation ${conversation.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Turn an ordinary conversation into a sales lead, because a person said so.
   *
   * Inbound WhatsApp traffic deliberately creates no lead. Most of it is not a
   * sales enquiry — it is a delivery question, a wrong number, someone asking
   * the closing time — and opening a lead for each would fill the pipeline with
   * work nobody should chase and make every conversion rate meaningless.
   *
   * So the judgement stays with the human who read the message, and this is the
   * command they issue. It is idempotent on the conversation: pressing the
   * button twice, or two people pressing it at once, yields one lead and the
   * second caller is told it already exists.
   *
   * Everything after the decision is the SAME pipeline every other door uses —
   * identity, routing, follow-ups, audit, fair queue — so a converted
   * conversation is indistinguishable downstream from a lead that arrived any
   * other way.
   */
  async convertToLead(
    user: AuthUser,
    conversationId: string,
    input: { storeId?: string | null; interest: string; customerName?: string },
  ) {
    const conversation = await this.load(user, conversationId);

    // The branch: the thread's own, or one the caller names and is allowed to
    // use. Never guessed — an unrouted thread converted with no branch would
    // produce a lead no branch owns.
    const storeId = input.storeId ?? conversation.storeId;
    if (!storeId) {
      throw new BadRequestException(
        'Route this conversation to a branch before converting it, or choose one here.',
      );
    }
    this.scope.assertStoreAllowed(user, storeId);
    if (input.storeId) {
      const target = await this.prisma.store.findFirst({
        where: { id: input.storeId, organisationId: user.organisationId, isAggregate: false },
        select: { id: true },
      });
      if (!target) throw new BadRequestException('Choose a branch that belongs to this organisation.');
    }

    const interest = input.interest.trim();
    if (!interest) throw new BadRequestException('Say what this customer is interested in.');

    /*
     * Identify the customer if the thread never did.
     *
     * An organic thread stays anonymous until someone attaches it — that is what
     * stops every wrong number becoming a customer record. Converting IS that
     * attachment: a person has read the messages and decided this is a real
     * enquiry, so resolving the sender to a Party is now correct.
     */
    let partyId = conversation.partyId;
    let phone: string | null = null;
    if (conversation.externalThreadId) {
      const resolved = await this.identity.resolveInbound(user.organisationId, {
        kind: 'whatsapp',
        value: conversation.externalThreadId,
        name: input.customerName ?? undefined,
        storeId,
        source: 'conversation_conversion',
      });
      if (resolved.partyId) partyId = resolved.partyId;
    }
    if (partyId) {
      const party = await this.prisma.party.findFirst({
        where: { id: partyId, organisationId: user.organisationId },
        select: { name: true, phone: true, whatsapp: true },
      });
      phone = party?.phone ?? party?.whatsapp ?? null;
      if (!input.customerName && party?.name) input.customerName = party.name;
    }

    const result = await this.intake.capture({
      organisationId: user.organisationId,
      storeId,
      // Keyed on the conversation, so the button is idempotent for the life of
      // the thread rather than per click.
      originKey: `convo_convert:${conversationId}`,
      customerName: input.customerName?.trim() || 'WhatsApp customer',
      phone: phone ?? conversation.externalThreadId ?? null,
      interest,
      source: LeadSource.whatsapp,
      identitySource: 'conversation_conversion',
      summary: 'A conversation was converted into a lead.',
      auditAction: 'crm.lead_converted_from_conversation',
      systemActor: 'conversation_conversion',
      followUpNote: 'Converted conversation follow-up',
      metadata: { conversationId, convertedByUserId: user.id },
    });

    // Link the thread to the lead it produced, so the inbox can show it and a
    // second conversion attempt has something to find.
    if (!result.duplicate && partyId && !conversation.partyId) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { partyId },
      });
    }

    // The human who made the call is named here, separately from the system
    // actor that intake records for the mechanical write.
    await this.audit.record(user, {
      action: 'crm.conversation_converted',
      entityType: 'Conversation',
      entityId: conversationId,
      storeId,
      summary: result.duplicate
        ? 'Conversation was already converted; the existing lead was returned.'
        : 'Converted this conversation into a lead.',
      metadata: { leadId: result.leadId, reference: result.reference, duplicate: result.duplicate },
    });

    return result;
  }

  /**
   * Open the lead an ad click could not open, once someone supplies the branch.
   *
   * `recordAdOrigin` refuses to guess a store, so an ad-originated thread that
   * matched no routing rule stays a visible, unassigned conversation with its
   * `sourceAdId`/`sourceClickId` intact. That was the right call. What was
   * missing is the other half: when a human later routes that thread to a
   * branch, nothing opened the lead, so the click stayed attached to a
   * conversation forever and never reached the pipeline or ROAS. The enquiry was
   * visible and the marketing spend behind it was not.
   *
   * Exactly-once across BOTH paths, because it reuses the same `originKey` that
   * `recordAdOrigin` would have used — `click:<ctwa_clid>` when the provider gave
   * a click id, else `convo:<conversationId>`. The unique index on
   * (organisationId, originKey) is what enforces it; the lookups here are
   * optimisations. A thread routed, un-routed and routed again therefore yields
   * one lead, not three.
   *
   * The attribution touch is RELINKED, never re-recorded. `adTouchDedupeKey`
   * embeds the subject, so recording it again against the lead would mint a
   * different key, survive the unique index and count the same click twice in
   * ROAS. Moving the row keeps one touch per click and hands it to the lead.
   */
  private async backfillAdLeadOnAssign(
    organisationId: string,
    conversationId: string,
  ): Promise<string | null> {
    try {
      const convo = await this.prisma.conversation.findFirst({
        where: { id: conversationId, organisationId },
        select: {
          id: true,
          partyId: true,
          storeId: true,
          sourceAdId: true,
          sourceClickId: true,
        },
      });
      // Not routed yet, or never came from an ad: nothing to open.
      if (!convo?.storeId) return null;
      if (!convo.sourceAdId && !convo.sourceClickId) return null;

      const originKey = convo.sourceClickId
        ? `click:${convo.sourceClickId}`
        : `convo:${convo.id}`;

      const already = await this.prisma.lead.findFirst({
        where: { organisationId, originKey },
        select: { id: true },
      });
      if (already) return already.id;

      // Same reuse rule as the inbound path: an open lead for this customer AT
      // THIS BRANCH is the lead this click belongs to. Scoped to the store so a
      // Hyderabad click never lands on an open Mumbai enquiry.
      if (convo.partyId) {
        const open = await this.prisma.lead.findFirst({
          where: {
            organisationId,
            partyId: convo.partyId,
            storeId: convo.storeId,
            outcome: 'open',
          },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
        });
        if (open) {
          await this.relinkAdTouch(organisationId, convo.partyId, open.id);
          return open.id;
        }
      }

      const party = convo.partyId
        ? await this.prisma.party.findFirst({
            where: { id: convo.partyId, organisationId },
            select: { name: true, phone: true, whatsapp: true },
          })
        : null;

      const seq = await this.sequence.next('LD:global');
      let leadId: string;
      try {
        const created = await this.prisma.lead.create({
          data: {
            organisationId,
            ref: `LD-${5000 + seq}`,
            storeId: convo.storeId,
            partyId: convo.partyId,
            customerName: party?.name ?? 'WhatsApp customer',
            phone: party?.phone ?? party?.whatsapp ?? null,
            source: 'whatsapp',
            originKey,
          },
          select: { id: true },
        });
        leadId = created.id;
      } catch (err) {
        // A concurrent assignment, or the inbound path finally routing, won the
        // race. Returning theirs IS the correct outcome.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const winner = await this.prisma.lead.findFirst({
            where: { organisationId, originKey },
            select: { id: true },
          });
          return winner?.id ?? null;
        }
        throw err;
      }

      if (convo.partyId) await this.relinkAdTouch(organisationId, convo.partyId, leadId);

      await this.activity.record({
        organisationId,
        type: 'lead.created',
        summary: 'An ad enquiry became a lead when its branch was set.',
        partyId: convo.partyId,
        leadId,
        storeId: convo.storeId,
        entityType: 'Lead',
        entityId: leadId,
        channel: 'whatsapp',
        dedupeKey: `ad-lead-backfill:${originKey}`,
      });

      return leadId;
    } catch (err) {
      // Advisory, like every other automation on this path. The routing change
      // the user asked for has already been committed and audited; failing to
      // open the lead must not undo it.
      this.logger.error(
        `Ad lead not backfilled for conversation ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Move this customer's measured ad touches onto the lead they opened. */
  private async relinkAdTouch(organisationId: string, partyId: string, leadId: string) {
    await this.prisma.attributionTouch.updateMany({
      where: { organisationId, partyId, leadId: null, channel: 'ad' },
      // `dedupeKey` deliberately keeps its original value. It is a uniqueness
      // token for "this click, recorded once", not a description of where the
      // row currently points, and rewriting it would let the inbound path mint
      // the row a second time under the old key.
      data: { partyId: null, leadId },
    });
  }

  private async normalizeSender(organisationId: string, msg: InboundMessage): Promise<string | null> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { country: true },
    });
    return this.identity.normalize(msg.senderKind, msg.senderValue, org?.country ?? 'IN');
  }

  /**
   * 1E - the explicit assignment command.
   *
   * `update()` validated only that an assignee belonged to the ORGANISATION, so
   * a Mumbai salesperson could be given a Hyderabad thread. Routing a
   * conversation is one decision about three coupled things - where it lives,
   * who owns it, and who answers it - so it is one atomic command with one
   * validation pass, not three independent field writes.
   */
  async assign(
    user: AuthUser,
    conversationId: string,
    input: { storeId?: string | null; assignedUserId?: string | null; handling?: string; reason?: string },
  ) {
    const conversation = await this.load(user, conversationId);

    if (input.handling && !HANDLING.includes(input.handling)) {
      throw new BadRequestException(`handling must be one of: ${HANDLING.join(', ')}.`);
    }

    // The destination store must be one the CALLER may act in. A request body
    // can narrow the caller's scope; it can never widen it.
    const targetStoreId = input.storeId !== undefined ? input.storeId : conversation.storeId;
    if (targetStoreId) this.scope.assertStoreAllowed(user, targetStoreId);

    if (input.assignedUserId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: input.assignedUserId, organisationId: user.organisationId, isActive: true },
        select: { id: true, name: true },
      });
      if (!assignee) throw new NotFoundException('Assignee not found, or not active, in your organisation');

      // The gap this method exists to close: an owner must actually work at the
      // branch the conversation is being routed to.
      if (!targetStoreId) {
        throw new BadRequestException(
          'Choose a location before assigning a person - an owner has to belong to the destination.',
        );
      }
      const member = await this.prisma.userStore.findFirst({
        where: { userId: input.assignedUserId, storeId: targetStoreId },
        select: { userId: true },
      });
      if (!member) throw new BadRequestException('That person does not work at the destination location.');
    }

    const before = {
      storeId: conversation.storeId,
      assignedUserId: conversation.assignedUserId,
      handling: conversation.handling,
    };

    // One write: store, owner and handling move together or not at all.
    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
        ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
        ...(input.handling ? { handling: input.handling } : {}),
        ...(input.reason !== undefined ? { handoffReason: input.reason || null } : {}),
      },
    });

    await this.audit.record(user, {
      action: 'conversation.assigned',
      entityType: 'Conversation',
      entityId: conversationId,
      // Stamp the branch the thread now belongs to. Audit reads only surface
      // null-store rows to head office, so leaving this unset made every routing
      // change invisible to the store manager whose branch it concerned — the
      // person most likely to need it. Falls back to where it came from when the
      // thread has been returned to the central queue.
      storeId: updated.storeId ?? before.storeId ?? undefined,
      summary:
        `Routing changed: store ${before.storeId ?? 'none'} -> ${updated.storeId ?? 'none'}, ` +
        `owner ${before.assignedUserId ?? 'none'} -> ${updated.assignedUserId ?? 'none'}, ` +
        `handling ${before.handling} -> ${updated.handling}`,
      metadata: {
        before,
        after: { storeId: updated.storeId, assignedUserId: updated.assignedUserId, handling: updated.handling },
      },
    });

    await this.activity.record({
      organisationId: user.organisationId,
      type: 'conversation.assigned',
      summary: 'Conversation routing was changed.',
      partyId: updated.partyId,
      storeId: updated.storeId,
      entityType: 'Conversation',
      entityId: conversationId,
    });

    /*
     * A branch has just been supplied, which may be the first time this
     * ad-originated thread has had one. Opening the lead here is what stops a
     * click that arrived before any routing rule existed from staying invisible
     * to the pipeline for good. Runs only when the conversation now HAS a store;
     * a thread returned to the central queue opens nothing.
     */
    const backfilledLeadId = updated.storeId
      ? await this.backfillAdLeadOnAssign(user.organisationId, conversationId)
      : null;

    return { ...updated, backfilledLeadId };
  }

  /**
   * Routing conflicts the caller is allowed to see.
   *
   * `state` is tri-state on purpose. The queue wants OPEN ones; a conversation's
   * detail panel wants ALL of them, because a resolved conflict is the record of
   * a decision somebody made about this customer and hiding it once it is
   * answered would delete the only trace of why the thread sits where it does.
   *
   * The row stores opaque ids. A screen that renders "store_p1b_mum" is useless
   * to the person who has to decide, so the names are resolved here — batched,
   * organisation-bounded, and left null when the store, person or rule has since
   * been deleted rather than being back-filled with a guess.
   */
  async routingConflicts(
    user: AuthUser,
    opts: { state?: 'open' | 'resolved' | 'all'; conversationId?: string } = {},
  ) {
    const state = opts.state ?? 'open';
    const rows = await this.prisma.conversationRoutingConflict.findMany({
      where: {
        organisationId: user.organisationId,
        ...(state === 'open' ? { resolution: null } : {}),
        ...(state === 'resolved' ? { NOT: { resolution: null } } : {}),
        ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
        // The conflict is only visible if its CONVERSATION is. This is what stops
        // a conflict row from becoming a side channel onto a thread the caller
        // may not open — including the head-office-only central queue.
        conversation: this.visibility(user),
      },
      orderBy: { detectedAt: 'desc' },
      take: 100,
      include: {
        conversation: {
          select: {
            id: true,
            channel: true,
            storeId: true,
            assignedUserId: true,
            handling: true,
            routingReviewRequired: true,
            party: { select: { id: true, name: true } },
          },
        },
        resolvedBy: { select: { id: true, name: true } },
      },
    });
    if (!rows.length) return [];

    return this.withRoutingNames(user, rows);
  }

  /**
   * Attach human-readable names to a batch of conflict rows.
   *
   * Two queries for the whole page, both bounded to the caller's organisation —
   * an id that belongs to another tenant simply resolves to null instead of
   * leaking a name.
   */
  private async withRoutingNames<
    T extends {
      originalStoreId: string | null;
      originalAssignedUserId: string | null;
      originalRuleId: string | null;
      proposedStoreId: string | null;
      proposedAssignedUserId: string | null;
      proposedRuleId: string | null;
      proposedRuleName: string | null;
    },
  >(user: AuthUser, rows: T[]) {
    const storeIds = new Set<string>();
    const userIds = new Set<string>();
    for (const r of rows) {
      if (r.originalStoreId) storeIds.add(r.originalStoreId);
      if (r.proposedStoreId) storeIds.add(r.proposedStoreId);
      if (r.originalAssignedUserId) userIds.add(r.originalAssignedUserId);
      if (r.proposedAssignedUserId) userIds.add(r.proposedAssignedUserId);
    }

    const [stores, users] = await Promise.all([
      storeIds.size
        ? this.prisma.store.findMany({
            where: { id: { in: [...storeIds] }, organisationId: user.organisationId },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      userIds.size
        ? this.prisma.user.findMany({
            where: { id: { in: [...userIds] }, organisationId: user.organisationId },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const storeName = new Map(stores.map((s) => [s.id, s.name] as const));
    const userName = new Map(users.map((u) => [u.id, u.name] as const));

    // Rule names live in organisation settings, so this is one read for the page.
    const ruleName = new Map<string, string>();
    if (rows.some((r) => r.originalRuleId)) {
      for (const rule of await this.adSetRules.list(user.organisationId)) {
        ruleName.set(rule.id, rule.name);
      }
    }

    return rows.map((r) => ({
      ...r,
      original: {
        storeId: r.originalStoreId,
        storeName: r.originalStoreId ? storeName.get(r.originalStoreId) ?? null : null,
        assignedUserId: r.originalAssignedUserId,
        assignedUserName: r.originalAssignedUserId ? userName.get(r.originalAssignedUserId) ?? null : null,
        ruleId: r.originalRuleId,
        ruleName: r.originalRuleId ? ruleName.get(r.originalRuleId) ?? null : null,
      },
      proposed: {
        storeId: r.proposedStoreId,
        storeName: r.proposedStoreId ? storeName.get(r.proposedStoreId) ?? null : null,
        assignedUserId: r.proposedAssignedUserId,
        assignedUserName: r.proposedAssignedUserId ? userName.get(r.proposedAssignedUserId) ?? null : null,
        ruleId: r.proposedRuleId,
        ruleName: r.proposedRuleName ?? (r.proposedRuleId ? ruleName.get(r.proposedRuleId) ?? null : null),
      },
    }));
  }

  /**
   * 1B - resolve a routing conflict.
   *
   * Three honest outcomes, all of which record the decision. The review flag is
   * cleared only once NOTHING else is open on the thread — answering one of two
   * questions does not make the thread reviewed. The conflict row is never
   * deleted: it is the evidence of what was proposed and what a person decided
   * instead, and there is no endpoint that could remove it.
   */
  async resolveRoutingConflict(
    user: AuthUser,
    conflictId: string,
    input: {
      decision: 'kept_original' | 'accepted_proposed' | 'manual';
      storeId?: string | null;
      assignedUserId?: string | null;
      /** Only meaningful for 'manual'; validated by `assign` like any other. */
      handling?: string;
      note?: string;
    },
  ) {
    const conflict = await this.prisma.conversationRoutingConflict.findFirst({
      where: { id: conflictId, organisationId: user.organisationId },
    });
    if (!conflict) throw new NotFoundException('Routing conflict not found');
    if (conflict.resolution) throw new BadRequestException('This conflict has already been resolved.');

    // The caller must be able to open the conversation before deciding anything
    // about it. Without this a conflict id — which is guessable in no useful
    // sense but is still just a string — would be a way to route a thread the
    // caller cannot see.
    await this.load(user, conflict.conversationId);

    /*
     * CLAIM THE CONFLICT FIRST, as a compare-and-set.
     *
     * The read-then-check above is not enough on its own: two managers pressing
     * "Accept" in the same second both read `resolution: null`, both pass, and
     * both run the assignment. `UPDATE … WHERE resolution IS NULL` is the only
     * thing that can settle which one won, and it is the database that settles
     * it — `updateMany` reports 0 rows to the loser.
     */
    const claimed = await this.prisma.conversationRoutingConflict.updateMany({
      where: { id: conflictId, organisationId: user.organisationId, resolution: null },
      data: {
        resolution: input.decision,
        resolutionNote: input.note?.trim() || null,
        resolvedById: user.id,
        resolvedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw new BadRequestException('This conflict has already been resolved.');

    try {
      // Every branch goes through `assign`, so store scope and store membership
      // are validated once, in one place, for all three decisions.
      if (input.decision === 'accepted_proposed') {
        await this.assign(user, conflict.conversationId, {
          // Only the fields the rule actually had an opinion about. A rule with
          // no store is a rule that does not route by store — passing its null
          // through as `storeId: null` would EVICT a routed thread into the
          // central queue (visible to head office alone), so a manager pressing
          // "accept" on a handling-only proposal would watch the conversation
          // disappear. An absent field means "leave it", exactly as in `assign`.
          ...(conflict.proposedStoreId ? { storeId: conflict.proposedStoreId } : {}),
          ...(conflict.proposedAssignedUserId
            ? { assignedUserId: conflict.proposedAssignedUserId }
            : {}),
          handling: conflict.proposedHandling ?? undefined,
          reason: `Accepted routing proposed by rule "${conflict.proposedRuleName ?? conflict.proposedRuleId}".`,
        });
      } else if (input.decision === 'manual') {
        await this.assign(user, conflict.conversationId, {
          // `?? null` here used to turn "the caller did not mention the store"
          // into "clear the store", quietly returning a routed thread to the
          // central queue when somebody only wanted to change its owner. An
          // omitted field means leave it alone, exactly as it does in `assign`.
          ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
          ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
          ...(input.handling ? { handling: input.handling } : {}),
          reason: input.note || 'Routing set manually after a conflict.',
        });
      }
      // 'kept_original' deliberately changes nothing about the conversation.
    } catch (err) {
      // The routing did not move, so the conflict is NOT resolved. Release the
      // claim rather than leaving a decision recorded against something that
      // never happened — a conflict marked "accepted" over a conversation still
      // sitting in the original branch is worse than an error.
      await this.prisma.conversationRoutingConflict.updateMany({
        where: { id: conflictId, organisationId: user.organisationId, resolvedById: user.id, resolution: input.decision },
        data: { resolution: null, resolutionNote: null, resolvedById: null, resolvedAt: null },
      });
      throw err;
    }

    const resolved = await this.prisma.conversationRoutingConflict.findUniqueOrThrow({
      where: { id: conflictId },
    });

    // Clear the flag only when nothing else is still open on this thread.
    const stillOpen = await this.prisma.conversationRoutingConflict.count({
      where: { conversationId: conflict.conversationId, resolution: null },
    });
    if (stillOpen === 0) {
      await this.prisma.conversation.update({
        where: { id: conflict.conversationId },
        data: { routingReviewRequired: false },
      });
    }

    // Read the branch AFTER the decision: 'accepted_proposed' may just have
    // moved the thread, and the audit row belongs where the thread now is.
    const current = await this.prisma.conversation.findUnique({
      where: { id: conflict.conversationId },
      select: { storeId: true },
    });

    await this.audit.record(user, {
      action: 'conversation.routing_conflict_resolved',
      entityType: 'Conversation',
      entityId: conflict.conversationId,
      // Same reason as `assign`: without a store this row is head-office-only.
      storeId: current?.storeId ?? conflict.originalStoreId ?? undefined,
      summary: `Routing conflict resolved as "${input.decision}".`,
      metadata: { conflictId, decision: input.decision },
    });

    return resolved;
  }

  /**
   * 1F - who may see the CENTRAL (storeless) queue.
   *
   * A conversation with no store belongs to nobody yet. Previously every user
   * saw all of them, which meant a salesperson at one branch could read every
   * unrouted customer message in the tenant.
   *
   * This FAILS CLOSED to head office, deliberately. Expressing "the unassigned
   * queue for my region" needs a user-to-region link, and there is none: `User`
   * has no `regionId` and reaches stores only through `UserStore`. `area_manager`
   * still exists in the Role enum but was collapsed into `store_manager`
   * operationally, so treating it as regional here would invent an ownership
   * boundary the data cannot back.
   *
   * The trade-off is real and is the safe direction: unrouted inbound is visible
   * to head office rather than to everyone. Routed traffic is unaffected, and
   * routing rules exist precisely so that traffic reaches a branch. Give this
   * back to regional managers once a real region link exists on User.
   */
  private visibility(user: AuthUser, recordAuthorised = false): Prisma.ConversationWhereInput {
    const storeScope = this.scope.storeFilter(user);
    // Staff notice threads (the morning digest) are the business talking to its
    // own people. They are in the outbox, never in the customer inbox.
    // A salesperson's inbox is the threads assigned to them. An unassigned or
    // colleague's thread reaches them by assignment, not by being at the branch.
    if (isSalesScoped(user) && !recordAuthorised) {
      return { audience: 'customer', ...storeScope, assignedUserId: user.id };
    }
    return user.role === 'head_office'
      ? { audience: 'customer', OR: [storeScope, { storeId: null }] }
      : { audience: 'customer', ...storeScope };
  }

  /**
   * How many threads sit in each queue, for the caller.
   *
   * Counted BY THE SERVER, under exactly the same `visibility()` predicate the
   * list uses. Counting on the client would mean counting the page it happens to
   * have fetched — a badge reading "50" on a capped list, and a store manager
   * being told how many threads exist in a queue they are not allowed to read.
   *
   * The keys match the queue tabs one-for-one. Labels are deliberately NOT here:
   * what a tenant calls a location or a customer is a product decision that
   * belongs to the screen, not to a counting query.
   */
  async queueCounts(user: AuthUser): Promise<Record<string, number>> {
    const scoped = (extra: Prisma.ConversationWhereInput): Prisma.ConversationWhereInput => ({
      organisationId: user.organisationId,
      AND: [this.visibility(user), extra],
    });

    const queues: [string, Prisma.ConversationWhereInput][] = [
      ['open', { status: 'open' }],
      ['mine', { assignedUserId: user.id }],
      ['unassigned', { handling: 'unassigned' }],
      ['human', { handling: 'human' }],
      ['ai', { handling: 'ai' }],
      ['review', { routingReviewRequired: true }],
      ['unknown', { partyId: null }],
      ['closed', { status: 'closed' }],
    ];

    // One round trip for the whole tab bar rather than eight.
    const counts = await this.prisma.$transaction(
      queues.map(([, where]) => this.prisma.conversation.count({ where: scoped(where) })),
    );
    return Object.fromEntries(queues.map(([key], i) => [key, counts[i]]));
  }

  /** The inbox list, newest activity first. */
  async list(
    user: AuthUser,
    opts: {
      status?: string; handling?: string; assignedToMe?: boolean; channel?: string; limit?: number;
      /** Queue: threads a later ad tried to reroute. */
      routingReview?: boolean;
      /** Queue: inbound traffic not yet linked to a customer. */
      unidentified?: boolean;
      /** Queue: one store's conversations (still intersected with the caller's scope). */
      storeId?: string;
      /**
       * One customer's threads. Narrowing, like every other filter here: the
       * caller's own visibility clause still applies, so asking for a party
       * whose threads belong to a branch they cannot read returns nothing
       * rather than that branch's inbox.
       */
      partyId?: string;
    } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    // A requested store is INTERSECTED with the caller's own scope, never
    // substituted for it — a filter must not become a way to read another
    // store's inbox.
    if (opts.storeId) this.scope.assertStoreAllowed(user, opts.storeId);
    const rows = await this.prisma.conversation.findMany({
      where: {
        organisationId: user.organisationId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.handling ? { handling: opts.handling } : {}),
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.assignedToMe ? { assignedUserId: user.id } : {}),
        ...(opts.routingReview ? { routingReviewRequired: true } : {}),
        ...(opts.unidentified ? { partyId: null } : {}),
        ...(opts.partyId ? { partyId: opts.partyId } : {}),
        // AND, not a sibling OR: a top-level `storeId` alongside an `OR` that
        // admits `storeId: null` is contradictory, and Prisma would AND them
        // into something nobody intended.
        AND: [
          this.visibility(user),
          ...(opts.storeId ? [{ storeId: opts.storeId }] : []),
        ],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take,
      include: {
        party: { select: { id: true, name: true, phone: true } },
        assignedUser: { select: { id: true, name: true } },
        store: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
    });

    // Attach the human-readable rule name. Rules live in organisation settings,
    // so this is one read for the whole page rather than a join per row.
    const ruleIds = new Set(rows.map((r) => r.matchedRuleId).filter(Boolean) as string[]);
    const names = new Map<string, string>();
    if (ruleIds.size) {
      for (const rule of await this.adSetRules.list(user.organisationId)) {
        if (ruleIds.has(rule.id)) names.set(rule.id, rule.name);
      }
    }

    return rows.map((row) => ({
      ...row,
      /** The rule that routed this, by name. Null when the rule was since deleted. */
      matchedRuleName: row.matchedRuleId ? names.get(row.matchedRuleId) ?? null : null,
      /**
       * What we can HONESTLY say about where this came from. `null` for a field
       * the provider did not supply — the UI renders that as "not provided by
       * Meta" rather than inventing a campaign.
       */
      source: {
        adId: row.sourceAdId,
        adSetId: row.sourceAdSetId,
        campaignId: row.sourceCampaignId,
        clickId: row.sourceClickId ? true : false, // presence only; never the value
        evidence: row.sourceAdId || row.sourceClickId ? ('measured' as const) : null,
      },
    }));
  }

  async thread(user: AuthUser, conversationId: string, limit = 100) {
    const conversation = await this.load(user, conversationId);
    const messages = await this.prisma.message.findMany({
      where: { conversationId, organisationId: user.organisationId },
      orderBy: { sentAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
      include: { authorUser: { select: { id: true, name: true } } },
    });
    return { conversation, messages };
  }

  /**
   * Read one attachment from a thread, for somebody entitled to see it.
   *
   * `load()` first, deliberately: it applies the same visibility rule as
   * opening the conversation, so a salesperson cannot reach a photograph from
   * a thread the list correctly refuses to show them. The message is then
   * matched to THAT conversation, so a valid message id from another thread
   * does not resolve.
   *
   * `readPrivate` is scoped to the organisation as well, which makes this safe
   * twice over: even a mismatched key cannot read another tenant's file.
   */
  async mediaFor(
    user: AuthUser,
    conversationId: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    await this.load(user, conversationId);

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, organisationId: user.organisationId },
      select: { mediaUrl: true, mediaType: true },
    });
    if (!message?.mediaUrl) {
      throw new NotFoundException('That message has no attachment.');
    }

    const buffer = await this.storage.readPrivate(user.organisationId, message.mediaUrl);
    if (!buffer) {
      // Distinguished from "no attachment" on purpose: this one means the row
      // promises a file that is not on disk, which is a fault worth seeing
      // rather than a 404 that reads like the customer never sent anything.
      this.logger.warn(`attachment missing from storage for message ${messageId}`);
      throw new NotFoundException('That attachment is no longer available.');
    }

    return { buffer, contentType: message.mediaType || 'application/octet-stream' };
  }

  /**
   * Record an outbound reply AND send it.
   *
   * It used to only record. The doc here said "nothing in this repository can
   * deliver a message ... reporting a message as sent when no provider was
   * contacted would be a lie the UI then shows to a salesperson who believes
   * the customer got it" — correct then, and the reason the copy promised
   * nothing. Once a number was connected the same copy became the lie it was
   * written to avoid: the reply was saved, the screen said so, and the waiting
   * customer got silence.
   *
   * Delivery goes through `OmnichannelService.queueAgentReply`, which is the
   * single chokepoint for consent, the 24-hour window and the outbox. What
   * comes back is reported verbatim rather than summarised, because "outside
   * the 24-hour window" and "this customer opted out" need different actions
   * from the person who just typed.
   */
  async queueOutbound(
    user: AuthUser,
    conversationId: string,
    input: { body?: string; mediaUrl?: string; mediaType?: string },
  ) {
    if (!input.body?.trim() && !input.mediaUrl) {
      throw new BadRequestException('A reply needs a message or an attachment.');
    }
    const conversation = await this.load(user, conversationId);

    const outcome = await this.omnichannel.queueAgentReply({
      organisationId: user.organisationId,
      conversationId,
      authorUserId: user.id,
      body: input.body?.trim() ?? null,
      mediaUrl: input.mediaUrl ?? null,
      mediaType: input.mediaType ?? null,
    });
    const message = outcome.message;

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        // Replying takes the thread off the AI. Doing it here rather than
        // expecting the caller to remember means an agent can never end up
        // talking over the bot.
        handling: 'human',
        assignedUserId: conversation.assignedUserId ?? user.id,
      },
    });

    await this.activity.recordFor(user, {
      type: 'message.queued',
      summary: `${user.name} replied on ${conversation.channel}`,
      partyId: conversation.partyId,
      storeId: conversation.storeId,
      channel: conversation.channel,
      entityType: 'Conversation',
      entityId: conversationId,
    });

    return {
      message,
      delivery: {
        // 'queued' still means queued: the outbox worker carries it from here,
        // so claiming 'sent' would overstate what has happened by one hop.
        state: outcome.queued ? ('queued' as const) : ('saved' as const),
        note: outcome.reason,
        jobId: outcome.jobId,
      },
    };
  }

  /** Assign, hand off between AI and a person, or close a thread. */
  async update(
    user: AuthUser,
    conversationId: string,
    input: { status?: string; handling?: string; handoffReason?: string; partyId?: string },
  ) {
    const conversation = await this.load(user, conversationId);
    if (input.status && !STATUSES.includes(input.status)) {
      throw new BadRequestException(`status must be one of: ${STATUSES.join(', ')}.`);
    }
    if (input.handling && !HANDLING.includes(input.handling)) {
      throw new BadRequestException(`handling must be one of: ${HANDLING.join(', ')}.`);
    }
    if (input.partyId) {
      const party = await this.prisma.party.findFirst({
        where: { id: input.partyId, organisationId: user.organisationId },
        select: { id: true },
      });
      if (!party) throw new NotFoundException('Customer not found');
    }

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.handling ? { handling: input.handling } : {}),
        ...(input.handoffReason !== undefined ? { handoffReason: input.handoffReason } : {}),
        ...(input.partyId ? { partyId: input.partyId } : {}),
      },
    });

    if (input.handling && input.handling !== conversation.handling) {
      await this.activity.recordFor(user, {
        type: 'conversation.handoff',
        summary:
          input.handling === 'human'
            ? `Handed to a person${input.handoffReason ? ` — ${input.handoffReason}` : ''}`
            : `Handling set to ${input.handling}`,
        partyId: updated.partyId,
        storeId: updated.storeId,
        channel: updated.channel,
        entityType: 'Conversation',
        entityId: conversationId,
      });
    }
    return updated;
  }

  /**
   * Can this caller act on this conversation at all?
   *
   * A thin public door onto `load`, so anything outside this service (the AI
   * draft review, for one) enforces visibility through the SAME predicate rather
   * than reimplementing it — a second copy is how the central-queue rule ends up
   * enforced in one place and forgotten in another. Throws 404 when not.
   */
  /**
   * `recordAuthorised`: the caller reached this thread through a record they
   * own (their quote), so it is held to branch scope only. The thread's content
   * is not returned to them by that path.
   */
  async assertCanAccess(user: AuthUser, conversationId: string, recordAuthorised = false) {
    return this.load(user, conversationId, recordAuthorised);
  }

  /**
   * Load a conversation, bounded to the caller's organisation AND store scope.
   * The single choke-point every mutation above goes through, so a cross-tenant
   * id is a 404 exactly once rather than in five places that each had to
   * remember.
   */
  private async load(user: AuthUser, conversationId: string, recordAuthorised = false) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        organisationId: user.organisationId,
        // Same central-queue policy as the list. Without this a salesperson
        // could open by id exactly what the list correctly refuses to show.
        ...this.visibility(user, recordAuthorised),
      },
      // The same three relations the list resolves. Without them the detail
      // header rendered "Unknown sender" for every thread, including ones with a
      // customer attached, because `party` simply was not on the object — and
      // the routing panel had no current location or owner to show against a
      // proposed one.
      include: {
        party: { select: { id: true, name: true, phone: true } },
        assignedUser: { select: { id: true, name: true } },
        store: { select: { id: true, name: true } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }
}

function truncate(s: string, n = 120): string {
  const v = s.trim().replace(/\s+/g, ' ');
  return v.length <= n ? v : `${v.slice(0, n - 1)}…`;
}

/**
 * A stable identity for one ad interaction, so it is counted exactly once.
 *
 * Preference order, strongest evidence first:
 *
 *  1. CLICK ID — Meta's own per-click identifier. Two messages carrying the same
 *     `ctwa_clid` are the same click, however many times the webhook redelivers
 *     them, so this is the correct key whenever it exists.
 *  2. AD ID + CONVERSATION — no click id, but we know which ad opened which
 *     thread. Collapses repeats within one conversation while still letting the
 *     same ad be counted once per customer.
 *  3. PROVIDER MESSAGE ID — last resort. Weakest, because two different messages
 *     from one genuine click would each get their own touch; still better than
 *     no key at all.
 *
 * The subject is part of the key so the same click credited to a lead and to a
 * party cannot silently collapse into one row.
 *
 * Returns null when none of the three exist, which leaves the touch undeduped —
 * the honest outcome, since there is nothing stable to deduplicate ON. The
 * organisation is NOT included here: it is the first column of the unique index,
 * which is what keeps one tenant's click id from colliding with another's.
 */
export function adTouchDedupeKey(
  ref: { clickId: string | null; adId: string | null },
  conversationId: string,
  providerMessageId: string | null,
  subject: { leadId: string | null; partyId: string | null },
): string | null {
  const on = subject.leadId ? `lead:${subject.leadId}` : subject.partyId ? `party:${subject.partyId}` : null;
  if (!on) return null;
  if (ref.clickId) return `click:${ref.clickId}|${on}`;
  if (ref.adId) return `ad:${ref.adId}|convo:${conversationId}|${on}`;
  if (providerMessageId) return `msg:${providerMessageId}|${on}`;
  return null;
}
