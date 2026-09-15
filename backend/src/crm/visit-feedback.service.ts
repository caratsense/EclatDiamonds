import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { businessDate, instantFromLocalTime, parseHHMM, resolveTz } from '../common/tz.util';
import { ChannelAdaptersService } from '../integrations/adapters/channel-adapters.service';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackService } from './feedback.service';

const DAY_MS = 86_400_000;
/** A visit ask whose dispatch keeps throwing is given up on, and says so. */
const MAX_DISPATCH_ATTEMPTS = 5;
/** How long the response link stays open after it is due. */
const RESPONSE_WINDOW_DAYS = 30;
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

    const tz = resolveTz(input.timezone);
    const day = new Date(businessDate(input.closedAt, tz).getTime() + policy.delayDays * DAY_MS);
    const scheduledFor = instantFromLocalTime(day, parseHHMM(policy.sendTimeLocal), tz);

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

    const link = this.publicLink(r.publicKey);
    if (!policy.templateName) {
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
      templateName: policy.templateName,
      languageCode: policy.templateLanguage ?? 'en',
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
        data: { status: 'pending', messageId: result.messageId, deliveryNote: null },
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
      data: { status: 'pending', taskId: task.id, deliveryNote: reason },
    });
    return 'handedToStaff';
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
