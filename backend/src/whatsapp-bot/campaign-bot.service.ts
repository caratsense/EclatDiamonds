import { Inject, Injectable, Logger } from '@nestjs/common';

import { AdSetRulesService, type AdSetAutomationRule } from '../crm/adset-rules.service';
import { normaliseDefaultConversation } from '../crm/bot-script.service';
import { AI_RESPONDER, type AiResponder } from '../crm/ai-responder';
import {
  CAMPAIGN_AI_TURNS_MAX,
  CAMPAIGN_SEND_MIN_CONFIDENCE,
  screenInbound,
  unapprovedClaim,
} from '../crm/ai/policy';
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
 * None of its own. "Has this campaign's first reply gone?" is answered by the
 * thread itself: the opener is recorded with `payload.campaignOpener` naming
 * the campaign, so a customer who later taps a DIFFERENT advert still gets
 * that advert's opener, and a failed send does not count as sent. Turns on one
 * thread run one at a time (`oneTurnAtATime`), so two messages a second apart
 * cannot both send the opener or race two generated replies.
 */

/** Daily ceiling on generated replies per organisation, unless set in settings. */
const DEFAULT_AI_DAILY_LIMIT = 200;
const AI_DAILY_LIMIT_KEY = 'crmAiAutoSendDailyLimit';
/** The id the walk-in conversation carries in place of a campaign rule's. */
const WALK_IN_ID = '__walk_in__';
/**
 * What a campaign says when it runs out of questions and has written no
 * closing of its own. Neutral on purpose: it promises a colleague and nothing
 * about price, stock or timing that the owner did not approve.
 */
const DEFAULT_CLOSING = 'Thank you! A colleague will reply to you right here shortly.';

/**
 * One question as the customer reads it.
 *
 * Options ride INSIDE the sentence — "Which carat size — under 1, 1 to 1.5,
 * above 1.5?" — never as buttons or a numbered menu (client, 12 Oct). They are
 * hints about what the shop can discuss, not a form to fill in, and the
 * customer answers in their own words either way.
 */
