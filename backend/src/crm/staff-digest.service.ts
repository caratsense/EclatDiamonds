import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { businessDate, resolveTz, zonedParts } from '../common/tz.util';

export interface DigestLine {
  leadId: string;
  customerName: string;
  phone: string | null;
  dueDate: string;
  overdueDays: number;
}

export interface DigestPreview {
  userId: string;
  userName: string;
  storeId: string | null;
  businessDate: string;
  due: DigestLine[];
  overdue: DigestLine[];
  /** Exactly what the WhatsApp body would say, or null when it would be skipped. */
  whatsappBody: string | null;
  whatsappSkipReason: string | null;
}

/**
 * The morning call list.
 *
 * Two channels with deliberately different guarantees. The IN-APP notification
 * always goes out — it needs no phone number, no template and no provider, so
 * it is the one that can be relied on.
 *
 * The WhatsApp half is QUEUED, never sent from here. This service has no
 * provider client at all: it hands the notice to the omnichannel outbox, which
 * validates the staff number, selects the provider-approved template, routes the
 * branch's sender, applies consent, and owns the durable record, retries, dead
 * letter and delivery receipt. When the outbox declines, the reason is recorded
 * rather than swallowed.
 */
@Injectable()
export class StaffDigestService {
  private readonly log = new Logger(StaffDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(forwardRef(() => OmnichannelService))
    private readonly omnichannel: OmnichannelService,
    private readonly audit: AuditService,
  ) {}

  async settingsFor(organisationId: string) {
    const row = await this.prisma.staffDigestSettings.findUnique({
      where: { organisationId },
    });
    // Absent means "never configured", which is the same as off. Returning the
    // defaults rather than null keeps the settings screen from special-casing it.
    return (
      row ?? {
        organisationId,
        enabled: false,
        sendHourLocal: 9,
        whatsappEnabled: false,
        templateName: null,
        templateLanguage: null,
        updatedById: null,
        createdAt: null,
        updatedAt: null,
      }
    );
  }

  async saveSettings(
    user: AuthUser,
    input: {
      enabled?: boolean;
      sendHourLocal?: number;
      whatsappEnabled?: boolean;
      templateName?: string | null;
      templateLanguage?: string | null;
    },
  ) {
    const data = {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.sendHourLocal !== undefined ? { sendHourLocal: input.sendHourLocal } : {}),
      ...(input.whatsappEnabled !== undefined ? { whatsappEnabled: input.whatsappEnabled } : {}),
      ...(input.templateName !== undefined ? { templateName: input.templateName || null } : {}),
      ...(input.templateLanguage !== undefined
        ? { templateLanguage: input.templateLanguage || null }
        : {}),
      updatedById: user.id,
    };

    const row = await this.prisma.staffDigestSettings.upsert({
      where: { organisationId: user.organisationId },
      create: { organisationId: user.organisationId, ...data },
      update: data,
    });

    await this.audit.record(user, {
      action: 'crm.staff_digest_settings_changed',
      entityType: 'StaffDigestSettings',
      entityId: user.organisationId,
      summary: `Staff digest ${row.enabled ? 'enabled' : 'disabled'} at ${row.sendHourLocal}:00 local`,
      metadata: {
        enabled: row.enabled,
        sendHourLocal: row.sendHourLocal,
        whatsappEnabled: row.whatsappEnabled,
        templateName: row.templateName,
      },
    });

