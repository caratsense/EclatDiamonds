import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped } from '../common/sales-scope';
import { ActivityService } from './activity.service';
import { CrmAiProvider } from './crm-ai.provider';
import {
  DEFAULT_QUALIFICATION_POLICY,
  bandForScore,
  matchSignals,
  resolvePolicy,
  scoreSignals,
  type QualificationPolicy,
  type SignalResult,
} from './qualification-policy';
import { updateOrgSettings } from '../config/org-settings';

/**
 * CRM qualification (Phase A9) — conversation → signals → score → action.
 *
 * The pipeline, and which part is allowed to decide what:
 *
 *   transcript ─┬─ AI provider ──┐
 *               └─ phrase match ─┴─► signals ─► TENANT POLICY ─► score
 *                                                              ─► band
 *                                                              ─► action
 *                                                              ─► handoff?
 *
 * The extraction step is interchangeable and may be absent. The policy step is
 * never absent and is never the platform's. That split is the whole design: it
 * means "why is this lead hot?" always has an answer made of the customer's own
 * rules and quoted evidence, whether or not a model was involved.
 *
 * STORAGE: every assessment is a new row, never an update. A score is a
 * statement about a moment — overwriting it would destroy the record of what the
 * business was told at the time it acted.
 */
/**
 * Who asked for a score.
 *
 * `user` is null when the QUALIFICATION BOT scored a conversation on its own,
 * which is the normal case for an ad click at two in the morning. Kept as an
 * explicit null rather than a stand-in account: a timeline entry naming a
 * person who never opened the thread is a fabricated audit trail, and
 * `createdById` is nullable precisely so this can be recorded honestly.
 */
export interface QualificationActor {
  organisationId: string;
  user: AuthUser | null;
}

@Injectable()
export class QualificationService {
  private readonly log = new Logger(QualificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly ai: CrmAiProvider,
  ) {}

  /* ------------------------------------------------------------- policy */