function phraseQuestion(question: { text: string; options?: string[] }): string {
  const text = question.text.trim();
  if (!question.options?.length) return text;
  return `${text.replace(/\?\s*$/, '')} — ${question.options.join(', ')}?`;
}

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
    /** The rule THIS message's advert matched, when it carried one. */
    freshRuleId?: string | null,
  ): Promise<AdSetAutomationRule | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organisationId },
      select: { handling: true, matchedRuleId: true },
    });
    // 'human' is a person's thread. 'unassigned' is allowed: a thread a person
    // handed back is reclaimed as unassigned and should carry on with its
    // campaign, not fall back to the button questionnaire.
    if (!conversation || conversation.handling === 'human') return null;
    const rules = await this.rules.list(organisationId);
    const scripted = (id: string | null | undefined) => {
      const rule = id ? rules.find((r) => r.id === id) : undefined;
      // STRICTLY OPT-IN on the new field. `firstReply` exists only on campaigns
      // saved through the new editor, so every rule configured before this
      // feature — including ones whose old "AI prompt" box was filled when
      // nothing executed it — keeps exactly its current behaviour until
      // somebody deliberately writes the campaign's first reply.
      return rule && rule.enabled && rule.handling === 'ai' && rule.firstReply ? rule : null;
    };
    // The advert the customer just tapped decides first. A returning customer
    // keeps the thread (and its branch) from their first visit, so the
    // thread's own first-touch rule would answer an ad-B click from ad A's
    // brief.
    return (
      scripted(freshRuleId) ??
      scripted(await this.lastOpenerRuleId(organisationId, conversationId)) ??
      scripted(conversation.matchedRuleId)
    );
  }

  /** The campaign whose first reply this thread received most recently. */
  private async lastOpenerRuleId(organisationId: string, conversationId: string): Promise<string | null> {
    const rows = await this.prisma.message.findMany({
      where: { organisationId, conversationId, direction: 'outbound', authorType: 'bot', status: { not: 'failed' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { payload: true },
    });
    for (const row of rows) {
      const opener = (row.payload as { campaignOpener?: unknown } | null)?.campaignOpener;
      if (typeof opener === 'string') return opener;
    }
    return null;
  }

  /**
   * Run one campaign turn with the thread to itself.
   *
   * Every webhook and the five-minute sweep process pending messages, so two
   * messages a second apart can be handled at once. Without this both would
   * see no opener and send it twice, or ask the model twice in parallel. A
   * transaction-scoped advisory lock on the conversation makes the second wait
   * for the first, then see what it sent.
   */
  async oneTurnAtATime<T>(conversationId: string, turn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${conversationId}, 0))`;
        return turn();
      },
      // A model call may take up to 20 seconds; the waiting turn sits behind it.
      { maxWait: 10_000, timeout: 120_000 },
    );
  }

  /**
   * The WALK-IN script, for a customer who arrived from no advertisement
   * (client, 12 Oct): the tenant-configured default conversation, in the same
   * shape as a campaign's, so handle() treats both identically. Null when the
   * tenant has not enabled it — the legacy questionnaire then runs, so a
   * tenant who configured nothing notices nothing.
   */
  async defaultScriptFor(
    organisationId: string,
    conversationId: string,
  ): Promise<AdSetAutomationRule | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organisationId },
      select: { handling: true, matchedRuleId: true, sourceAdId: true },
    });
    // 'human' is a person's thread; everything else (unassigned, ai) may speak.
    if (!conversation || conversation.handling === 'human') return null;
    // Walk-ins only: a customer who came from an advert, scripted or not, is
    // the campaign's (or the questionnaire's), never greeted as a walk-in.
    if (conversation.matchedRuleId || conversation.sourceAdId) return null;
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    const d = normaliseDefaultConversation(settings.customerBotDefault);
    if (!d.enabled || !d.firstReply) return null;
    return {
      id: WALK_IN_ID,
      name: 'Walk-in',
      enabled: true,
      priority: 0,
      matchField: 'tag',
      matchValue: '__walk_in__',
      storeId: null,
      assignedUserId: null,
      handling: 'ai',
      firstReply: d.firstReply,
      questions: d.questions,
      aiContext: d.aiContext,
      aiGuardrails: d.aiGuardrails,
      closingMessage: d.closingMessage,
      aiReplies: d.aiReplies,
    };
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
    /** Set on the campaign's first reply: record it as `payload.campaignOpener`. */
    openerFor?: string;
    /**
     * Set when this turn ASKED one of the campaign's questions: record it as
     * `payload.campaignQuestion`. That stamp is the whole of the walker's
     * memory — how far a thread has got is read back off its own messages, so
     * a restart, a redelivered webhook or a second worker cannot lose the
     * place or ask the same question twice.
     */
    askedQuestion?: { rule: string; index: number };
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

    // Has THIS campaign's first reply gone out on this thread? Counted per
    // campaign, and never a failed send, so an earlier questionnaire or another
    // advert's opener does not swallow this one.
    const openerSent = await this.prisma.message.count({
      where: {
        organisationId,
        conversationId,
        direction: 'outbound',
        status: { not: 'failed' },
        payload: { path: ['campaignOpener'], equals: rule.id },
      },
    });

    // ── The arrival ─────────────────────────────────────────────────────────
    // The campaign's own opener, exactly as its owner wrote it, with the first
    // guiding question after a blank line when one is configured and the
    // opener does not already end by asking something.
    if (openerSent === 0 && rule.firstReply) {
      const opener = rule.firstReply;
      const first = rule.questions?.[0];
      const alreadyAsks = opener.trimEnd().endsWith('?');
      const firstQuestion = first ? phraseQuestion(first) : null;
      // An opener that already ends in a question keeps its own; the
      // configured first question is then asked on the next turn instead of
      // being lost, which is why the stamp is conditional.
      const asksNow = Boolean(firstQuestion) && !alreadyAsks;
      return {
        authorType: 'bot',
        text: asksNow ? `${opener}\n\n${firstQuestion}` : opener,
        openerFor: rule.id,
        ...(asksNow ? { askedQuestion: { rule: rule.id, index: 0 } } : {}),
      };
    }

    // ── The conversation ────────────────────────────────────────────────────
    // AI replies are an explicit choice per campaign (client, 12 Oct), and off
    // unless chosen. Off, the campaign is NOT finished after the opener: it
    // asks the questions its owner wrote, one at a time, and only then goes to
    // a person (client, 16 Oct — "each question should be asked after a user
    // answers first then second"). No model is involved on this path, so a
    // deployment with no AI provider still runs its scripts in full.
    if (rule.aiReplies !== true) {
      return this.scriptedTurn(organisationId, conversationId, rule);
    }

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

    // Ceilings: per thread, so a long exchange reaches a person and two
    // auto-responders cannot talk for ever; per organisation per day, so a
    // runaway costs a day's limit, not an invoice.
    const ceiling = await this.overCeiling(organisationId, conversationId);
    if (ceiling) {
      return {
        authorType: 'bot',
        text: 'Let me get a colleague to help you with this. They will reply right here.',
        handoff: { reason: ceiling },
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
          ...(rule.id === WALK_IN_ID ? { walkIn: true } : {}),
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

    // Nothing goes out stating a figure or an offer the owner did not write.
    const approved = [
      rule.aiContext,
      rule.firstReply,
      ...(rule.questions ?? []).flatMap((q) => [q.text, ...(q.options ?? [])]),
    ]
      .filter(Boolean)
      .join('\n');
    const unapproved = unapprovedClaim(reply.text, approved);
    if (unapproved) {
      return {
        authorType: 'bot',
        text: 'Let me get a colleague to help you with this. They will reply right here.',
        handoff: { reason: unapproved, note: `The assistant had drafted: ${reply.text}` },
      };
    }

    return { authorType: 'ai', text: reply.text };
  }

  /**
   * One turn of a campaign that does NOT use the assistant.
   *
   * The opener has already gone. Each customer message moves the script on by
   * exactly one question, in the order its owner wrote them, and when they run
   * out the campaign closes in its own words and the thread goes to a person
   * with every answer already in it.
   *
   * Deliberately deterministic. A client can read their own script and know
   * precisely what a customer will see, which is worth more on an ad they are
   * paying for than a fluent answer nobody predicted — and it works with no AI
   * provider configured at all.
   */
  private async scriptedTurn(
    organisationId: string,
    conversationId: string,
    rule: AdSetAutomationRule,
  ): Promise<{
    text?: string;
    authorType: 'bot' | 'ai';
    handoff?: { reason: string; note?: string };
    askedQuestion?: { rule: string; index: number };
  }> {
    const questions = rule.questions ?? [];
    const asked = await this.questionsAsked(organisationId, conversationId, rule.id);
    const next = questions[asked];
    if (next) {
      return {
        authorType: 'bot',
        text: phraseQuestion(next),
        askedQuestion: { rule: rule.id, index: asked },
      };
    }

    // Out of questions — or there never were any, which is the behaviour every
    // campaign had before this walker existed.
    return {
      authorType: 'bot',
      text: rule.closingMessage?.trim() || DEFAULT_CLOSING,
      handoff: {
        reason: questions.length
          ? `Campaign "${rule.name}" asked all ${questions.length} of its questions; a person continues.`
          : `Campaign "${rule.name}" has no questions after its first reply; a person continues.`,
      },
    };
  }

  /**
   * How many of THIS campaign's questions this thread has already been asked.
   *
   * Counted off the thread rather than held in a session row: the questions go
   * out in order and each is stamped, so the count IS the next index. A failed
   * send is not counted, so a question the customer never received is asked
   * again rather than skipped.
   */
  private async questionsAsked(
    organisationId: string,
    conversationId: string,
    ruleId: string,
  ): Promise<number> {
    return this.prisma.message.count({
      where: {
        organisationId,
        conversationId,
        direction: 'outbound',
        status: { not: 'failed' },
        payload: { path: ['campaignQuestion', 'rule'], equals: ruleId },
      },
    });
  }

  /** Why no more generated replies may go out now, or null. */
  private async overCeiling(organisationId: string, conversationId: string): Promise<string | null> {
    const generated = { direction: 'outbound', authorType: 'ai', status: { not: 'failed' } } as const;
    const onThread = await this.prisma.message.count({
      where: { organisationId, conversationId, ...generated },
    });
    if (onThread >= CAMPAIGN_AI_TURNS_MAX) {
      return `The assistant has answered ${onThread} times on this thread; a person continues from here.`;
    }
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const set = Number(((org?.settings ?? {}) as Record<string, unknown>)[AI_DAILY_LIMIT_KEY]);
    const limit = Number.isFinite(set) && set > 0 ? Math.min(set, 10_000) : DEFAULT_AI_DAILY_LIMIT;
    const today = new Date(new Date().toISOString().slice(0, 10));
    const sentToday = await this.prisma.message.count({
      where: { organisationId, createdAt: { gte: today }, ...generated },
    });
    if (sentToday >= limit) {
      return `The assistant has sent this organisation's ${limit} replies for today; a person continues.`;
    }
    return null;
  }

  /** The recent exchange, oldest first, one line per turn, capped small. */
  private async historyText(organisationId: string, conversationId: string): Promise<string | null> {
    // Only what the customer said and what actually went to them: an unsent
    // draft or a failed send presented as "Shop:" would be a line the
    // customer never saw.
    const rows = await this.prisma.message.findMany({
      where: {
        organisationId,
        conversationId,
        body: { not: null },
        OR: [
          { direction: 'inbound' },
          { direction: 'outbound', status: { in: ['queued', 'sent', 'delivered', 'read'] } },
        ],
      },
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
