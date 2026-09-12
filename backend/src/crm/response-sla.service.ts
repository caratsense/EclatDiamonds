import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { businessDate, resolveTz } from '../common/tz.util';

/**
 * The five-minute promise.
 *
 * From the meeting: a customer who messages must hear back within five minutes.
 * Nothing in the product measured that — a thread could sit unanswered for a day
 * and the only evidence was its position in a list.
 *
 * ── Why the clock is swept rather than hooked ────────────────────────────────
 *
 * Only ONE thing is hooked into a producer: opening the clock, on the single
 * inbound door (`ConversationsService.ingestInbound`). Everything after that —
 * has anybody replied, is it late, has it been escalated — is decided by reading
 * `Message` rows on a tick.
 *
 * That is deliberate. There are four places an outbound reply can be written
 * (the CRM composer, the omnichannel outbox, an approved AI draft, a template
 * send), and a "stop the clock" call in three of them is a silent false breach
 * waiting in the fourth. Reading the messages asks the question at the one place
 * the answer actually lives, and a producer added next month is covered without
 * anybody remembering to wire it.
 *
 * ── What counts as an answer ─────────────────────────────────────────────────
 *
 * A person (`authorType: 'agent'`) or an AI reply a person approved. NOT
 * `authorType: 'system'` — an automatic acknowledgement is the system talking to
 * itself, and letting it stop the clock would make the whole measurement report
 * success for threads no human ever saw. NOT a message that failed to send: the
 * customer never received it, so they are still waiting.
 *
 * ── Exactly once ─────────────────────────────────────────────────────────────
 *
 * The breach alert, the calling-queue task and the escalation each happen once,
 * across restarts and across replicas. Each is claimed with a conditional
 * `updateMany(... WHERE breachedAt IS NULL)`; whoever changes the row does the
 * work and everybody else sees `count: 0` and does nothing. A crash between the
 * claim and the notification loses one alert rather than sending it forever —
 * the row still reads `breached`, so the state is visible on the screen either
 * way.
 */

/** How many clocks one sweep will look at. Bounded so a backlog cannot stall the tick. */
const SWEEP_LIMIT = 500;

/** Lower bound on a target. Under a minute the sweep itself is the latency. */
const MIN_TARGET_MINUTES = 1;
const MAX_TARGET_MINUTES = 24 * 60;

const MANAGER_ROLES: Role[] = ['store_manager', 'area_manager', 'head_office'];

export interface SlaSettingsView {
  organisationId: string;
  firstResponseMinutes: number | null;
  escalateAfterMinutes: number | null;
  autoCallOnBreach: boolean;
  /** True when clocks are actually being opened. */
  active: boolean;
  /**
   * Why an automatic call would not be placed today. Non-null even when the flag
   * is on, because the flag being on is not the same as a provider existing.
   */
  autoCallBlockedReason: string | null;
}

export interface SweepOutcome {
  examined: number;
  met: number;
  breached: number;
  escalated: number;
}