    return row;
  }

  /**
   * What one person owes today.
   *
   * Counted in the database against the follow-up's own due date, not filtered
   * out of a page of rows — the calling screen learned that lesson already, and
   * a digest that under-reports is worse than no digest.
   */
  async linesFor(userId: string, organisationId: string, tz: string, now = new Date()) {
    // `now` is threaded from the caller rather than read here: runForStore is
    // given the instant the scheduler fired, and a helper that quietly used its
    // own clock would compute a different day from the run that called it.
    const today = businessDate(now, tz);

    const rows = await this.prisma.leadFollowUp.findMany({
      where: {
        done: false,
        dueDate: { lte: today },
        lead: { organisationId, ownerId: userId },
      },
      orderBy: { dueDate: 'asc' },
      take: 200,
      select: {
        dueDate: true,
        lead: { select: { id: true, customerName: true, phone: true } },
      },
    });

    const due: DigestLine[] = [];
    const overdue: DigestLine[] = [];
    for (const r of rows) {
      const days = Math.round((today.getTime() - r.dueDate.getTime()) / 86_400_000);
      const line: DigestLine = {
        leadId: r.lead.id,
        customerName: r.lead.customerName,
        phone: r.lead.phone,
        dueDate: r.dueDate.toISOString().slice(0, 10),
        overdueDays: days,
      };
      (days > 0 ? overdue : due).push(line);
    }
    return { due, overdue, businessDate: today };
  }

  /**
   * The message body.
   *
   * Names and a count, never phone numbers or what was discussed. A WhatsApp
   * message is readable on a lock screen, gets forwarded, and survives on a
   * phone the business does not own — so the detail stays behind the deep link,
   * where the reader has to be signed in to see it.
   */
  private body(name: string, due: DigestLine[], overdue: DigestLine[]): string {
    const total = due.length + overdue.length;
    const names = [...overdue, ...due]
      .slice(0, 5)
      .map((l) => l.customerName)
      .join(', ');
    const more = total > 5 ? ` and ${total - 5} more` : '';
    return [
      `Good morning ${name.split(' ')[0]} — ${total} follow-up${total === 1 ? '' : 's'} today.`,
      overdue.length ? `${overdue.length} overdue.` : null,
      names ? `${names}${more}.` : null,
      'Open CaratSense to call or message them.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** What the digest would say for the calling user, without sending anything. */
  async preview(user: AuthUser): Promise<DigestPreview> {
    const store = await this.prisma.userStore.findFirst({
      where: { userId: user.id },
      select: { storeId: true, store: { select: { timezone: true } } },
    });
    const tz = resolveTz(store?.store?.timezone);
    const { due, overdue, businessDate: day } = await this.linesFor(
      user.id,
      user.organisationId,
      tz,
    );
    const settings = await this.settingsFor(user.organisationId);
    const staff = await this.prisma.user.findFirst({
      where: { id: user.id, organisationId: user.organisationId },
      select: { phone: true },
    });
    // The preview can name a missing phone; everything past that is the outbox's
    // decision at send time, and the preview does not pretend to know it.
    const tenantGate = this.whatsappGate(settings);
    const gate =
      tenantGate.reason || staff?.phone
        ? tenantGate
        : { reason: 'This staff member has no phone number on file.' };

    return {
      userId: user.id,
      userName: user.name,
      storeId: store?.storeId ?? null,
      businessDate: day.toISOString().slice(0, 10),
      due,
      overdue,
      whatsappBody: gate.reason ? null : this.body(user.name, due, overdue),
      whatsappSkipReason: gate.reason,
    };
  }

  /**
   * The tenant's own preconditions for the WhatsApp half, each with its reason.
   *
   * Only what THIS organisation chose: is it on, and which template. Whether the
   * number is usable, the template approved by the provider and the sender
   * connected is the outbox's decision, made when the notice is queued and again
   * when it is delivered — deciding it here too would be a second answer that
   * could disagree with the one that actually governs the send.
   *
   * Returned rather than thrown: "not sent, because no template is configured"
   * is a normal Tuesday, not an error.
   */
  private whatsappGate(settings: {
    whatsappEnabled: boolean;
    templateName: string | null;
  }): { reason: string | null } {
    if (!settings.whatsappEnabled) return { reason: 'WhatsApp digest is off for this organisation.' };
    if (!settings.templateName) {
      return { reason: 'No approved WhatsApp template is configured for the digest.' };
    }
    return { reason: null };
  }

  /**
   * Send one branch's digests for its local morning.
   *
   * Returns what happened per person so the scheduler log is readable and the
   * tests can assert on outcomes rather than side effects.
   */
  async runForStore(
    organisationId: string,
    storeId: string,
    timezone: string | null,
    now = new Date(),
  ) {
    const settings = await this.settingsFor(organisationId);
    if (!settings.enabled) return { skipped: 'disabled' as const, sent: 0 };

    const tz = resolveTz(timezone);
    if (zonedParts(now, tz).hour !== settings.sendHourLocal) {
      return { skipped: 'not-the-hour' as const, sent: 0 };
    }

    const day = businessDate(now, tz);
    const staff = await this.prisma.user.findMany({
      where: {
        organisationId,
        isActive: true,
        approvalStatus: 'approved',
        userStores: { some: { storeId } },
      },
      select: { id: true, name: true, phone: true },
    });

    let sent = 0;
    for (const person of staff) {
      const { due, overdue } = await this.linesFor(person.id, organisationId, tz, now);
      if (!due.length && !overdue.length) continue;

      /*
       * Claim the day first.
       *
       * The unique key on (userId, businessDate) means a second run — a retry, a
       * restart, two replicas — loses the race rather than sending somebody their
       * list twice. A run that lost the race only RESUMES what the winner did not
       * finish (a crash between the claim and the queue), and both halves it can
       * resume are idempotent themselves: the notification by its dedupe key, the
       * WhatsApp notice by the outbox's.
       */
      let run;
      try {
        run = await this.prisma.staffDigestRun.create({
          data: {
            organisationId,
            userId: person.id,
            storeId,
            businessDate: day,
            dueCount: due.length,
            overdueCount: overdue.length,
            whatsappStatus: 'pending',
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
        const claimed = await this.prisma.staffDigestRun.findUnique({
          where: { userId_businessDate: { userId: person.id, businessDate: day } },
        });
        if (!claimed || (claimed.inAppNotified && claimed.whatsappStatus !== 'pending')) {
          continue; // already done today
        }
        run = claimed;
      }

      if (!run.inAppNotified) {
        // In-app always. No phone, no template and no provider needed.
        await this.notifications.emit([person.id], {
          kind: 'reminder',
          title: `${due.length + overdue.length} follow-ups today`,
          body: overdue.length ? `${overdue.length} of them are overdue.` : undefined,
          href: '/calling',
          storeId,
          entityType: 'StaffDigestRun',
          entityId: run.id,
          priority: overdue.length ? 'high' : 'normal',
          dedupeKey: `staff-digest:${run.id}`,
        });
        await this.prisma.staffDigestRun.update({
          where: { id: run.id },
          data: { inAppNotified: true },
        });
      }

      if (run.whatsappStatus === 'pending') {
        await this.queueWhatsApp(run, person, storeId, settings, due.length, overdue.length);
      }
      sent += 1;
    }

    return { skipped: null, sent };
  }

  /**
   * Hand the WhatsApp half to the outbox and record its answer.
   *
   * `queued` means an outbox message exists — not that anybody received it.
   * Delivery, retries and the dead letter belong to that message and its job.
   */
  private async queueWhatsApp(
    run: { id: string; attempts: number; organisationId: string },
    person: { id: string; name: string },
    storeId: string,
    settings: { whatsappEnabled: boolean; templateName: string | null; templateLanguage: string | null },
    dueCount: number,
    overdueCount: number,
  ) {
    const gate = this.whatsappGate(settings);
    if (gate.reason) {
      await this.prisma.staffDigestRun.update({
        where: { id: run.id },
        data: { whatsappStatus: 'skipped', whatsappReason: gate.reason },
      });
      return;
    }

    const total = dueCount + overdueCount;
    const result = await this.omnichannel.queueStaffNotice({
      organisationId: run.organisationId,
      // The digest is this branch's, so it leaves on this branch's number.
      storeId,
      recipientUserId: person.id,
      templateName: settings.templateName!,
      languageCode: settings.templateLanguage ?? 'en',
      templateComponents: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: person.name.split(' ')[0] },
            { type: 'text', text: String(total) },
          ],
        },
      ],
      // One notice per run, whatever retries or replicas do.
      idempotencyKey: `staff-digest:${run.id}`,
      summary: `Morning digest: ${total} follow-up${total === 1 ? '' : 's'}${overdueCount ? `, ${overdueCount} overdue` : ''}.`,
    });

    await this.prisma.staffDigestRun.update({
      where: { id: run.id },
      data: result.queued
        ? {
            attempts: run.attempts + 1,
            whatsappStatus: 'queued',
            whatsappMessageId: result.messageId,
            whatsappReason: null,
          }
        : {
            attempts: run.attempts + 1,
            whatsappStatus: 'refused',
            whatsappReason: result.reason,
          },
    });
  }
}
