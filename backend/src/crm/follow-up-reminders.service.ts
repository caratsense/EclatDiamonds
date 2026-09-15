import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { instantFromLocalTime, parseHHMM, resolveTz, zonedParts } from '../common/tz.util';
import { updateOrgSettings } from '../config/org-settings';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const SETTINGS_KEY = 'crmFollowUpReminders';
const DAY_MS = 86_400_000;

export interface FollowUpReminderSettings {
  /** Local "HH:MM" a reminder fires when nobody picked a time. */
  defaultTimeLocal: string;
  /** How many days before the due day that default reminder fires. 0 = on the day. */
  defaultDaysBefore: number;
}

const DEFAULTS: FollowUpReminderSettings = { defaultTimeLocal: '10:00', defaultDaysBefore: 0 };

/** "YYYY-MM-DDTHH:MM" as entered at the counter, in the branch's own time. */
export const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Follow-up reminders.
 *
 * A follow-up has a DUE DAY — when the customer is owed a call, a message or a
 * visit — and, separately, a REMINDER: the instant the employee is told. They
 * are not the same thing and are not stored as one. A reminder the day before
 * is how somebody prepares; a reminder at ten on the day is how a queue starts.
 *
 * Everything local is resolved in the BRANCH's timezone and stored as a real
 * instant, so the sweep compares instants and never re-does calendar arithmetic
 * against the server's clock.
 */
@Injectable()
export class FollowUpRemindersService {
  private readonly log = new Logger(FollowUpRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async settings(organisationId: string): Promise<FollowUpReminderSettings> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const raw = asObject(asObject(org?.settings)[SETTINGS_KEY]);
    const time = typeof raw.defaultTimeLocal === 'string' && /^\d{2}:\d{2}$/.test(raw.defaultTimeLocal)
      ? raw.defaultTimeLocal
      : DEFAULTS.defaultTimeLocal;
    const days = Number.isInteger(raw.defaultDaysBefore) ? Number(raw.defaultDaysBefore) : DEFAULTS.defaultDaysBefore;
    return { defaultTimeLocal: time, defaultDaysBefore: Math.min(Math.max(days, 0), 14) };
  }

