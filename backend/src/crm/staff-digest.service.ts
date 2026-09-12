import { Injectable, Logger } from '@nestjs/common';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { businessDate, resolveTz, zonedParts } from '../common/tz.util';

/**
 * A digest is stale by lunchtime. Retrying yesterday's call list is worse than
 * giving up and saying so, which is what `dead` records.
 */
const MAX_ATTEMPTS = 3;

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
 * it is the one that can be relied on. WhatsApp is attempted only when every
 * precondition genuinely holds, and when it does not the reason is recorded
 * rather than swallowed.
 */
@Injectable()
export class StaffDigestService {
  private readonly log = new Logger(StaffDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly whatsapp: WhatsAppService,
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
    const gate = await this.whatsappGate(user.organisationId, settings, user.id);

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
   * Every precondition for the WhatsApp half, each with its own reason.
   *
   * Returned rather than thrown: "not sent, because no template is approved" is
   * a normal Tuesday, not an error, and the settings screen has to be able to
   * show which precondition is missing.
   */
  private async whatsappGate(
    organisationId: string,
    settings: { whatsappEnabled: boolean; templateName: string | null },
    userId: string,
  ): Promise<{ reason: string | null; phone?: string }> {
    if (!settings.whatsappEnabled) return { reason: 'WhatsApp digest is off for this organisation.' };
    if (!settings.templateName) {
      return { reason: 'No approved WhatsApp template is configured for the digest.' };
    }
    const staff = await this.prisma.user.findFirst({
      where: { id: userId, organisationId },
      select: { phone: true },
    });
    if (!staff?.phone) return { reason: 'This staff member has no phone number on file.' };
    if (!(await this.whatsapp.enabledFor(organisationId))) {
      return { reason: 'No healthy WhatsApp sender is connected.' };
    }
    return { reason: null, phone: staff.phone };
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
       * restart, two replicas — loses the race and moves on, rather than sending
       * somebody their list twice. Creating BEFORE notifying is deliberate: a
       * duplicate notification is the failure being prevented.
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
          },
        });
      } catch {
        continue; // already done today
      }

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
      });
      await this.prisma.staffDigestRun.update({
        where: { id: run.id },
        data: { inAppNotified: true },
      });

      const gate = await this.whatsappGate(organisationId, settings, person.id);
      if (gate.reason) {
        await this.prisma.staffDigestRun.update({
          where: { id: run.id },
          data: { whatsappStatus: 'skipped', whatsappReason: gate.reason },
        });
        sent += 1;
        continue;
      }

      const result = await this.whatsapp.sendTemplate(
        organisationId,
        gate.phone!,
        settings.templateName!,
        settings.templateLanguage ?? 'en',
        [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: person.name.split(' ')[0] },
              { type: 'text', text: String(due.length + overdue.length) },
            ],
          },
        ],
        // The digest is this branch's, so it leaves on this branch's number.
        { storeId },
      );

      const attempts = run.attempts + 1;
      await this.prisma.staffDigestRun.update({
        where: { id: run.id },
        data: {
          attempts,
          whatsappStatus: result.delivered
            ? 'sent'
            : attempts >= MAX_ATTEMPTS
              ? 'dead'
              : 'failed',
          // The provider's own words when it has any. Never "Sent!" for a
          // dry run — result.dryRun means the customer received nothing.
          whatsappReason: result.delivered
            ? null
            : (result.error ?? (result.dryRun ? 'WhatsApp is not connected on this deployment.' : 'Send failed.')),
        },
      });
      sent += 1;
    }

    return { skipped: null, sent };
  }
}
