import { Inject, Injectable, Logger } from '@nestjs/common';

import { AdSetRulesService, type AdSetAutomationRule } from '../crm/adset-rules.service';
import { AI_RESPONDER, type AiResponder } from '../crm/ai-responder';
import { CAMPAIGN_SEND_MIN_CONFIDENCE, screenInbound } from '../crm/ai/policy';
import { PrismaService } from '../prisma/prisma.service';
import { wantsHuman } from './customer-flow';

/**
 * The campaign-scripted conversation (client, 8 Oct).
 *
 * A customer who tapped a specific advertisement gets the conversation that
 * campaign's owner configured — the exact first reply, then a free-text
 * exchange answered by the assistant FROM THE CAMPAIGN'S OWN BRIEF, guided by
 * the owner's questions. Never menus, never numbered options: the whole point
 * is that the customer types naturally.
 *
 * This service decides none of the routing. By the time it is asked, the
 * referral has been matched to a rule (`ingestInbound`) and the bot's turn has
 * been claimed (`claimBotTurn`). It answers exactly two questions: is this
 * thread campaign-scripted, and what does the campaign say next.
 *
 * ## Why the first reply is sent verbatim and the rest goes through the model
 *
 * The first reply is the campaign's opening move — the owner wrote it against
 * the ad's own promise ("Know the price" → the price), and rewording it would
 * un-approve it. Everything after is a conversation no script can enumerate,
 * which is why the scripted questionnaire was wrong for ad traffic: the model
 * answers from the brief, and anything outside the brief is a handoff, not a
 * guess.
 *
 * ## State
 *
 * None of its own. "Has the first reply gone?" is answered by the thread
 * itself (any outbound bot/ai message), so a retried webhook or a second
 * process cannot double-send the opener against a session flag that lagged.
 */
@Injectable()
export class CampaignBotService {
  private readonly logger = new Logger(CampaignBotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: AdSetRulesService,
    @Inject(AI_RESPONDER) private readonly responder: AiResponder,
  ) {}

  /**
   * The campaign script governing a conversation, or null when the thread is
   * not campaign-scripted — wrong handling, no matched rule, rule deleted or
   * disabled since, or a rule with no configured conversation. Null means the
   * caller falls back to the existing behaviour, so a tenant who configured
   * nothing notices nothing.
   */
  async scriptFor(
    organisationId: string,
    conversationId: string,
  ): Promise<AdSetAutomationRule | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organisationId },
      select: { handling: true, matchedRuleId: true },
    });
    if (!conversation || conversation.handling !== 'ai' || !conversation.matchedRuleId) {
      return null;
    }
    const rule = (await this.rules.list(organisationId)).find(
      (r) => r.id === conversation.matchedRuleId,
    );
    if (!rule || !rule.enabled || rule.handling !== 'ai') return null;
    // STRICTLY OPT-IN on the new field. `firstReply` exists only on campaigns
    // saved through the new editor, so every rule configured before this
    // feature — including ones whose old "AI prompt" box was filled when
    // nothing executed it — keeps exactly its current behaviour until somebody
    // deliberately writes the campaign's first reply.
    return rule.firstReply ? rule : null;
  }

  /**
   * One turn of the campaign conversation.
   *
   * Returns the text to send (already final — the caller only delivers and
   * records it), who authored it ('bot' for the owner's verbatim opener, 'ai'
   * for a generated reply), and/or a handoff the caller must perform.
   */
  async handle(
    organisationId: string,
    conversationId: string,
    rule: AdSetAutomationRule,
    text: string,
  ): Promise<{
    text?: string;
    authorType: 'bot' | 'ai';
    handoff?: { reason: string; note?: string };
  }> {
    // An explicit ask for a person beats everything, exactly as it does in the
    // scripted flow. The model could handle it; a deterministic check cannot
    // mis-handle it.
    if (wantsHuman(text)) {
      return {
        authorType: 'bot',
        text: 'Of course — let me get a colleague to help you. They will reply right here.',
        handoff: { reason: 'The customer asked to speak to someone.' },
      };
    }

    const outbound = await this.prisma.message.count({
      where: {
        organisationId,
        conversationId,
        direction: 'outbound',
        authorType: { in: ['bot', 'ai'] },
      },
    });

    // ── The arrival ─────────────────────────────────────────────────────────
    // The campaign's own opener, exactly as its owner wrote it, with the first
    // guiding question after a blank line when one is configured and the
    // opener does not already end by asking something.
    if (outbound === 0 && rule.firstReply) {
      const opener = rule.firstReply;
      const firstQuestion = rule.questions?.[0];
      const alreadyAsks = opener.trimEnd().endsWith('?');
      return {
        authorType: 'bot',
        text: firstQuestion && !alreadyAsks ? `${opener}\n\n${firstQuestion}` : opener,
      };
    }

    // ── The conversation ────────────────────────────────────────────────────
    // Complaints, legal threats and opt-outs never reach a model; same screen
    // as the draft path, same reason.
    const screened = screenInbound(text);
    if (screened.blocked) {
      return {
        authorType: 'bot',
        text: 'Let me get a colleague to help you with this. They will reply right here.',
        handoff: { reason: screened.reason ?? 'Screened for a person.' },
      };
    }

    if (!this.responder.isConfigured()) {
      // The opener worked without a model; a conversation cannot. Honest
      // degradation: a person takes over, with the campaign named so they know
      // what the customer was promised.
      return {
        authorType: 'bot',
        text: 'Let me get a colleague to help you with this. They will reply right here.',
        handoff: {
          reason: `Campaign "${rule.name}" conversation needs the assistant, which is not configured.`,
        },
      };
    }

    const history = await this.historyText(organisationId, conversationId);
    let reply;
    try {
      reply = await this.responder.propose({
        organisationId,
        conversationId,
        inboundText: text,
        channel: 'whatsapp',
        businessName: await this.businessName(organisationId),
        campaign: {
          name: rule.name,
          brief: rule.aiContext ?? rule.firstReply,
          guardrails: rule.aiGuardrails,
          ...(rule.questions?.length ? { questions: rule.questions } : {}),
        },
        ...(history ? { historyText: history } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `campaign reply failed on ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      reply = null;
    }

    if (!reply || !reply.text || reply.handoffReason || reply.confidence < CAMPAIGN_SEND_MIN_CONFIDENCE) {
      return {
        authorType: 'bot',
        text: 'Let me get a colleague to help you with this. They will reply right here.',
        handoff: {
          reason:
            reply?.handoffReason ??
            (reply
              ? `The assistant was not confident enough to answer (campaign "${rule.name}").`
              : `The assistant could not answer (campaign "${rule.name}").`),
        },
      };
    }

    return { authorType: 'ai', text: reply.text };
  }

  /** The recent exchange, oldest first, one line per turn, capped small. */
  private async historyText(organisationId: string, conversationId: string): Promise<string | null> {
    const rows = await this.prisma.message.findMany({
      where: { organisationId, conversationId, body: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { direction: true, body: true },
    });
    if (!rows.length) return null;
    return rows
      .reverse()
      .map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Shop'}: ${m.body}`)
      .join('\n');
  }

  private async businessName(organisationId: string): Promise<string> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { name: true },
    });
    return org?.name ?? 'this business';
  }
}