  async saveSettings(user: AuthUser, input: Partial<FollowUpReminderSettings>) {
    if (input.defaultTimeLocal !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(input.defaultTimeLocal) || parseHHMM(input.defaultTimeLocal) >= 1440) {
        throw new BadRequestException('The default reminder time must be HH:MM.');
      }
    }
    const current = await this.settings(user.organisationId);
    // Only fields that were sent; a validated DTO carries the others as undefined.
    const sent = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const next: FollowUpReminderSettings = { ...current, ...sent };
    await updateOrgSettings(this.prisma, user.organisationId, (s) => ({ ...s, [SETTINGS_KEY]: next }));
    await this.audit.record(user, {
      action: 'crm.follow_up_reminder_settings_changed',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `Default follow-up reminder: ${next.defaultTimeLocal}, ${next.defaultDaysBefore} day(s) before.`,
      metadata: next,
    });
    return next;
  }

  /**
   * The reminder instant for a follow-up.
   *
   * An explicit local "YYYY-MM-DDTHH:MM" wins; otherwise the tenant's default
   * time, the configured number of days before the due day. The result is
   * refused when it falls after the due day ends (a reminder after the thing is
   * due is not a reminder) or when an explicit one is already in the past.
   */
  async resolveReminderAt(input: {
    organisationId: string;
    timezone: string | null | undefined;
    /** UTC-midnight stand-in for the local due day, as a `@db.Date` holds it. */
    dueDay: Date;
    explicitLocal?: string;
    now?: Date;
  }): Promise<Date> {
    const tz = resolveTz(input.timezone);
    const now = input.now ?? new Date();
    const dueDayEnd = instantFromLocalTime(input.dueDay, 1440, tz);

    if (input.explicitLocal) {
      const at = localToInstant(input.explicitLocal, tz);
      if (at.getTime() > dueDayEnd.getTime()) {
        throw new BadRequestException('The reminder must be on or before the follow-up date.');
      }
      // A minute of grace for the time it took to press the button.
      if (at.getTime() < now.getTime() - 60_000) {
        throw new BadRequestException('The reminder time has already passed.');
      }
      return at;
    }

    const settings = await this.settings(input.organisationId);
    const day = new Date(input.dueDay.getTime() - settings.defaultDaysBefore * DAY_MS);
    const at = instantFromLocalTime(day, parseHHMM(settings.defaultTimeLocal), tz);
    // A default that has already passed (a follow-up booked for today at 17:00
    // with a 10:00 default) fires on the next sweep rather than never.
    return at.getTime() < now.getTime() ? now : at;
  }

  /**
   * Notify everyone whose reminder is due.
   *
   * Each row is CLAIMED by a conditional update before anyone is told, so two
   * replicas, an overlapping tick or a retried sweep cannot notify twice; the
   * notification itself carries a dedupe key for the same reason. A row whose
   * notification could not be written is released again for the next sweep.
   */
  async sweep(now = new Date(), limit = 200) {
    const due = await this.prisma.leadFollowUp.findMany({
      where: { done: false, reminderNotifiedAt: null, reminderAt: { lte: now } },
      orderBy: [{ reminderAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
      select: {
        id: true,
        storeId: true,
        dueDate: true,
        note: true,
        assigneeId: true,
        lead: {
          select: {
            id: true,
            ref: true,
            customerName: true,
            ownerId: true,
            organisationId: true,
            outcome: true,
            party: { select: { archivedAt: true } },
          },
        },
      },
    });

    let notified = 0;
    let skipped = 0;
    let released = 0;
    for (const f of due) {
      const claim = await this.prisma.leadFollowUp.updateMany({
        where: { id: f.id, reminderNotifiedAt: null },
        data: { reminderNotifiedAt: now },
      });
      if (claim.count === 0) continue; // another sweep has it

      const recipient = f.assigneeId ?? f.lead.ownerId;
      // Nothing to remind about, or nobody to remind: the claim stands so the row
      // is not re-examined every minute, and the reason is simply that.
      if (!recipient || f.lead.outcome !== 'open' || f.lead.party?.archivedAt) {
        skipped++;
        continue;
      }
      const active = await this.prisma.user.findFirst({
        where: { id: recipient, organisationId: f.lead.organisationId, isActive: true },
        select: { id: true },
      });
      if (!active) {
        skipped++;
        continue;
      }

      const dedupeKey = `follow-up-reminder:${f.id}`;
      try {
        await this.notifications.emit([recipient], {
          kind: 'reminder',
          title: `Follow up with ${f.lead.customerName}`,
          body: `Due ${f.dueDate.toISOString().slice(0, 10)}${f.note ? ` · ${f.note.slice(0, 140)}` : ''}`,
          href: '/reminders',
          storeId: f.storeId,
          entityType: 'LeadFollowUp',
          entityId: f.id,
          priority: 'high',
          dedupeKey,
        });
        // `emit` logs and swallows a failed write so one bad recipient cannot sink
        // a batch. The stored row is what a reminder IS, so check it landed.
        const landed = await this.prisma.notification.findUnique({
          where: { userId_dedupeKey: { userId: recipient, dedupeKey } },
          select: { id: true },
        });
        if (!landed) throw new Error('the notification was not stored');
        notified++;
      } catch (error) {
        await this.prisma.leadFollowUp.updateMany({
          where: { id: f.id, reminderNotifiedAt: now },
          data: { reminderNotifiedAt: null },
        });
        released++;
        this.log.warn(`Follow-up reminder ${f.id} released for retry: ${(error as Error).message}`);
      }
    }
    return { examined: due.length, notified, skipped, released };
  }
}

/** A local "YYYY-MM-DDTHH:MM" in `tz` as a real instant. */
export function localToInstant(local: string, tz: string): Date {
  const m = LOCAL_DATETIME.exec(local);
  if (!m) throw new BadRequestException('A reminder must be YYYY-MM-DDTHH:MM.');
  const [, y, mo, d, h, mi] = m.map(Number);
  if (h > 23 || mi > 59) throw new BadRequestException('A reminder must be YYYY-MM-DDTHH:MM.');
  return instantFromLocalTime(new Date(Date.UTC(y, mo - 1, d)), h * 60 + mi, tz);
}

/** The reminder as the screens show it: when, in the branch's time, and whether it went. */
export function reminderView(
  f: { reminderAt: Date | null; reminderNotifiedAt: Date | null },
  tz: string,
) {
  if (!f.reminderAt) return null;
  const p = zonedParts(f.reminderAt, resolveTz(tz));
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    at: f.reminderAt.toISOString(),
    local: `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`,
    state: f.reminderNotifiedAt ? ('sent' as const) : ('scheduled' as const),
    sentAt: f.reminderNotifiedAt ? f.reminderNotifiedAt.toISOString() : null,
  };
}
