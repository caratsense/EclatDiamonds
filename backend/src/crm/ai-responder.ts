import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';
import { KnowledgeRetrievalService } from './ai/knowledge-retrieval';
import { MIN_CONFIDENCE, POLICY_VERSION, screenInbound } from './ai/policy';
import { updateOrgSettings } from '../config/org-settings';

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
    | 'no_knowledge';          // nothing to answer from, so nothing is invented
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
    await this.prisma.$transaction(async (tx) => {
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

    return { invoked: true, outcome: 'replied_draft', reason: 'Draft stored for review; nothing was sent.' };
  }

  /** Make the thread a person's problem, visibly, with the reason attached. */
  private async fallBackToHuman(conversationId: string, reason: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { handling: 'human', handoffReason: reason },
    });
  }
}
