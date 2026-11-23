import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { businessDate, resolveTz } from '../common/tz.util';
import { ChannelAdaptersService } from '../integrations/adapters/channel-adapters.service';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AfterVisitPolicy,
  SECOND_ASK_REASONS,
  FeedbackService,
  afterVisitStepDueAt,
  secondAskOutcome,
  secondAskStep,
  stepOffsetMinutes,
} from './feedback.service';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** A visit ask whose dispatch keeps throwing is given up on, and says so. */
const MAX_DISPATCH_ATTEMPTS = 5;
/** How long the response link stays open after it is due. */
const RESPONSE_WINDOW_DAYS = 30;
/**
 * How long after its hour the second request may still go out.
 *
 * A courtesy chaser half a day late is not a chaser any more — it is a message
 * out of nowhere about a visit that is now three days old. This is also what
 * bounds the retries: `dispatchAttempts` counts attempts for the FIRST request
 * only, so the second one is bounded by the clock instead of by a counter.
 */
const SECOND_ASK_GRACE_HOURS = 12;
/**
 * Refusals that mean "do not contact this person", not "WhatsApp is not ready".
 * The first kind cancels the ask outright; handing it to a colleague to make by
 * phone would ignore exactly what the customer asked for.
 */
const DO_NOT_CONTACT = new Set(['recipient_opted_out', 'consent_required', 'recipient_archived']);

/**
 * The automatic "how was your visit?" a set number of days after a walk-in that
 * ended WITHOUT a follow-up.
 *
 * It is a feedback request, not a sales follow-up: it lives in FeedbackRequest,
 * never on the lead's call queue, and nothing about it is labelled as chasing a
 * sale. A visit that booked a follow-up already has a person coming back to the
 * customer, and asking for feedback on top of that would be two messages about
 * one visit.
 *
 * Delivery goes through the omnichannel outbox like any other customer message.
 * When WhatsApp cannot carry it — no approved template, no public link, a
 * disconnected sender — the ask becomes a task for the person who served them,
 * with the reason, and is never recorded as sent.
 *
 * ## Two requests, not one
 *
 * The client asked for a second, later one: "there are two templates that will
 * go. One just after a day a customer visits ... and second would go after 48
 * hours." Both delays are measured from the visit, each step has its own
 * template, and the second is planned (`reminderDueAt`) only once the first has
 * actually left on WhatsApp. `sweepSecondAsk` decides whether it still goes
 * when its hour comes, and `secondAskOutcome` in feedback.service.ts is that
 * decision — written as a pure rule, because the cost of getting it wrong is
 * not an error anybody sees but a customer being nagged after they answered.
 */
@Injectable()
export class VisitFeedbackService {
  private readonly log = new Logger(VisitFeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly feedback: FeedbackService,
    @Inject(forwardRef(() => OmnichannelService))
    private readonly omnichannel: OmnichannelService,
    private readonly config: ConfigService,
    private readonly adapters: ChannelAdaptersService,
  ) {}

  /**
   * Book the ask when a visit closes. Idempotent per visit.
   *
   * The due instant is the tenant's send time on the Nth local day after the
   * visit ended, at the branch — a customer who left at 23:30 on the 1st in
   * Kolkata is asked on the 8th, not the 7th because the server was in UTC.
   */
  async scheduleAfterVisit(input: {
    organisationId: string;
    checkIn: { id: string; storeId: string; partyId: string | null };
    closedAt: Date;
    timezone: string | null | undefined;
    createdById: string;
  }): Promise<{ scheduled: boolean; reason: string; scheduledFor?: Date }> {
    const policy = await this.feedback.afterVisitPolicy(input.organisationId);
    if (!policy.enabled) return { scheduled: false, reason: 'Visit feedback is off for this organisation.' };
    if (!input.checkIn.partyId) {
      return { scheduled: false, reason: 'The visit has no customer record to ask.' };
    }

    const open = await this.prisma.feedbackRequest.findFirst({
      where: {
        organisationId: input.organisationId,
        partyId: input.checkIn.partyId,
        status: { in: ['scheduled', 'processing', 'pending', 'sent'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: input.closedAt } }],
      },
      select: { id: true },
    });
    if (open) return { scheduled: false, reason: 'The customer already has an open feedback request.' };

