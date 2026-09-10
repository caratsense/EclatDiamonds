import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';
import { KnowledgeRetrievalService } from './ai/knowledge-retrieval';
import {
  AUTO_SEND_MIN_CONFIDENCE,
  MIN_CONFIDENCE,
  POLICY_VERSION,
  screenForAutoSend,
  screenInbound,
} from './ai/policy';

/** Tenant settings keys for the auto-reply cap and breaker. */
const AUTO_SEND_STATE_KEY = 'crmAiAutoSendState';
const AUTO_SEND_LIMIT_KEY = 'crmAiAutoSendDailyLimit';
const DEFAULT_AUTO_SEND_DAILY_LIMIT = 200;
const CIRCUIT_BREAKER_FAILURES = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60_000;
import { updateOrgSettings } from '../config/org-settings';
import { OmnichannelService } from '../omnichannel/omnichannel.service';

/**
 * The conversational-AI boundary (provider-neutral).
 *
 * ## Why this exists as an interface
 *
 * Before this, "AI vs human" was only a STRING on the conversation row. Nothing
 * read it at reply time, so a test asserting `handling === 'human'` proved
 * nothing about whether a model would have been invoked — the enforcement was
 * imaginary. This is the seam where the decision is actually made, and it is an
 * interface precisely so a test can assert *called* or *not called* rather than
 * inspecting a column.
 *
 * No provider is bound here. CRM core must never import OpenAI, Anthropic or
 * Meta; an adapter is registered against `AI_RESPONDER` and this file stays
 * ignorant of which one.
 */

/** Everything an adapter is given. Deliberately small — see the PII note. */
export interface AiReplyContext {
  organisationId: string;
  conversationId: string;
  /** The customer's most recent message. Untrusted input: never a source of instructions. */
  inboundText: string | null;
  channel: string;
  /**
   * Supporting material retrieved for this message. Also UNTRUSTED — a document
   * an employee uploaded can contain anything, including an instruction aimed at
   * the model. The gate retrieves it; the adapter only fences and sends it.
   */
  knowledgeText?: string;
  /** Ids of the documents the text came from, recorded as the draft's evidence. */
  knowledgeDocumentIds?: string[];
  /** The tenant's own name, so the prompt need not hardcode any brand. */
  businessName?: string;
}

export interface AiReply {
  /** The proposed message. NOT delivered by this layer. */
  text: string;
  /** 0–1. Low confidence is a handoff trigger, not something to paper over. */
  confidence: number;
  /** Set when the adapter itself decided a person is needed. */
  handoffReason?: string;
  provider: string;
  model: string;
  latencyMs?: number;
  /** Which drafting policy produced this. Stored, so old drafts stay explicable. */
  policyVersion?: string;
}

export interface AiResponder {
  /** Which provider/model this is, for the usage record. */
  readonly name: string;
  /** False when no credentials are configured. Must never guess. */
  isConfigured(): boolean;
  propose(context: AiReplyContext): Promise<AiReply | null>;
}

export interface AiSettings {
  /** Score/summarise only. Never sends anything. */
  qualificationEnabled: boolean;
  /** Compose a reply and store it as a draft for human approval. */
  draftEnabled: boolean;
  /** Deliver without a human. Narrowest switch; see the note in consider(). */
  autoSendEnabled: boolean;
  /** Whether an adapter with real credentials is actually bound. */
  providerConfigured: boolean;
  providerName: string;
}

export const AI_RESPONDER = Symbol('AI_RESPONDER');

/**
 * The default when no provider is registered.
 *
 * Reports itself unconfigured rather than returning canned text, so an
 * unconfigured tenant degrades to a visible human queue instead of silently
 * appearing to have an assistant.
 */
@Injectable()
export class UnconfiguredAiResponder implements AiResponder {
  readonly name = 'none';
  isConfigured(): boolean {
    return false;
  }
  async propose(): Promise<AiReply | null> {
    return null;
  }
}