@Injectable()
export class ResponseSlaService {
  private readonly log = new Logger(ResponseSlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ==========================================================================
  // Policy
  // ==========================================================================

  async settingsFor(organisationId: string): Promise<SlaSettingsView> {
    const row = await this.prisma.conversationSlaSettings.findUnique({
      where: { organisationId },
    });
    const autoCall = row?.autoCallOnBreach ?? false;
    return {
      organisationId,
      firstResponseMinutes: row?.firstResponseMinutes ?? null,
      escalateAfterMinutes: row?.escalateAfterMinutes ?? null,
      autoCallOnBreach: autoCall,
      active: row?.firstResponseMinutes != null,
      autoCallBlockedReason: autoCall
        ? await this.autoCallBlockedReason(organisationId)
        : 'Automatic calling is switched off.',
    };
  }

  async saveSettings(
    user: AuthUser,
    input: {
      firstResponseMinutes?: number | null;
      escalateAfterMinutes?: number | null;
      autoCallOnBreach?: boolean;
    },
  ): Promise<SlaSettingsView> {
    const current = await this.settingsFor(user.organisationId);
    const target =
      input.firstResponseMinutes !== undefined
        ? input.firstResponseMinutes
        : current.firstResponseMinutes;
    const escalate =
      input.escalateAfterMinutes !== undefined
        ? input.escalateAfterMinutes
        : current.escalateAfterMinutes;

    if (target != null && (target < MIN_TARGET_MINUTES || target > MAX_TARGET_MINUTES)) {
      throw new BadRequestException(
        `The reply target must be between ${MIN_TARGET_MINUTES} and ${MAX_TARGET_MINUTES} minutes.`,
      );
    }
    /*
     * Escalation is measured from the CUSTOMER'S message, not from the breach.
     * An escalation delay shorter than the target would fire before anybody was
     * late, so the manager would hear about threads that are still inside their
     * promise — which is how an escalation channel gets muted within a week.
     */
    /*
     * Switching the SLA OFF clears the escalation with it. Without this, a
     * tenant that set 5/15 and later wanted the whole thing off would be refused
     * by the rule below over a value they were not trying to keep — the feature
     * would be one nobody could turn off without knowing to send two fields.
     */
    const clearingTarget = input.firstResponseMinutes === null;
    if (escalate != null && !clearingTarget) {
      if (target == null) {
        // Setting an escalation with no target at all is a different mistake:
        // it is a value that would never fire, so it is refused rather than
        // silently dropped.
        throw new BadRequestException(
          'Set a reply target before choosing when an unanswered message reaches a manager.',
        );
      }
      if (escalate < target) {
        throw new BadRequestException(
          `Escalation is counted from the customer’s message, so it cannot be sooner than the ${target}-minute reply target.`,
        );
      }
      if (escalate > MAX_TARGET_MINUTES) {
        throw new BadRequestException(
          `Escalation cannot be more than ${MAX_TARGET_MINUTES} minutes after the message.`,
        );
      }
    }

    const data = {
      ...(input.firstResponseMinutes !== undefined
        ? { firstResponseMinutes: input.firstResponseMinutes }
        : {}),
      ...(clearingTarget
        ? { escalateAfterMinutes: null }
        : input.escalateAfterMinutes !== undefined
          ? { escalateAfterMinutes: input.escalateAfterMinutes }
          : {}),
      ...(input.autoCallOnBreach !== undefined
        ? { autoCallOnBreach: input.autoCallOnBreach }
        : {}),
      updatedById: user.id,
    };

    await this.prisma.conversationSlaSettings.upsert({
      where: { organisationId: user.organisationId },
      create: { organisationId: user.organisationId, ...data },
      update: data,
    });

    const view = await this.settingsFor(user.organisationId);
    await this.audit.record(user, {
      action: 'crm.response_sla_policy_changed',
      entityType: 'ConversationSlaSettings',
      entityId: user.organisationId,
      summary:
        view.firstResponseMinutes == null
          ? 'First-response SLA turned off'
          : `First reply now expected within ${view.firstResponseMinutes} minutes`,
      metadata: {
        firstResponseMinutes: view.firstResponseMinutes,
        escalateAfterMinutes: view.escalateAfterMinutes,
        autoCallOnBreach: view.autoCallOnBreach,
      },
    });
    return view;
  }

  /**
   * Could an automatic call actually be placed right now?
   *
   * Returns the reason it could NOT, or null when it genuinely could. Today it
   * always returns a reason: the telephony integration in this system is an
   * INBOUND webhook — it receives notifications about calls, it does not dial.
   * A connector that can dial will advertise `outboundCall` in its capabilities,
   * and only then does this return null.
   *
   * This is the whole implementation of "do not place a call unless a live
   * provider exists". It is a query, not an assumption.
   */
  private async autoCallBlockedReason(organisationId: string): Promise<string | null> {
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: 'telephony', status: 'connected' },
      select: { capabilities: true, name: true },
    });
    if (!integration) {
      return 'No telephony provider is connected, so no call can be placed.';
    }
    const caps = (integration.capabilities ?? {}) as Record<string, unknown>;
    if (caps.outboundCall !== true) {
      return `“${integration.name}” receives call notifications but cannot place calls.`;
    }
    return null;
  }

  // ==========================================================================
  // Starting the clock
  // ==========================================================================

  /**
   * A customer said something. Start the wait, unless one is already running.
   *
   * Called from the inbound ingest path and deliberately forgiving: it swallows
   * its own errors. An SLA clock is a measurement, and a measurement failing
   * must never be the reason a customer's message is not stored.
   */
  async open(input: {
    organisationId: string;
    conversationId: string;
    storeId: string | null;
    messageId: string;
    at: Date;
  }): Promise<{ id: string } | null> {
    try {
      const settings = await this.prisma.conversationSlaSettings.findUnique({
        where: { organisationId: input.organisationId },
        select: { firstResponseMinutes: true, escalateAfterMinutes: true },
      });
      const target = settings?.firstResponseMinutes ?? null;
      if (target == null) return null;

      return await this.prisma.conversationResponseSla.create({
        data: {
          organisationId: input.organisationId,
          conversationId: input.conversationId,
          storeId: input.storeId,
          triggerMessageId: input.messageId,
          openConversationId: input.conversationId,
          startedAt: input.at,
          dueAt: new Date(input.at.getTime() + target * 60_000),
          escalateAt:
            settings?.escalateAfterMinutes != null
              ? new Date(input.at.getTime() + settings.escalateAfterMinutes * 60_000)
              : null,
          targetMinutes: target,
          status: 'waiting',
        },
        select: { id: true },
      });
    } catch (err) {
      /*
       * P2002 here is the NORMAL case, twice over: a clock is already open on
       * this thread (the customer sent a second message before anybody replied),
       * or this exact inbound message has been replayed. Both mean "do nothing",
       * and neither is worth a log line.
       */
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null;
      }
      this.log.error(
        `Could not open a response clock for ${input.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ==========================================================================
  // The sweep
  // ==========================================================================

  /**
   * Settle every clock that is still owed something: answered, breached, or
   * overdue for escalation.
   *
   * Cross-tenant by default — one query for the whole estate rather than a
   * per-organisation loop, because the index it rides (`status, dueAt`) only
   * ever holds rows still waiting. A human asking for a sweep passes their own
   * organisation, so pressing the button on one floor cannot fire another
   * tenant's alerts.
   */
  async sweep(
    now = new Date(),
    opts: { organisationId?: string; limit?: number } = {},
  ): Promise<SweepOutcome> {
    const open = await this.prisma.conversationResponseSla.findMany({
      where: {
        respondedAt: null,
        status: { in: ['waiting', 'breached'] },
        // Set when a person asked for a sweep from their own floor. The
        // scheduler passes nothing and takes the whole estate.
        ...(opts.organisationId ? { organisationId: opts.organisationId } : {}),
      },
      orderBy: { dueAt: 'asc' },
      take: Math.min(Math.max(opts.limit ?? SWEEP_LIMIT, 1), SWEEP_LIMIT),
      include: {
        conversation: {
          select: {
            id: true,
            channel: true,
            partyId: true,
            assignedUserId: true,
            party: { select: { name: true } },
          },
        },
        store: { select: { id: true, name: true, timezone: true } },
      },
    });

    const outcome: SweepOutcome = { examined: open.length, met: 0, breached: 0, escalated: 0 };

    for (const clock of open) {
      try {
        const reply = await this.firstReply(clock.conversationId, clock.startedAt);
        if (reply) {
          await this.recordResponse(clock, reply);
          outcome.met++;
          continue;
        }

        if (clock.breachedAt == null && now >= clock.dueAt) {
          if (await this.claimBreach(clock, now)) outcome.breached++;
        }

        if (
          clock.escalateAt != null &&
          clock.escalatedAt == null &&
          now >= clock.escalateAt
        ) {
          if (await this.claimEscalation(clock, now)) outcome.escalated++;
        }
      } catch (err) {
        // One thread failing must not stop the rest of the estate being swept.
        this.log.error(
          `SLA sweep failed for ${clock.conversationId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return outcome;
  }

  /**
   * The first genuine reply since the customer's message, or null.
   *
   * `status: { not: 'failed' }` matters: a reply that never left the building is
   * not a reply. A queued one counts — the person did their part, and delivery
   * is the system's problem to report separately.
   */
  private async firstReply(conversationId: string, since: Date) {
    return this.prisma.message.findFirst({
      where: {
        conversationId,
        direction: 'outbound',
        sentAt: { gte: since },
        status: { not: 'failed' },
        OR: [
          { authorType: 'agent' },
          // An AI reply counts only once a person approved it — 'pending' is a
          // draft nobody has read, and 'rejected' is one somebody threw away.
          { authorType: 'ai', aiDraft: { review: { in: ['approved', 'edited'] } } },
        ],
      },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      select: { id: true, sentAt: true, authorUserId: true, authorType: true },
    });
  }

  private async recordResponse(
    clock: { id: string; startedAt: Date; breachedAt: Date | null },
    reply: { sentAt: Date; authorUserId: string | null; authorType: string },
  ) {
    const seconds = Math.max(
      0,
      Math.round((reply.sentAt.getTime() - clock.startedAt.getTime()) / 1000),
    );
    await this.prisma.conversationResponseSla.updateMany({
      where: { id: clock.id, respondedAt: null },
      data: {
        respondedAt: reply.sentAt,
        responderId: reply.authorUserId,
        responderType: reply.authorType,
        responseSeconds: seconds,
        // A late reply does not un-breach a thread. The breach happened; what
        // this adds is how long the customer actually waited for it.
        status: clock.breachedAt ? 'breached' : 'met',
        openConversationId: null,
      },
    });
  }

  /**
   * Claim the breach and do the one-time work: tell the person who owes the
   * reply, and put it in the calling queue where overdue work already lives.
   */
  private async claimBreach(
    clock: {
      id: string;
      organisationId: string;
      conversationId: string;
      storeId: string | null;
      targetMinutes: number;
      startedAt: Date;
      conversation: {
        channel: string;
        partyId: string | null;
        assignedUserId: string | null;
        party: { name: string } | null;
      };
      store: { id: string; name: string; timezone: string } | null;
    },
    now: Date,
  ): Promise<boolean> {
    const claimed = await this.prisma.conversationResponseSla.updateMany({
      where: { id: clock.id, breachedAt: null },
      data: { breachedAt: now, status: 'breached' },
    });
    // Somebody else's replica got there first. Not an error, and not our work.
    if (claimed.count === 0) return false;

    const who = clock.conversation.party?.name ?? 'A customer';
    const title = `${who} has been waiting ${clock.targetMinutes}+ minutes`;
    const body = `No reply yet on ${clock.conversation.channel}. They messaged at ${clock.startedAt.toISOString()}.`;
    const href = `/conversations?id=${clock.conversationId}`;

    /*
     * The calling queue, because that is where a shop already looks for work it
     * owes somebody. A breach that only raised a bell would be invisible to
     * whoever is working the list.
     */
    const task = await this.prisma.task.create({
      data: {
        organisationId: clock.organisationId,
        storeId: clock.storeId,
        title: `Reply overdue — ${clock.conversation.channel}`,
        detail: body,
        priority: 'urgent',
        status: 'open',
        partyId: clock.conversation.partyId,
        assigneeId: clock.conversation.assignedUserId,
        // The BRANCH's today, not the server's. A store in another timezone
        // would otherwise get a task dated tomorrow and never see it in its
        // "due today" bucket.
        dueDate: businessDate(now, resolveTz(clock.store?.timezone)),
      },
      select: { id: true },
    });
    await this.prisma.conversationResponseSla.update({
      where: { id: clock.id },
      data: { taskId: task.id },
    });

    /*
     * The assigned employee if there is one; the branch's managers if the thread
     * is unassigned. An unowned overdue conversation is the worst case, so it
     * must not be the one nobody is told about.
     */
    if (clock.conversation.assignedUserId) {
      await this.notifications.emit([clock.conversation.assignedUserId], {
        kind: 'reminder',
        title,
        body,
        href,
        storeId: clock.storeId,
        entityType: 'Conversation',
        entityId: clock.conversationId,
        priority: 'high',
        dedupeKey: `sla:breach:${clock.id}`,
      });
    } else {
      await this.notifications.emitToApprovers(
        clock.storeId,
        Role.store_manager,
        {
          kind: 'reminder',
          title: `${title} — nobody is assigned`,
          body,
          href,
          storeId: clock.storeId,
          entityType: 'Conversation',
          entityId: clock.conversationId,
          priority: 'high',
          dedupeKey: `sla:breach:${clock.id}`,
        },
        undefined,
        clock.organisationId,
      );
    }

    /*
     * An automatic call, if and only if the tenant asked for one AND a provider
     * that can dial is connected. Today `autoCallBlockedReason` always returns a
     * reason, so nothing is dialled — and the reason is logged rather than the
     * feature being quietly absent.
     */
    const settings = await this.prisma.conversationSlaSettings.findUnique({
      where: { organisationId: clock.organisationId },
      select: { autoCallOnBreach: true },
    });
    if (settings?.autoCallOnBreach) {
      const blocked = await this.autoCallBlockedReason(clock.organisationId);
      if (blocked) {
        this.log.warn(`Automatic call skipped for ${clock.conversationId}: ${blocked}`);
      }
      // No `else`. Placing the call belongs to the connector that can place it,
      // and writing a fake "called" record here is exactly the thing that would
      // make the SLA report lie.
    }
    return true;
  }

  /** Climb to the branch's managers, once. */
  private async claimEscalation(
    clock: {
      id: string;
      organisationId: string;
      conversationId: string;
      storeId: string | null;
      startedAt: Date;
      conversation: { channel: string; assignedUserId: string | null; party: { name: string } | null };
      store: { name: string } | null;
    },
    now: Date,
  ): Promise<boolean> {
    const claimed = await this.prisma.conversationResponseSla.updateMany({
      where: { id: clock.id, escalatedAt: null },
      data: { escalatedAt: now },
    });
    if (claimed.count === 0) return false;

    const waited = Math.round((now.getTime() - clock.startedAt.getTime()) / 60_000);
    const who = clock.conversation.party?.name ?? 'A customer';
    await this.notifications.emitToApprovers(
      clock.storeId,
      Role.store_manager,
      {
        kind: 'reminder',
        title: `Still unanswered after ${waited} minutes`,
        body: `${who} messaged on ${clock.conversation.channel}${
          clock.store ? ` at ${clock.store.name}` : ''
        } and nobody has replied.`,
        href: `/conversations?id=${clock.conversationId}`,
        storeId: clock.storeId,
        entityType: 'Conversation',
        entityId: clock.conversationId,
        priority: 'high',
        dedupeKey: `sla:escalation:${clock.id}`,
      },
      // The person who owes the reply already had the breach alert; the point of
      // escalating is that somebody ELSE now knows.
      clock.conversation.assignedUserId ?? undefined,
      clock.organisationId,
    );
    return true;
  }

  // ==========================================================================
  // Reading it back
  // ==========================================================================

  /**
   * The headline numbers.
   *
   * Every figure is its own aggregate against the database. None is derived from
   * a page of rows — a screen that counts breaches out of the fifty it happens to
   * be showing reports fifty, whatever the real number is.
   */
  async summary(user: AuthUser, opts: { storeId?: string; days?: number } = {}) {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const storeIds = this.scope.effectiveStoreIds(user, opts.storeId);
    const where: Prisma.ConversationResponseSlaWhereInput = {
      organisationId: user.organisationId,
      storeId: { in: storeIds },
      startedAt: { gte: since },
    };

    const [tracked, met, breached, escalated, awaiting, durations] = await Promise.all([
      this.prisma.conversationResponseSla.count({ where }),
      this.prisma.conversationResponseSla.count({ where: { ...where, status: 'met' } }),
      this.prisma.conversationResponseSla.count({ where: { ...where, status: 'breached' } }),
      this.prisma.conversationResponseSla.count({ where: { ...where, escalatedAt: { not: null } } }),
      this.prisma.conversationResponseSla.count({ where: { ...where, status: 'waiting' } }),
      this.prisma.conversationResponseSla.findMany({
        where: { ...where, responseSeconds: { not: null } },
        select: { responseSeconds: true },
        orderBy: { responseSeconds: 'asc' },
      }),
    ]);

    const values = durations.map((d) => d.responseSeconds!).filter((n) => Number.isFinite(n));
    const settings = await this.settingsFor(user.organisationId);

    return {
      windowDays: days,
      since: since.toISOString(),
      storeIds,
      targetMinutes: settings.firstResponseMinutes,
      active: settings.active,
      tracked,
      met,
      breached,
      escalated,
      awaiting,
      /*
       * Null, not 0, when nothing has been measured. Zero would read as "we
       * answer instantly"; null reads as "nothing to report", which is the truth
       * for a tenant who switched this on this morning.
       */
      answered: values.length,
      medianResponseSeconds: percentile(values, 0.5),
      p90ResponseSeconds: percentile(values, 0.9),
      withinTargetPct: tracked === 0 ? null : Math.round((met / tracked) * 1000) / 10,
    };
  }

  /** The list behind the numbers, filterable the same way. */
  async list(
    user: AuthUser,
    opts: { storeId?: string; status?: string; days?: number; limit?: number } = {},
  ) {
    if (opts.status && !['waiting', 'met', 'breached'].includes(opts.status)) {
      throw new BadRequestException('status must be waiting, met or breached.');
    }
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
    const storeIds = this.scope.effectiveStoreIds(user, opts.storeId);
    const rows = await this.prisma.conversationResponseSla.findMany({
      where: {
        organisationId: user.organisationId,
        storeId: { in: storeIds },
        startedAt: { gte: new Date(Date.now() - days * 24 * 60 * 60_000) },
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: [{ startedAt: 'desc' }],
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
      include: {
        conversation: {
          select: { id: true, channel: true, party: { select: { id: true, name: true } } },
        },
        store: { select: { id: true, name: true } },
        responder: { select: { id: true, name: true } },
      },
    });

    const full = MANAGER_ROLES.includes(user.role);
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      channel: r.conversation.channel,
      customerName: r.conversation.party?.name ?? null,
      storeId: r.storeId,
      storeName: r.store?.name ?? null,
      startedAt: r.startedAt,
      dueAt: r.dueAt,
      targetMinutes: r.targetMinutes,
      status: r.status,
      respondedAt: r.respondedAt,
      responseSeconds: r.responseSeconds,
      responderName: r.responder?.name ?? null,
      responderType: r.responderType,
      breachedAt: r.breachedAt,
      escalatedAt: r.escalatedAt,
      // A salesperson browsing the list sees that a thread breached; who
      // personally missed it is a manager's business.
      taskId: full ? r.taskId : null,
    }));
  }
}

/**
 * Nearest-rank percentile over an ALREADY SORTED array.
 *
 * Null for an empty set rather than 0 — see the note on `answered`.
 */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}