    // The first step's own delay. The second one is not booked here: it is
    // planned only once this one has actually reached the customer, which is
    // the whole reason a chaser cannot go out on its own.
    const scheduledFor = afterVisitStepDueAt(input.closedAt, input.timezone, policy.steps[0]);

    try {
      await this.prisma.feedbackRequest.create({
        data: {
          organisationId: input.organisationId,
          storeId: input.checkIn.storeId,
          partyId: input.checkIn.partyId,
          checkInId: input.checkIn.id,
          origin: 'visit_auto',
          status: 'scheduled',
          scheduledFor,
          dedupeKey: `visit-feedback:${input.checkIn.id}`,
          publicKey: randomBytes(24).toString('base64url'),
          expiresAt: new Date(scheduledFor.getTime() + RESPONSE_WINDOW_DAYS * DAY_MS),
          createdById: input.createdById,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { scheduled: false, reason: 'Feedback for this visit is already booked.' };
      }
      throw error;
    }
    return { scheduled: true, reason: 'Booked.', scheduledFor };
  }

  /**
   * Send every ask that has come due.
   *
   * Each row is claimed by a conditional status change, so an overlapping tick
   * or a second replica takes different rows; the outbox message is keyed by
   * the request, so even a claim lost after queuing cannot produce a second
   * WhatsApp. A dispatch that throws puts the row back for the next sweep, up to
   * a limit, and then gives up in writing.
   */
  async sweep(now = new Date(), limit = 100) {
    const due = await this.prisma.feedbackRequest.findMany({
      where: { status: 'scheduled', scheduledFor: { lte: now } },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
      select: { id: true },
    });

    const outcome = {
      examined: due.length,
      queued: 0,
      handedToStaff: 0,
      cancelled: 0,
      retrying: 0,
      recovered: await this.recoverUndelivered(now),
      // The later request runs in the same tick but on its own rows: the two
      // are days apart, so a tick with no first requests due may well have
      // second ones, and vice versa.
      ...(await this.sweepSecondAsk(now)),
    };
    for (const { id } of due) {
      const claim = await this.prisma.feedbackRequest.updateMany({
        where: { id, status: 'scheduled' },
        data: { status: 'processing', dispatchAttempts: { increment: 1 } },
      });
      if (claim.count === 0) continue;

      try {
        const result = await this.dispatch(id, now);
        outcome[result]++;
      } catch (error) {
        const row = await this.prisma.feedbackRequest.findUnique({
          where: { id },
          select: { dispatchAttempts: true },
        });
        const exhausted = (row?.dispatchAttempts ?? MAX_DISPATCH_ATTEMPTS) >= MAX_DISPATCH_ATTEMPTS;
        const message = (error as Error)?.message ?? String(error);
        await this.prisma.feedbackRequest.update({
          where: { id },
          data: exhausted
            ? { status: 'cancelled', deliveryNote: `Gave up after ${MAX_DISPATCH_ATTEMPTS} attempts: ${message}`.slice(0, 500) }
            : { status: 'scheduled', deliveryNote: `Retrying: ${message}`.slice(0, 500) },
        });
        if (exhausted) outcome.cancelled++;
        else outcome.retrying++;
        this.log.warn(`Visit feedback ${id} ${exhausted ? 'abandoned' : 'will retry'}: ${message}`);
      }
    }
    return outcome;
  }

  private async dispatch(id: string, now: Date): Promise<'queued' | 'handedToStaff' | 'cancelled'> {
    const r = await this.prisma.feedbackRequest.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        organisationId: true,
        storeId: true,
        partyId: true,
        checkInId: true,
        publicKey: true,
        party: { select: { name: true, archivedAt: true } },
      },
    });
    const cancel = async (reason: string) => {
      await this.prisma.feedbackRequest.update({
        where: { id },
        data: { status: 'cancelled', deliveryNote: reason },
      });
      return 'cancelled' as const;
    };

    const policy = await this.feedback.afterVisitPolicy(r.organisationId);
    if (!policy.enabled) return cancel('Visit feedback was switched off before this was due.');
    if (!r.partyId || !r.party) return cancel('The customer record no longer exists.');
    if (r.party.archivedAt) return cancel('The customer was archived before this was due.');

    const other = await this.prisma.feedbackRequest.findFirst({
      where: {
        organisationId: r.organisationId,
        partyId: r.partyId,
        id: { not: r.id },
        status: { in: ['pending', 'sent'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (other) return cancel('The customer already had an open feedback request when this came due.');

    const first = policy.steps[0];
    const link = this.publicLink(r.publicKey);
    if (!first.templateName) {
      return this.handToStaff(r, link, 'No WhatsApp feedback template is configured.', now);
    }
    if (!link) {
      return this.handToStaff(r, link, 'PUBLIC_APP_URL is not set, so there is no feedback link to send.', now);
    }

    /*
     * An automatic ask is not queued onto a channel that will certainly not
     * deliver it. With no live sender WhatsApp runs as a dry run — right for a
     * colleague testing a template, wrong for the only time this customer will
     * be asked — so a person asks instead, and the reason says why.
     */
    const channel = await this.adapters.deliverability(r.organisationId, 'whatsapp');
    if (channel.state !== 'live') {
      return this.handToStaff(r, link, `WhatsApp is not live for this organisation: ${channel.reason}`, now);
    }

    const firstName = r.party.name.split(/\s+/)[0] || r.party.name;
    const result = await this.omnichannel.queueCustomerNotice({
      organisationId: r.organisationId,
      partyId: r.partyId,
      storeId: r.storeId,
      purpose: 'service',
      templateName: first.templateName,
      languageCode: first.templateLanguage ?? 'en',
      templateComponents: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: firstName },
            { type: 'text', text: link },
          ],
        },
      ],
      idempotencyKey: `visit-feedback:${r.id}`,
      summary: 'Asked how their visit went.',
      automation: 'visit_feedback',
    });

    if (result.queued) {
      await this.prisma.feedbackRequest.update({
        where: { id },
        // `pending` until the provider takes it; the outbox sets `sent` then.
        data: {
          status: 'pending',
          messageId: result.messageId,
          deliveryNote: null,
          /*
           * The second request is planned HERE and nowhere else, because this
           * is the only point at which the first one has actually gone to the
           * customer. Booking it at checkout instead would plan a chaser for
           * visits whose first request is later handed to a colleague or
           * cancelled, and `reminderDueAt` is the column the NPS register
           * derives "reminder due" from — it must not say a reminder is coming
           * for a message that never went.
           *
           * The policy is read again here rather than at booking, so a tenant
           * who switches the second request on while a visit is waiting gets
           * it, and one who switches it off does not.
           */
          reminderDueAt: await this.secondAskDueAt(r.checkInId, policy, now),
        },
      });
      return 'queued';
    }
    if (DO_NOT_CONTACT.has(result.code)) return cancel(result.reason);
    return this.handToStaff(r, link, `WhatsApp was not used: ${result.reason}`, now);
  }

  /**
   * An ask that WAS queued but whose message the outbox finally marked failed —
   * the provider refused it, or every retry ran out — goes to a person too. Until
   * this runs it is simply unsent: `sentAt` stays empty and nothing counts it as
   * delivered.
   */
  private async recoverUndelivered(now: Date): Promise<number> {
    const waiting = await this.prisma.feedbackRequest.findMany({
      where: { origin: 'visit_auto', status: 'pending', messageId: { not: null }, taskId: null, sentAt: null },
      take: 200,
      select: { id: true, messageId: true },
    });
    if (!waiting.length) return 0;
    const failed = await this.prisma.message.findMany({
      where: { id: { in: waiting.map((w) => w.messageId!) }, status: 'failed' },
      select: { id: true, error: true },
    });
    let recovered = 0;
    for (const message of failed) {
      const ask = waiting.find((w) => w.messageId === message.id)!;
      const r = await this.prisma.feedbackRequest.findUniqueOrThrow({
        where: { id: ask.id },
        select: {
          id: true, organisationId: true, storeId: true, partyId: true, checkInId: true, publicKey: true,
          party: { select: { name: true } },
        },
      });
      await this.handToStaff(
        r,
        this.publicLink(r.publicKey),
        `The WhatsApp message was not delivered: ${(message.error ?? 'the provider refused it').slice(0, 200)}`,
        now,
      );
      recovered++;
    }
    return recovered;
  }

  /* ================================================== the second request */

  /**
   * Send every second request that has come due — and, far more often, decide
   * not to.
   *
   * Claimed the way every sweep in this codebase claims: a conditional
   * `updateMany` that only one caller can win, then act. Here the claim is
   * `reminderDueAt` being cleared, which is both the claim and the statement
   * that no second request is planned any more, so two replicas or a tick that
   * overlaps the previous one cannot both send it. The outbox message carries
   * its own idempotency key as well, keyed to this request, so even a claim
   * lost after queuing cannot produce a second WhatsApp.
   *
   * `reminderSentAt` is NOT the claim. That column means the same thing
   * `sentAt` means — the provider took it — and stamping it to reserve a row
   * would make the NPS register read "reminder sent" for a message that had not
   * left, which is the one thing the register must never say. It is stamped by
   * `settleSecondAsks` once the Message itself says it went.
   */
  private async sweepSecondAsk(
    now: Date,
  ): Promise<{ secondQueued: number; secondDropped: number; secondSettled: number }> {
    const settled = await this.settleSecondAsks();
    const due = await this.prisma.feedbackRequest.findMany({
      where: {
        origin: 'visit_auto',
        reminderDueAt: { lte: now },
        reminderSentAt: null,
        reminderMessageId: null,
      },
      orderBy: [{ reminderDueAt: 'asc' }, { id: 'asc' }],
      take: 200,
      select: {
        id: true,
        organisationId: true,
        storeId: true,
        partyId: true,
        publicKey: true,
        status: true,
        sentAt: true,
        taskId: true,
        rating: true,
        respondedAt: true,
        repliedAt: true,
        reminderDueAt: true,
        reminderSentAt: true,
        party: { select: { name: true, archivedAt: true } },
        _count: { select: { npsResponses: true } },
      },
    });

    let secondQueued = 0;
    let secondDropped = 0;
    /*
     * One settings read, and one deliverability check, per organisation per
     * tick rather than per request: a branch's day of walk-ins arrives here as
     * a hundred rows that would otherwise ask the same two questions a hundred
     * times over.
     */
    const policies = new Map<string, AfterVisitPolicy>();
    const channels = new Map<string, Awaited<ReturnType<ChannelAdaptersService['deliverability']>>>();

    for (const r of due) {
      let policy = policies.get(r.organisationId);
      if (!policy) {
        policy = await this.feedback.afterVisitPolicy(r.organisationId);
        policies.set(r.organisationId, policy);
      }
      const step = secondAskStep(policy);
      const outcome = secondAskOutcome(
        {
          configured: Boolean(step),
          status: r.status,
          sentAt: r.sentAt,
          reminderDueAt: r.reminderDueAt,
          reminderSentAt: r.reminderSentAt,
          repliedAt: r.repliedAt,
          respondedAt: r.respondedAt,
          rating: r.rating,
          hasMatchedResponse: r._count.npsResponses > 0,
          handedToStaffTaskId: r.taskId,
          // Archived is the part of "do not contact" visible on the row. STOP
          // is the outbox's shared consent check, which refuses the send with
          // `recipient_opted_out`, and is deliberately not reimplemented here:
          // one consent rule for every outbound message or none.
          contactable: !r.party?.archivedAt,
        },
        now,
      );

      // Cannot happen given the query above, and still not treated as a reason
      // to stop planning: a clock that disagrees must not cancel a request.
      if (outcome === 'not_due') continue;
      if (outcome !== 'send') {
        await this.dropSecondAsk(r.id, SECOND_ASK_REASONS[outcome]);
        secondDropped++;
        continue;
      }

      // `step` is non-null whenever the outcome is `send` — that is what
      // `configured` means — but the narrowing does not cross the call, and a
      // request whose customer record has since gone has nobody to ask.
      if (!step?.templateName || !r.partyId || !r.party) {
        await this.dropSecondAsk(r.id, 'the customer record no longer exists');
        secondDropped++;
        continue;
      }

      const link = this.publicLink(r.publicKey);
      if (!link) {
        // The first request went out WITH a link, so losing one now means the
        // deployment changed under us rather than that this request was never
        // sendable. Held for the next tick, inside the grace window.
        if (await this.holdOrDrop(r.id, r.reminderDueAt, now, 'there is no feedback link to send')) {
          secondDropped++;
        }
        continue;
      }

      /*
       * An automatic chaser is not queued onto a channel that will certainly
       * not deliver it, for the same reason the first request is not: with no
       * live sender WhatsApp runs as a dry run. Unlike the first request this
       * does NOT become a task for a colleague — the first one already raised
       * one when WhatsApp could not carry it, and a second task to nag the same
       * customer again is work nobody asked for.
       */
      let channel = channels.get(r.organisationId);
      if (!channel) {
        channel = await this.adapters.deliverability(r.organisationId, 'whatsapp');
        channels.set(r.organisationId, channel);
      }
      if (channel.state !== 'live') {
        if (await this.holdOrDrop(r.id, r.reminderDueAt, now, `WhatsApp is not live: ${channel.reason}`)) {
          secondDropped++;
        }
        continue;
      }

      /*
       * The claim. Only one caller can clear a `reminderDueAt` that is still
       * set, so a second replica or an overlapping tick loses here and moves on.
       *
       * It fails CLOSED: a crash between this line and the queue call leaves no
       * plan and no message, so the chaser is simply never sent. That is the
       * direction to fail in — the alternative is a row that says a reminder
       * went out when none did, which is exactly what the client's register
       * must never claim.
       */
      const claim = await this.prisma.feedbackRequest.updateMany({
        where: { id: r.id, reminderDueAt: { lte: now }, reminderSentAt: null, reminderMessageId: null },
        data: { reminderDueAt: null },
      });
      if (claim.count === 0) continue; // another sweep, or another replica, has it

      const firstName = r.party.name.split(/\s+/)[0] || r.party.name;
      const result = await this.omnichannel.queueCustomerNotice({
        organisationId: r.organisationId,
        partyId: r.partyId,
        storeId: r.storeId,
        purpose: 'service',
        templateName: step.templateName,
        languageCode: step.templateLanguage ?? 'en',
        templateComponents: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: firstName },
              { type: 'text', text: link },
            ],
          },
        ],
        // Keyed apart from the first request's `visit-feedback:<id>`: one
        // request, two messages, and the outbox must not mistake either for
        // the other.
        idempotencyKey: `visit-feedback-second:${r.id}`,
        summary: 'Asked again how their visit went.',
        automation: 'visit_feedback',
      });

      if (result.queued) {
        await this.prisma.feedbackRequest.update({
          where: { id: r.id },
          data: { reminderMessageId: result.messageId },
        });
        secondQueued++;
        continue;
      }

      if (DO_NOT_CONTACT.has(result.code)) {
        // The claim already cleared the plan, which is the right end state: a
        // customer who asked not to be contacted is not asked again next tick.
        this.log.log(`Second feedback request ${r.id} not sent — ${result.reason}`);
        secondDropped++;
        continue;
      }
      // Nothing left the building, so the plan goes back for one more tick
      // inside the grace window.
      const retrying = await this.restoreSecondAsk(
        r.id,
        r.reminderDueAt,
        now,
        `WhatsApp was not used: ${result.reason}`,
      );
      if (!retrying) secondDropped++;
    }

    if (due.length || settled) {
      this.log.log(
        `Second feedback requests: ${secondQueued} queued, ${secondDropped} not sent, ${settled} confirmed`,
      );
    }
    return { secondQueued, secondDropped, secondSettled: settled };
  }

  /**
   * Record that a second request actually left, from the Message itself.
   *
   * Separate from queuing it for the same reason `sentAt` is: a feedback ask
   * counts as sent when the PROVIDER took it, not when it was composed. The
   * outbox stamps `sentAt` for the FIRST message because it matches on
   * `messageId`; the second message is held in `reminderMessageId`, which the
   * outbox does not look at, so the confirmation is read back here instead.
   *
   * A reminder whose message failed is left with `reminderSentAt` null on
   * purpose: it is simply unsent, and nothing counts it as delivered.
   */
  private async settleSecondAsks(): Promise<number> {
    const waiting = await this.prisma.feedbackRequest.findMany({
      where: { origin: 'visit_auto', reminderMessageId: { not: null }, reminderSentAt: null },
      /*
       * Newest first, and that is not cosmetic. A reminder whose message the
       * provider refused stays in this window for good — there is no later
       * state for it to reach — so taking the OLDEST rows would eventually fill
       * every page with permanent failures and stop confirming the reminders
       * that did go out.
       */
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: { id: true, reminderMessageId: true },
    });
    if (!waiting.length) return 0;
    const accepted = await this.prisma.message.findMany({
      // `status`, not `sentAt`: Message.sentAt defaults to the moment the row
      // was composed, so it is set even for a message still sitting in the
      // outbox. The status is what changes when the provider takes it.
      where: {
        id: { in: waiting.map((w) => w.reminderMessageId!) },
        status: { in: ['sent', 'delivered', 'read'] },
      },
      select: { id: true, sentAt: true },
    });
    let settled = 0;
    for (const message of accepted) {
      const ask = waiting.find((w) => w.reminderMessageId === message.id)!;
      const stamped = await this.prisma.feedbackRequest.updateMany({
        where: { id: ask.id, reminderSentAt: null },
        data: { reminderSentAt: message.sentAt },
      });
      settled += stamped.count;
    }
    return settled;
  }

  /**
   * Stop planning the second request, for a reason.
   *
   * `reminderDueAt` is cleared rather than left to be re-examined every ten
   * minutes for the next month. `reminderSentAt` is deliberately untouched —
   * nothing went out. So is `deliveryNote`, which holds why the FIRST request
   * did not go on WhatsApp: a manager reads that and acts on it, and
   * overwriting it with a note about the chaser would lose the explanation.
   */
  private async dropSecondAsk(id: string, reason: string): Promise<void> {
    const cleared = await this.prisma.feedbackRequest.updateMany({
      where: { id, reminderSentAt: null },
      data: { reminderDueAt: null },
    });
    if (cleared.count) this.log.log(`Second feedback request ${id} not sent — ${reason}`);
  }

  /**
   * Keep the plan for one more tick, or give up on it.
   *
   * Returns true when it was given up on, so the caller can count it. The grace
   * window is what bounds the retries: nothing counts attempts for the second
   * request, and a chaser that is half a day late has stopped being a chaser.
   */
  private async holdOrDrop(
    id: string,
    dueAt: Date | null,
    now: Date,
    reason: string,
  ): Promise<boolean> {
    if (dueAt && now.getTime() - dueAt.getTime() <= SECOND_ASK_GRACE_HOURS * HOUR_MS) {
      this.log.warn(`Second feedback request ${id} waiting — ${reason}`);
      return false;
    }
    await this.dropSecondAsk(id, `${reason}, and it is now too late to be a follow-up`);
    return true;
  }

  /**
   * Put a claimed plan back, once it is certain nothing was sent. Returns true
   * when it will be tried again, false when it has been given up on.
   *
   * Restored only while every reminder column is still exactly as the claim
   * left it, so a reminder that did go out in the meantime — a racing tick
   * whose queue call succeeded — is never re-planned.
   */
  private async restoreSecondAsk(
    id: string,
    dueAt: Date | null,
    now: Date,
    reason: string,
  ): Promise<boolean> {
    if (!dueAt || now.getTime() - dueAt.getTime() > SECOND_ASK_GRACE_HOURS * HOUR_MS) {
      this.log.log(`Second feedback request ${id} not sent — ${reason}`);
      return false;
    }
    const restored = await this.prisma.feedbackRequest.updateMany({
      where: { id, reminderDueAt: null, reminderSentAt: null, reminderMessageId: null },
      data: { reminderDueAt: dueAt },
    });
    if (!restored.count) return false;
    this.log.warn(`Second feedback request ${id} will retry — ${reason}`);
    return true;
  }

  /**
   * The honest fallback: a person asks. The request stays open so the customer's
   * answer, if they give one through the link, still lands on it.
   */
  private async handToStaff(
    r: { id: string; organisationId: string; storeId: string | null; partyId: string | null; checkInId: string | null; publicKey: string; party: { name: string } | null },
    link: string | null,
    reason: string,
    now: Date,
  ): Promise<'handedToStaff'> {
    const visit = r.checkInId
      ? await this.prisma.checkIn.findUnique({
          where: { id: r.checkInId },
          select: { repId: true, attendedById: true, store: { select: { timezone: true } } },
        })
      : null;
    const candidate = visit?.attendedById ?? visit?.repId ?? null;
    const assignee = candidate
      ? await this.prisma.user.findFirst({
          where: { id: candidate, organisationId: r.organisationId, isActive: true },
          select: { id: true, name: true },
        })
      : null;

    const task = await this.prisma.task.create({
      data: {
        organisationId: r.organisationId,
        storeId: r.storeId,
        partyId: r.partyId,
        title: `Ask ${r.party?.name ?? 'the customer'} how their visit went`,
        detail: `${reason} Ask in person or by phone${link ? `, or share ${link}` : ''}. This is a feedback request, not a sales follow-up.`,
        assigneeId: assignee?.id ?? null,
        assignee: assignee?.name ?? null,
        priority: 'normal',
        dueDate: businessDate(now, resolveTz(visit?.store?.timezone)),
      },
    });
    await this.prisma.feedbackRequest.update({
      where: { id: r.id },
      data: {
        status: 'pending',
        taskId: task.id,
        deliveryNote: reason,
        /*
         * Any second request planned for this visit is cancelled with it. This
         * path is reached both before the first message is queued and after the
         * outbox finally marks it failed (`recoverUndelivered`), and in the
         * second case `reminderDueAt` is already set. A chaser whose template
         * reads "following up on my earlier message" would then be the FIRST
         * thing this customer ever heard from us about the visit.
         */
        reminderDueAt: null,
      },
    });
    return 'handedToStaff';
  }

  /**
   * When the second request is due, or null when there is not going to be one.
   *
   * Both delays are measured from the visit, which is how the client states
   * them, so the two requests land at the hours she chose rather than at an
   * hour that depends on when a sweep happened to run.
   *
   * The floor exists because a first request can leave very late — a sweep that
   * retried for a day, WhatsApp down over a weekend. Anchored purely to the
   * visit, the second one would then already be overdue and go out minutes
   * after the first, which is two messages in a row rather than a follow-up.
   * The gap the tenant configured BETWEEN the steps is what they actually
   * chose, so a late first request pushes the second out by that gap.
   */
  private async secondAskDueAt(
    checkInId: string | null,
    policy: AfterVisitPolicy,
    firstSentAt: Date,
  ): Promise<Date | null> {
    const step = secondAskStep(policy);
    if (!step || !checkInId) return null;
    const visit = await this.prisma.checkIn.findUnique({
      where: { id: checkInId },
      select: { timeIn: true, timeOut: true, store: { select: { timezone: true } } },
    });
    // `timeOut` is the visit closing, which is what the delay is measured from.
    // A visit row that has gone has nothing to measure from, and a chaser timed
    // off "now" would be a different promise than the one configured.
    const closedAt = visit?.timeOut ?? visit?.timeIn ?? null;
    if (!closedAt) return null;

    const fromVisit = afterVisitStepDueAt(closedAt, visit?.store?.timezone, step);
    /*
     * Measured in the same offset the ordering guard uses, not in `delayHours`:
     * the hours choose only the local DAY and `sendTimeLocal` chooses the hour.
     * 24h at 09:00 then 48h at 18:00 sets the two asks 33 hours apart, and 24h
     * at 18:00 then 48h at 09:00 sets them 15 — both read as "24 hours" from
     * the delays alone. So a late first request let the chaser follow most of a
     * day sooner than the tenant arranged, or held it back past an hour they
     * never set.
     */
    const gapMinutes = Math.max(60, stepOffsetMinutes(step) - stepOffsetMinutes(policy.steps[0]));
    const notBefore = new Date(firstSentAt.getTime() + gapMinutes * MINUTE_MS);
    return fromVisit > notBefore ? fromVisit : notBefore;
  }

  /** The absolute response link, or null when the deployment has no public address. */
  private publicLink(publicKey: string): string | null {
    const base = (this.config.get<string>('PUBLIC_APP_URL') ?? '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s/]+/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) {
      return null;
    }
    return `${base}/feedback/${publicKey}`;
  }
}