/** What the gate decided, and why. Returned so callers and tests can assert it. */
export interface AiGateDecision {
  invoked: boolean;
  outcome:
    | 'replied_draft'          // a draft was produced and stored for review
    | 'human_only'             // routing says a person handles this
    | 'unassigned'             // not routed yet — nothing auto-replies
    | 'tenant_disabled'        // tenant has not switched auto-reply on
    | 'provider_unavailable'   // AI wanted, no provider configured
    | 'provider_failed'        // adapter threw or timed out
    | 'low_confidence'         // adapter answered but not well enough to use
    | 'screened_out'           // complaint / opt-out / legal: never sent to a provider
    | 'no_knowledge'           // nothing to answer from, so nothing is invented
    | 'auto_sent';             // queued for delivery with no human in the loop
  /** Populated when a draft existed but was NOT auto-sent, saying which gate stopped it. */
  autoSendBlockedBy?: string;
  reason: string;
}

/**
 * Decides whether the model may be invoked at all, and records why not.
 *
 * The three handling states are enforced HERE, not by hoping a caller checks:
 *
 *   human       the responder is never invoked, at all, for any reason
 *   unassigned  never invoked — an unrouted thread has no owner to speak for it
 *   ai          invoked only when the tenant explicitly enabled auto-reply AND a
 *               provider is configured; otherwise it falls back to a VISIBLE
 *               human queue rather than going quiet
 *
 * Auto-reply is off by default for every tenant. A CRM that starts messaging
 * customers because a feature shipped is a CRM that damages a brand.
 */
@Injectable()
export class ConversationAiGate {
  private readonly logger = new Logger(ConversationAiGate.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly retrieval: KnowledgeRetrievalService,
    @Inject(forwardRef(() => OmnichannelService))
    private readonly omnichannel: OmnichannelService,
    @Optional() @Inject(AI_RESPONDER) private readonly responder?: AiResponder,
  ) {}