  /**
   * The tenant's policy, merged over the platform defaults.
   *
   * Held in `Organisation.settings.crmQualification` rather than its own table:
   * it is a nested document of weights and phrases that is read whole and never
   * queried across, so columns would buy nothing and cost a migration every time
   * a tenant wants a new field.
   */
  async policyFor(organisationId: string): Promise<QualificationPolicy> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    return resolvePolicy(settings.crmQualification);
  }

  /** Policy + provider state, for the configuration screen. */
  async describe(user: AuthUser) {
    const policy = await this.policyFor(user.organisationId);
    return {
      policy,
      defaults: DEFAULT_QUALIFICATION_POLICY,
      provider: {
        available: this.ai.available,
        reason: this.ai.unavailableReason,
        /**
         * The honest framing. Without a provider this is not "AI off, feature
         * broken" — it is exact keyword matching, which is more literal but
         * fully explainable and costs nothing.
         */
        mode: this.ai.available ? ('ai' as const) : ('rules' as const),
      },
    };
  }

  /** Replace the policy. Head-office only — it decides how everyone's leads are ranked. */
  async savePolicy(user: AuthUser, input: Partial<QualificationPolicy>) {
    /*
     * Everything — including the version bump — happens under the row lock.
     *
     * The policy version is read-modify-write too, and it is the one field that
     * cannot be fixed by merging JSON in SQL: two concurrent saves would each
     * read version N and each store N+1, so two different policies would claim
     * the same version and `policyOutdated` would stop detecting one of them.
     * Reading `current` INSIDE the lock is what makes the counter honest.
     */
    let next!: ReturnType<typeof resolvePolicy>;
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => {
      const current = resolvePolicy(settings.crmQualification);
      // Version is owned by the server: a client that could set it could make an
      // old assessment claim to have been produced by today's rules.
      next = resolvePolicy({ ...current, ...input, version: current.version + 1 });
      return { ...settings, crmQualification: next as unknown as Record<string, unknown> };
    });
    await this.audit.record(user, {
      action: 'crm.qualification_policy_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `Updated the lead qualification policy (now version ${next.version})`,
      metadata: { version: next.version, enabled: next.enabled },
    });
    return next;
  }

  /* -------------------------------------------------------- assessment */

  /**
   * Assess one conversation.
   *
   * Returns an `unavailable` result rather than throwing when it cannot produce
   * a score — disabled policy, too little text, nothing to read. Those are real
   * answers a UI should show as themselves, and a thrown error would turn an
   * ordinary "not enough to go on" into an incident.
   */
  /**
   * Score a conversation the BOT is handling, with no user behind the request.
   *
   * The score decides whether a qualified lead reaches a person while they are
   * still typing, rather than waiting for somebody to notice the thread. Until
   * this existed, `handoffAtScore` was configurable, documented and never read
   * by anything — the bot handed over only on "call me", two unreadable
   * answers, or a returning customer.
   *
   * Returns null rather than throwing. A scoring failure must never cost the
   * customer their reply: the bot has already answered by the time this runs,
   * and an exception here would fail the webhook and have Meta redeliver the
   * message.
   */
  async assessFromBot(
    organisationId: string,
    conversationId: string,
  ): Promise<{ score: number | null; band: string | null; handoff: boolean; reason: string | null } | null> {
    try {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: conversationId, organisationId },
        select: {
          id: true,
          partyId: true,
          messages: {
            orderBy: { sentAt: 'asc' },
            take: 200,
            select: { direction: true, body: true },
          },
        },
      });
      if (!conversation) return null;

      // Only what the CUSTOMER said — the same rule as the interactive path.
      // Including the bot's own questions would let "What is your approximate
      // budget?" fire a budget signal on every single thread.
      const inbound = conversation.messages.filter((m) => m.direction === 'inbound' && m.body?.trim());
      const transcript = inbound.map((m) => m.body).join('\n');

      const lead = conversation.partyId
        ? await this.prisma.lead.findFirst({
            where: { organisationId, partyId: conversation.partyId, outcome: 'open' },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
        : null;

      const view = await this.assess(
        { organisationId, user: null },
        {
          conversationId: conversation.id,
          partyId: conversation.partyId,
          leadId: lead?.id ?? null,
          transcript,
          messageCount: inbound.length,
        },
      );

      return {
        score: view.score ?? null,
        band: view.band ?? null,
        handoff: Boolean(view.handoffRequested),
        reason: view.handoffReason ?? null,
      };
    } catch (err) {
      this.log.warn(
        `bot scoring failed for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async assessConversation(user: AuthUser, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organisationId: user.organisationId },
      select: {
        id: true,
        partyId: true,
        storeId: true,
        channel: true,
        messages: {
          orderBy: { sentAt: 'asc' },
          take: 200,
          select: { direction: true, body: true, sentAt: true },
        },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    // The same rule as opening the thread: a routed thread in scope (assigned to
    // them, for a salesperson), an unrouted one only for head office.
    const reachable = await this.prisma.conversation.count({
      where: { id: conversation.id, ...this.readableConversation(user) },
    });
    if (!reachable) throw new NotFoundException('Conversation not found');

    // Only what the CUSTOMER said. Including our own replies would let the
    // business's own sales language ("are you ready to buy?") fire the signals
    // it is supposed to be detecting in the customer.
    const inbound = conversation.messages.filter((m) => m.direction === 'inbound' && m.body?.trim());
    const transcript = inbound.map((m) => m.body).join('\n');

    // A lead linked to this customer, so the assessment attaches to the funnel
    // record a salesperson actually works from.
    const lead = conversation.partyId
      ? await this.prisma.lead.findFirst({
          where: { organisationId: user.organisationId, partyId: conversation.partyId, outcome: 'open' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
      : null;

    return this.assess({ organisationId: user.organisationId, user }, {
      conversationId: conversation.id,
      partyId: conversation.partyId,
      leadId: lead?.id ?? null,
      transcript,
      messageCount: inbound.length,
    });
  }

  /** Assess a lead from its notes and any linked conversation text. */
  async assessLead(user: AuthUser, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, organisationId: user.organisationId },
      select: {
        id: true,
        partyId: true,
        storeId: true,
        interest: true,
        notes: { orderBy: { createdAt: 'asc' }, take: 100, select: { text: true } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    this.scope.assertStoreAllowed(user, lead.storeId);
    if (isSalesScoped(user) && !(await this.prisma.lead.count({ where: { id: lead.id, ownerId: user.id } }))) {
      throw new NotFoundException('Lead not found');
    }

    const parts = [lead.interest ?? '', ...lead.notes.map((n) => n.text)].filter(Boolean);
    return this.assess({ organisationId: user.organisationId, user }, {
      conversationId: null,
      partyId: lead.partyId,
      leadId: lead.id,
      transcript: parts.join('\n'),
      messageCount: parts.length,
    });
  }

  /**
   * The shared assessment path. Everything above assembles a transcript; this
   * turns it into a stored, explainable verdict.
   */
  private async assess(
    actor: QualificationActor,
    input: {
      conversationId: string | null;
      partyId: string | null;
      leadId: string | null;
      transcript: string;
      messageCount: number;
    },
  ) {
    const policy = await this.policyFor(actor.organisationId);

    if (!policy.enabled) {
      return this.storeUnavailable(actor, input, policy, 'Lead qualification is switched off for this organisation.');
    }
    if (input.messageCount < policy.minMessagesToScore) {
      return this.storeUnavailable(
        actor,
        input,
        policy,
        `Not enough to go on yet — ${input.messageCount} message${input.messageCount === 1 ? '' : 's'} where your policy asks for at least ${policy.minMessagesToScore}.`,
      );
    }
    if (!input.transcript.trim()) {
      return this.storeUnavailable(actor, input, policy, 'There is no customer text to read.');
    }

    // Extraction: the model if configured, otherwise the tenant's own phrases.
    // Both produce the same `SignalResult[]`, so everything downstream is
    // identical and a score means the same thing either way.
    const extracted = await this.ai.extract(policy, input.transcript);
    const signals: SignalResult[] = extracted?.signals ?? matchSignals(policy, input.transcript);
    const method = extracted ? 'ai' : 'rules';

    const { score, band, fired, handoff } = scoreSignals(policy, signals);

    // Confidence: the model's own number when it gave one; otherwise derived
    // from how much evidence actually fired. Deliberately NOT a constant — a
    // fixed 0.9 next to every rules-based score would be a fabricated claim
    // about certainty.
    const confidence =
      extracted?.confidence ??
      Math.min(1, fired.length / Math.max(3, Math.ceil(policy.signals.length / 3)));

    const lowConfidence = confidence < policy.confidenceThreshold;

    const row = await this.prisma.leadQualification.create({
      data: {
        organisationId: actor.organisationId,
        partyId: input.partyId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        method,
        score,
        confidence: new Prisma.Decimal(confidence.toFixed(3)),
        band: band?.key ?? null,
        // Below the tenant's confidence threshold we report the score but
        // withhold the recommendation. Acting on thin evidence is the failure
        // mode the threshold exists to prevent.
        recommendedAction: lowConfidence
          ? 'Not enough evidence to recommend an action yet.'
          : (band?.recommendedAction ?? null),
        handoffRequested: handoff.requested && !lowConfidence,
        handoffReason: handoff.reason,
        signals: signals as unknown as Prisma.InputJsonValue,
        requirements: (extracted?.requirements ?? {}) as Prisma.InputJsonValue,
        summary: policy.summarise ? (extracted?.summary ?? this.ruleSummary(fired, band?.label ?? null)) : null,
        policyVersion: policy.version,
        provider: extracted?.provider ?? null,
        model: extracted?.model ?? null,
        messagesConsidered: input.messageCount,
        createdById: actor.user?.id ?? null,
      },
    });

    // A best-effort projection, exactly like every other activity write: the
    // qualification itself is already saved, and a timeline failure must not
    // undo it.
    // No activity row when the BOT scored it. `recordFor` is written around an
    // acting user, and a timeline entry claiming a person qualified this lead
    // when nobody looked at it would be a fabricated audit trail. The
    // LeadQualification row itself is the record, and it carries the method.
    if (input.partyId && actor.user) {
      this.activity
        .recordFor(actor.user, {
          type: 'lead.qualified',
          partyId: input.partyId,
          leadId: input.leadId ?? undefined,
          summary: `Qualified as ${band?.label ?? 'unscored'} (${score}/100) by ${method === 'ai' ? 'AI' : 'your rules'}`,
          entityType: 'LeadQualification',
          entityId: row.id,
          metadata: { score, band: band?.key ?? null, method },
        })
        .catch((e) => this.log.warn(`qualification activity not recorded: ${e.message}`));
    }

    return this.toView(row, policy, lowConfidence);
  }

  /** A readable summary built from the rules alone, when no model wrote one. */
  private ruleSummary(fired: SignalResult[], bandLabel: string | null): string {
    if (fired.length === 0) return 'Nothing in your signal list came up in this conversation.';
    const names = fired.map((f) => f.label.toLowerCase());
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `Matched ${list}${bandLabel ? `, which your policy treats as “${bandLabel}”` : ''}.`;
  }

  /**
   * Record that no score could be produced, and why.
   *
   * Stored rather than returned-and-forgotten: "we looked and could not tell"
   * is information, and without the row the UI cannot distinguish it from
   * "nobody has looked yet".
   */
  private async storeUnavailable(
    actor: QualificationActor,
    input: { conversationId: string | null; partyId: string | null; leadId: string | null; messageCount: number },
    policy: QualificationPolicy,
    reason: string,
  ) {
    const row = await this.prisma.leadQualification.create({
      data: {
        organisationId: actor.organisationId,
        partyId: input.partyId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        method: this.ai.available ? 'ai' : 'rules',
        // score stays NULL. A zero would read as "cold", and "we could not
        // assess" is not the same statement as "this lead is worthless".
        score: null,
        unavailableReason: reason,
        policyVersion: policy.version,
        messagesConsidered: input.messageCount,
        createdById: actor.user?.id ?? null,
      },
    });
    return this.toView(row, policy, false);
  }

  /* ---------------------------------------------------- a person's score */

  /**
   * Record a person's own judgement of a lead, over the top of the assistant's.
   *
   * THE ASSISTANT'S ROW IS NOT TOUCHED. This appends, exactly as every other
   * assessment does, and the panel shows the newest — so the manager's score
   * becomes the current one while the machine's stays underneath it. Overwriting
   * would destroy the only evidence of what the business was told at the moment
   * it acted, and would let a bad score be quietly tidied away by the person it
   * embarrassed.
   *
   * It also leaves the question open, permanently and cheaply: with both rows
   * kept, whether the branch or the model reads customers better is something
   * the data can answer in six months. Overwrite, and nobody can ever ask.
   *
   * What is deliberately NOT recorded:
   *
   *   - `confidence` stays null. A person's certainty is not a measured
   *     quantity, and a hard-coded 1.0 would be a fabricated claim sitting in
   *     the same column as the model's real ones.
   *   - `signals` is empty. Nothing fired; somebody decided. The reason they
   *     give is the evidence, and it is stored as the summary.
   *   - `messagesConsidered` is 0. We know what they were shown, not what they
   *     read, and the panel omits the line for a human score rather than
   *     claiming a number.
   */
  async setManualScore(
    user: AuthUser,
    target: { conversationId?: string; leadId?: string },
    input: { score: number; reason: string },
  ) {
    if (!target.conversationId && !target.leadId) {
      throw new BadRequestException('Score a conversation or a lead.');
    }

    // Reach the subject under the SAME rule that governs opening it, so this
    // cannot become a side door onto another branch's customers.
    const subject = target.conversationId
      ? await this.prisma.conversation.findFirst({
          where: {
            id: target.conversationId,
            organisationId: user.organisationId,
            ...this.readableConversation(user),
          },
          select: { id: true, partyId: true, storeId: true },
        })
      : await this.prisma.lead.findFirst({
          where: {
            id: target.leadId,
            organisationId: user.organisationId,
            storeId: { in: user.storeIds },
            ...(isSalesScoped(user) ? { ownerId: user.id } : {}),
          },
          select: { id: true, partyId: true, storeId: true },
        });
    if (!subject) {
      throw new NotFoundException(target.conversationId ? 'Conversation not found' : 'Lead not found');
    }

    const policy = await this.policyFor(user.organisationId);
    const score = Math.max(0, Math.min(100, Math.round(input.score)));
    const band = bandForScore(policy, score);
    const reason = input.reason.trim();

    // The same escalation rule the signal path uses. A band that asks for a
    // person still asks for one when a person set the score — otherwise the
    // tenant's own escalation policy would mean two different things depending
    // on who typed the number.
    const handoffByScore = policy.handoffAtScore != null && score >= policy.handoffAtScore;

    // A conversation carries its own lead, so the score attaches to the funnel
    // record a salesperson actually works from — the same link `assess` makes.
    const leadId = target.leadId
      ? subject.id
      : subject.partyId
        ? ((
            await this.prisma.lead.findFirst({
              where: { organisationId: user.organisationId, partyId: subject.partyId, outcome: 'open' },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            })
          )?.id ?? null)
        : null;

    const row = await this.prisma.leadQualification.create({
      data: {
        organisationId: user.organisationId,
        partyId: subject.partyId,
        leadId,
        conversationId: target.conversationId ?? null,
        method: 'human',
        score,
        confidence: null,
        band: band?.key ?? null,
        recommendedAction: band?.recommendedAction ?? null,
        handoffRequested: handoffByScore || !!band?.requestHandoff,
        handoffReason: handoffByScore
          ? `Score ${score} is at or above the escalation threshold of ${policy.handoffAtScore}.`
          : band?.requestHandoff
            ? `The “${band.label}” band asks for a person.`
            : null,
        signals: [] as unknown as Prisma.InputJsonValue,
        requirements: {} as Prisma.InputJsonValue,
        summary: reason,
        policyVersion: policy.version,
        provider: null,
        model: null,
        messagesConsidered: 0,
        createdById: user.id,
      },
    });

    // An override is a management action on a customer record, so it is audited
    // as well as put on the timeline — the timeline is a working view and can be
    // filtered; the audit log is the one nobody can curate.
    await this.audit.record(user, {
      action: 'crm.qualification_scored_by_hand',
      entityType: 'LeadQualification',
      entityId: row.id,
      summary: `Scored ${score}/100 by hand${band ? ` (${band.label})` : ''} — ${reason}`,
      metadata: {
        score,
        band: band?.key ?? null,
        conversationId: target.conversationId ?? null,
        leadId,
      },
    });

    if (subject.partyId) {
      this.activity
        .recordFor(user, {
          type: 'lead.qualified',
          partyId: subject.partyId,
          leadId: leadId ?? undefined,
          storeId: subject.storeId ?? undefined,
          summary: `Scored ${score}/100 by hand — ${band?.label ?? 'unbanded'}`,
          entityType: 'LeadQualification',
          entityId: row.id,
          metadata: { score, band: band?.key ?? null, method: 'human', reason },
        })
        .catch((e) => this.log.warn(`manual qualification activity not recorded: ${e.message}`));
    }

    return this.toView(row, policy, false, user.name);
  }

  /* ------------------------------------------------------------- reads */

  /** The latest assessment for a customer or lead, with its policy context. */
  async latestFor(user: AuthUser, target: { partyId?: string; leadId?: string; conversationId?: string }) {
    if (!target.partyId && !target.leadId && !target.conversationId) {
      throw new BadRequestException('Ask for a customer, a lead or a conversation.');
    }
    const row = await this.prisma.leadQualification.findFirst({
      where: {
        organisationId: user.organisationId,
        ...this.readableAssessment(user),
        ...(target.partyId ? { partyId: target.partyId } : {}),
        ...(target.leadId ? { leadId: target.leadId } : {}),
        ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    const policy = await this.policyFor(user.organisationId);
    const names = await this.authorNames([row.createdById]);
    return this.toView(row, policy, false, row.createdById ? (names.get(row.createdById) ?? null) : null);
  }

  /** History for one subject — how an assessment moved as a conversation went on. */
  async historyFor(user: AuthUser, target: { partyId?: string; leadId?: string }, limit = 20) {
    const rows = await this.prisma.leadQualification.findMany({
      where: {
        organisationId: user.organisationId,
        ...this.readableAssessment(user),
        ...(target.partyId ? { partyId: target.partyId } : {}),
        ...(target.leadId ? { leadId: target.leadId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    const policy = await this.policyFor(user.organisationId);
    const names = await this.authorNames(rows.map((r) => r.createdById));
    return rows.map((r) =>
      this.toView(r, policy, false, r.createdById ? (names.get(r.createdById) ?? null) : null),
    );
  }

  /** Threads this caller may read — the inbox rule. */
  private readableConversation(user: AuthUser): Prisma.ConversationWhereInput {
    const inStores = { storeId: { in: user.storeIds } };
    if (isSalesScoped(user)) return { audience: 'customer', ...inStores, assignedUserId: user.id };
    return user.role === 'head_office'
      ? { audience: 'customer', OR: [inStores, { storeId: null }] }
      : { audience: 'customer', ...inStores };
  }

  /**
   * Assessments this caller may read: those on a lead or a thread they can
   * reach. These were read by organisation alone, so any id — or none, which
   * returned the organisation's latest twenty — showed another branch's
   * customers and their AI summaries.
   */
  private readableAssessment(user: AuthUser): Prisma.LeadQualificationWhereInput {
    return {
      OR: [
        {
          lead: {
            storeId: { in: user.storeIds },
            ...(isSalesScoped(user) ? { ownerId: user.id } : {}),
          },
        },
        { conversation: this.readableConversation(user) },
      ],
    };
  }

  private toView(
    row: {
      id: string;
      method: string;
      score: number | null;
      confidence: Prisma.Decimal | null;
      band: string | null;
      recommendedAction: string | null;
      handoffRequested: boolean;
      handoffReason: string | null;
      signals: Prisma.JsonValue;
      requirements: Prisma.JsonValue;
      summary: string | null;
      policyVersion: number;
      provider: string | null;
      model: string | null;
      unavailableReason: string | null;
      messagesConsidered: number;
      createdAt: Date;
      createdById: string | null;
      partyId: string | null;
      leadId: string | null;
      conversationId: string | null;
    },
    policy: QualificationPolicy,
    lowConfidence: boolean,
    /**
     * Who set it, when a person did. Resolved by the caller rather than joined:
     * `LeadQualification.createdById` carries no FK, so there is no relation to
     * include, and adding one for a label is not worth a migration.
     */
    authorName: string | null = null,
  ) {
    const signals = (Array.isArray(row.signals) ? row.signals : []) as unknown as SignalResult[];
    const bandDef = policy.bands.find((b) => b.key === row.band) ?? null;
    return {
      id: row.id,
      partyId: row.partyId,
      leadId: row.leadId,
      conversationId: row.conversationId,
      available: row.unavailableReason == null,
      unavailableReason: row.unavailableReason,
      method: row.method,
      score: row.score,
      confidence: row.confidence != null ? Number(row.confidence) : null,
      lowConfidence: lowConfidence || (row.confidence != null && Number(row.confidence) < policy.confidenceThreshold),
      band: row.band,
      // Resolved through the CURRENT policy for display, while `band` keeps the
      // key that was stored. A renamed band shows its new name; a deleted one
      // falls back to its key rather than rendering blank.
      bandLabel: bandDef?.label ?? row.band,
      recommendedAction: row.recommendedAction,
      handoffRequested: row.handoffRequested,
      handoffReason: row.handoffReason,
      /** Only what fired — the "why". The full list is on the policy screen. */
      firedSignals: signals.filter((s) => s?.matched),
      requirements: (row.requirements ?? {}) as Record<string, string>,
      summary: row.summary,
      policyVersion: row.policyVersion,
      /** Stale when the policy has moved on since this was produced. */
      policyOutdated: row.policyVersion !== policy.version,
      provider: row.provider,
      model: row.model,
      messagesConsidered: row.messagesConsidered,
      createdAt: row.createdAt,
      createdById: row.createdById,
      /** Null for anything the assistant produced on its own. */
      authorName,
    };
  }

  /**
   * Display names for the people who set these scores.
   *
   * One query for the whole set, and a missing user resolves to null rather
   * than to a placeholder: a deactivated account should read as "scored by
   * hand" with no name, not as somebody who still works here.
   */
  private async authorNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