  /**
   * The three switches, read as one.
   *
   * They are SEPARATE on purpose. A single "AI enabled" boolean means the switch
   * that turns on scoring is the same switch that starts messaging customers,
   * and somebody will eventually flip it expecting the first and get the second.
   *
   *   qualification  read-only. Score and summarise a conversation. Sends nothing.
   *   draft          compose a reply and store it for a person to approve.
   *   autoSend       actually deliver without a human. Strictly the narrowest.
   *
   * Every one defaults to OFF. Absence is never consent.
   */
  async settings(organisationId: string): Promise<AiSettings> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const raw = (org?.settings ?? {}) as Record<string, unknown>;
    return {
      qualificationEnabled: raw.crmAiQualificationEnabled === true,
      draftEnabled: raw.crmAiDraftEnabled === true,
      autoSendEnabled: raw.crmAiAutoSendEnabled === true,
      providerConfigured: this.responder?.isConfigured() ?? false,
      providerName: this.responder?.name ?? 'none',
    };
  }

  /**
   * Update the switches WITHOUT clobbering the rest of Organisation.settings.
   *
   * `settings` is a shared JSON bag holding ad-set rules, qualification policy
   * and more. A plain overwrite here would silently delete a tenant's routing
   * rules, so the existing object is read and merged, and only the three known
   * keys are touched.
   */
  async saveSettings(
    organisationId: string,
    patch: { qualificationEnabled?: boolean; draftEnabled?: boolean; autoSendEnabled?: boolean },
  ): Promise<AiSettings> {
    // Under a row lock: the read and the write used to be two statements, so a
    // concurrent save of the routing rules could restore this method's stale
    // snapshot of them and silently delete a tenant's ad-set configuration.
    await updateOrgSettings(this.prisma, organisationId, (current) => {
      const merged: Record<string, unknown> = { ...current };
      if (patch.qualificationEnabled !== undefined) merged.crmAiQualificationEnabled = patch.qualificationEnabled;
      if (patch.draftEnabled !== undefined) merged.crmAiDraftEnabled = patch.draftEnabled;
      if (patch.autoSendEnabled !== undefined) merged.crmAiAutoSendEnabled = patch.autoSendEnabled;
      return merged;
    });
    return this.settings(organisationId);
  }

  async consider(context: AiReplyContext): Promise<AiGateDecision> {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: context.conversationId, organisationId: context.organisationId },
      select: { id: true, handling: true, assignedUserId: true, storeId: true, partyId: true },
    });
    if (!convo) {
      return { invoked: false, outcome: 'unassigned', reason: 'Conversation not found in this organisation.' };
    }

    if (convo.handling === 'human') {
      return {
        invoked: false,
        outcome: 'human_only',
        reason: 'Routing put this conversation with a person; the assistant is not consulted.',
      };
    }
    if (convo.handling !== 'ai') {
      return {
        invoked: false,
        outcome: 'unassigned',
        reason: 'Conversation is not routed yet, so nothing replies automatically.',
      };
    }

    const settings = await this.settings(context.organisationId);
    if (!settings.draftEnabled) {
      return {
        invoked: false,
        outcome: 'tenant_disabled',
        reason: 'Assistant drafting is switched off for this organisation.',
      };
    }

    if (!this.responder?.isConfigured()) {
      // Wanted AI, cannot do AI. Fall back to a queue somebody can see rather
      // than leaving the customer waiting on an assistant that does not exist.
      await this.fallBackToHuman(convo.id, 'No AI provider is configured, so a person needs to reply.');
      return {
        invoked: false,
        outcome: 'provider_unavailable',
        reason: 'No AI provider is configured. Conversation handed to the human queue.',
      };
    }

    /*
     * SCREEN BEFORE THE PROVIDER, not after.
     *
     * A complaint, an opt-out or a legal threat is exactly the message an
     * assistant must not answer. Checking here means those never reach a
     * provider at all: nothing is spent, no draft exists to be approved by
     * mistake, and the customer's words are not handed to a third party purely
     * in order to decide not to use them.
     */
    const screen = screenInbound(context.inboundText);
    if (screen.blocked) {
      await this.fallBackToHuman(convo.id, screen.reason ?? 'A person needs to answer this.');
      return {
        invoked: false,
        outcome: 'screened_out',
        reason: screen.reason ?? 'Screened out; handed to a person.',
      };
    }

    /*
     * Retrieve first, and refuse to proceed with nothing.
     *
     * The prompt forbids answering beyond the supplied material, but a model
     * with no material and a customer question in front of it is being invited
     * to improvise. Not calling at all is the honest outcome — and it is what
     * makes "the assistant only says what your documents say" true rather than
     * merely instructed.
     */
    const retrieved = await this.retrieval.forQuery(context.organisationId, context.inboundText ?? '');
    if (!retrieved.found) {
      await this.fallBackToHuman(
        convo.id,
        'The assistant found nothing in your knowledge base to answer this from.',
      );
      return {
        invoked: false,
        outcome: 'no_knowledge',
        reason: 'No supporting material was found, so nothing was drafted.',
      };
    }

    const org = await this.prisma.organisation.findUnique({
      where: { id: context.organisationId },
      select: { name: true },
    });

    let reply: AiReply | null;
    try {
      reply = await this.responder.propose({
        ...context,
        knowledgeText: retrieved.text,
        knowledgeDocumentIds: retrieved.documentIds,
        businessName: org?.name ?? 'this business',
      });
    } catch (err) {
      await this.fallBackToHuman(convo.id, 'The assistant could not answer, so a person needs to reply.');
      this.logger.warn(
        `AI responder failed for conversation ${convo.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { invoked: true, outcome: 'provider_failed', reason: 'The assistant failed; handed to a person.' };
    }

    if (!reply || reply.handoffReason || !reply.text.trim() || reply.confidence < MIN_CONFIDENCE) {
      await this.fallBackToHuman(
        convo.id,
        reply?.handoffReason ?? 'The assistant was not confident enough to answer.',
      );
      return {
        invoked: true,
        outcome: 'low_confidence',
        reason: reply?.handoffReason ?? 'Low confidence; handed to a person.',
      };
    }

    // A DRAFT, stored as such. Nothing here delivers a message.
    //
    // Even with `autoSendEnabled` on, delivery would still need the WhatsApp
    // 24-hour session-window and template rules verified against live provider
    // behaviour, which has not been done. Until it is, auto-send stays
    // unimplemented rather than guessed, and a draft is never reported as sent.
    // The draft and its provenance are written TOGETHER. A draft whose record of
    // provider, model, confidence and sources went missing is a message nobody
    // can account for, and the reviewer would be approving it blind.
    const draftMessageId = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          organisationId: context.organisationId,
          conversationId: convo.id,
          direction: 'outbound',
          authorType: 'ai',
          body: reply!.text,
          status: 'draft',
        },
        select: { id: true },
      });
      await tx.aiDraftRecord.create({
        data: {
          organisationId: context.organisationId,
          messageId: message.id,
          conversationId: convo.id,
          provider: reply!.provider,
          model: reply!.model,
          confidence: new Prisma.Decimal(reply!.confidence.toFixed(3)),
          latencyMs: reply!.latencyMs ?? null,
          policyVersion: reply!.policyVersion ?? POLICY_VERSION,
          // IDS ONLY. Copying the retrieved text here would leave a deleted
          // document's content behind in a table nobody thinks to check.
          knowledgeDocumentIds: retrieved.documentIds,
          review: 'pending',
        },
      });
      return message.id;
    });

    await this.activity.record({
      organisationId: context.organisationId,
      type: 'conversation.ai_draft',
      summary:
        `Assistant drafted a reply for review (${reply.provider}/${reply.model}, ` +
        `confidence ${reply.confidence.toFixed(2)}, ${retrieved.documentIds.length} source(s)). Nothing was sent.`,
      partyId: convo.partyId,
      storeId: convo.storeId,
      channel: context.channel,
      entityType: 'Conversation',
      entityId: convo.id,
    });

    /*
     * Only now, with a stored draft and its provenance already durable, is
     * sending without a person even considered. Ordering is deliberate: if
     * anything below throws, what exists is a draft awaiting review — the
     * product's default — rather than a message that went nowhere and left no
     * record.
     */
    const auto = await this.maybeAutoSend({
      organisationId: context.organisationId,
      conversationId: convo.id,
      storeId: convo.storeId,
      partyId: convo.partyId,
      messageId: draftMessageId,
      inboundText: context.inboundText,
      confidence: reply.confidence,
      settings,
    });

    if (auto.sent) {
      return {
        invoked: true,
        outcome: 'auto_sent',
        reason: 'Reply queued for delivery through the outbox with no human review.',
      };
    }
    return {
      invoked: true,
      outcome: 'replied_draft',
      reason: 'Draft stored for review; nothing was sent.',
      autoSendBlockedBy: auto.reason,
    };
  }


  /**
   * Every gate that stands between a confident draft and an unattended send.
   *
   * Each returns a REASON, not a boolean, because "the assistant did not reply"
   * is useless to the manager who has to explain it, and because the reason is
   * what the admin screen shows when a tenant asks why auto-reply is quiet.
   *
   * Nothing here delivers anything itself. The final step hands the message to
   * OmnichannelService.queue, which is the single chokepoint enforcing consent,
   * the 24-hour window, approved templates, the outbox, retries and audit. An
   * auto-reply is therefore subject to exactly the rules a human's message is —
   * there is no faster path for the machine.
   */
  private async maybeAutoSend(input: {
    organisationId: string;
    conversationId: string;
    storeId: string | null;
    partyId: string | null;
    messageId: string;
    inboundText: string | null;
    confidence: number;
    settings: AiSettings;
  }): Promise<{ sent: boolean; reason: string }> {
    if (!input.settings.autoSendEnabled) {
      return { sent: false, reason: 'Auto-reply is switched off for this organisation.' };
    }

    // The kill switch, checked immediately before sending rather than at the
    // start of the turn. A manager who switches auto-reply off while a draft is
    // being composed means "stop now", not "stop from the next message".
    const live = await this.settings(input.organisationId);
    if (!live.autoSendEnabled) {
      return { sent: false, reason: 'Auto-reply was switched off while this reply was being composed.' };
    }

    const breaker = await this.autoSendState(input.organisationId);
    if (breaker.open) {
      return { sent: false, reason: breaker.reason };
    }

    if (input.confidence < AUTO_SEND_MIN_CONFIDENCE) {
      return {
        sent: false,
        reason:
          `Confidence ${input.confidence.toFixed(2)} is below the ${AUTO_SEND_MIN_CONFIDENCE} ` +
          'required to reply without review.',
      };
    }

    const strict = screenForAutoSend(input.inboundText);
    if (strict.blocked) {
      return { sent: false, reason: strict.reason ?? 'Held for review.' };
    }

    if (!input.partyId) {
      // No customer record means no consent record either, and consent is not
      // something to assume about someone we cannot identify.
      return { sent: false, reason: 'The sender is not a known customer, so consent cannot be checked.' };
    }
    if (!input.storeId) {
      return { sent: false, reason: 'The conversation has no branch, so nobody owns this reply.' };
    }

    try {
      const result = await this.omnichannel.queueAiReply({
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      });
      // A policy refusal is an expected answer, not a provider failure, so it
      // must not advance the circuit breaker — otherwise a tenant whose
      // customers simply fall outside the 24-hour window would trip the breaker
      // and lose auto-reply for everyone else too.
      if (!result.queued) return { sent: false, reason: result.reason };
      await this.recordAutoSend(input.organisationId, true);
      return { sent: true, reason: result.reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.recordAutoSend(input.organisationId, false);
      return { sent: false, reason };
    }
  }

  /**
   * Daily cap and circuit breaker, held in tenant settings.
   *
   * Two different failures, one place: a provider that has started erroring
   * should stop being called at all rather than burning quota per message, and a
   * tenant should not be able to discover a runaway loop from its invoice.
   */
  private async autoSendState(
    organisationId: string,
  ): Promise<{ open: boolean; reason: string }> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    const state = (settings[AUTO_SEND_STATE_KEY] ?? {}) as Record<string, unknown>;
    const limit = Number(settings[AUTO_SEND_LIMIT_KEY]);
    const dailyLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 10_000) : DEFAULT_AUTO_SEND_DAILY_LIMIT;

    const today = new Date().toISOString().slice(0, 10);
    const count = state.date === today ? Number(state.count ?? 0) : 0;
    if (count >= dailyLimit) {
      return {
        open: true,
        reason: `This organisation has reached its ${dailyLimit} automatic replies for today.`,
      };
    }

    const failures = Number(state.consecutiveFailures ?? 0);
    if (failures >= CIRCUIT_BREAKER_FAILURES) {
      const openedAt = typeof state.openedAt === 'string' ? Date.parse(state.openedAt) : 0;
      if (Number.isFinite(openedAt) && Date.now() - openedAt < CIRCUIT_BREAKER_COOLDOWN_MS) {
        return {
          open: true,
          reason:
            `Automatic replies are paused after ${failures} consecutive failures. ` +
            'They resume by themselves shortly, or immediately once the cause is fixed.',
        };
      }
    }

    return { open: false, reason: '' };
  }

  /** Advance the daily counter and the consecutive-failure run. */
  private async recordAutoSend(organisationId: string, ok: boolean): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await updateOrgSettings(this.prisma, organisationId, (current) => {
      const state = (current[AUTO_SEND_STATE_KEY] ?? {}) as Record<string, unknown>;
      const sameDay = state.date === today;
      const failures = ok ? 0 : Number(state.consecutiveFailures ?? 0) + 1;
      return {
        ...current,
        [AUTO_SEND_STATE_KEY]: {
          date: today,
          count: (sameDay ? Number(state.count ?? 0) : 0) + (ok ? 1 : 0),
          consecutiveFailures: failures,
          openedAt:
            failures >= CIRCUIT_BREAKER_FAILURES && !ok
              ? new Date().toISOString()
              : (state.openedAt ?? null),
        },
      };
    }).catch(() => undefined);
  }

  /** Make the thread a person's problem, visibly, with the reason attached. */
  private async fallBackToHuman(conversationId: string, reason: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { handling: 'human', handoffReason: reason },
    });
  }
}
