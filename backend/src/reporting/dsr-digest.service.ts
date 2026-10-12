/**
 * The evening DSR digest: the bot's traffic, reversed.
 *
 * The DSR used to flow staff -> WhatsApp questionnaire -> dashboard. The client
 * turned it round: staff file the day's figures ON the dashboard, and the bot's
 * one remaining job is to push the finished picture OUT — once a day, at a
 * configurable hour, one consolidated message carrying every store's figures to
 * the head-office people who are not sitting in front of the dashboard.
 *
 * One message, not one per store, and the dashboard's own row order — those are
 * both the client's words. A store that has not filed is listed as such rather
 * than omitted: "missing" is information, silence is not.
 *
 * DELIVERY CAVEAT, recorded where the code lives: WhatsApp lets a business
 * message a person freely only within 24 hours of that person's last message.
 * The recipients are head office, who also use this line to reach staff, so in
 * practice the window is usually open — but a recipient who has never written
 * to the line cannot be reached at all without an approved template. The send
 * result carries `delivered` per recipient so a closed window shows up as a
 * failure a person can see, not a message that quietly went nowhere.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import type { AuthUser } from '../common/auth-user';
import { updateOrgSettings } from '../config/org-settings';
import { WhatsAppCredentialsService } from '../integrations/whatsapp-credentials.service';
import { WhatsAppService } from '../integrations/whatsapp.service';

/** Digits-only E.164, the shape Meta uses inbound and WhatsAppService expects. */
const normalisePhone = (raw: string): string | null => {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`; // bare Indian mobile
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
};

export interface DsrDigestRecipient {
  name: string;
  phoneE164: string;
}

export interface DsrDigestConfig {
  enabled: boolean;
  /** Org-local hour (0-23) after which the day's digest goes out. */
  hourLocal: number;
  recipients: DsrDigestRecipient[];
  /** The org-local date (YYYY-MM-DD) last sent, so a sweep never sends twice. */
  lastSentOn?: string;
}

const DEFAULTS: DsrDigestConfig = { enabled: false, hourLocal: 19, recipients: [] };

/** Tolerant read: a malformed stored config falls back to "off". */
export function resolveDigestConfig(raw: unknown): DsrDigestConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const input = raw as Record<string, unknown>;
  const hour = Number(input.hourLocal);
  const recipients = Array.isArray(input.recipients)
    ? input.recipients
        .map((r) => {
          if (!r || typeof r !== 'object') return null;
          const name = String((r as Record<string, unknown>).name ?? '').trim();
          const phone = normalisePhone(String((r as Record<string, unknown>).phoneE164 ?? ''));
          return phone ? { name: name || phone, phoneE164: phone } : null;
        })
        .filter((r): r is DsrDigestRecipient => r !== null)
    : [];
  return {
    enabled: input.enabled === true && recipients.length > 0,
    hourLocal: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULTS.hourLocal,
    recipients,
    lastSentOn: typeof input.lastSentOn === 'string' ? input.lastSentOn : undefined,
  };
}

/** The per-store numbers the message carries, summed for the day. */
interface StoreDay {
  storeName: string;
  filed: boolean;
  walkIns: number;
  enquiries: number;
  conversions: number;
  counterSale: number;
  bookingsNew: number;
  advanceReceived: number;
}

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;

@Injectable()
export class DsrDigestService {
  private readonly logger = new Logger(DsrDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly audit: AuditService,
    private readonly credentials: WhatsAppCredentialsService,
  ) {}

  private async read(organisationId: string): Promise<DsrDigestConfig> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    return resolveDigestConfig(settings.dsrDigest);
  }

  async describe(user: AuthUser): Promise<DsrDigestConfig> {
    return this.read(user.organisationId);
  }

  async save(user: AuthUser, input: unknown): Promise<DsrDigestConfig> {
    const next = resolveDigestConfig(input);
    if ((input as Record<string, unknown> | null)?.enabled === true && next.recipients.length === 0) {
      throw new BadRequestException('Add at least one recipient before switching the digest on.');
    }
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => {
      // lastSentOn is the sweep's bookkeeping, never the client's to set.
      const current = resolveDigestConfig((settings as Record<string, unknown>).dsrDigest);
      return {
        ...settings,
        dsrDigest: { ...next, lastSentOn: current.lastSentOn } as unknown as Record<string, unknown>,
      };
    });
    await this.audit.record(user, {
      action: 'reporting.dsr_digest_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: next.enabled
        ? `Evening DSR digest on, ${String(next.hourLocal).padStart(2, '0')}:00, ${next.recipients.length} recipient(s)`
        : 'Evening DSR digest switched off',
      metadata: { enabled: next.enabled, hourLocal: next.hourLocal, recipients: next.recipients.length },
    });
    return this.read(user.organisationId);
  }

  /** The org-local calendar date, from its first trading store's timezone. */
  private async localDate(organisationId: string, now: Date): Promise<{ date: string; hour: number; tz: string }> {
    const store = await this.prisma.store.findFirst({
      where: { organisationId, isActive: true, isAggregate: false },
      select: { timezone: true },
    });
    const tz = store?.timezone || 'Asia/Kolkata';
    const date = now.toLocaleDateString('en-CA', { timeZone: tz });
    const hour = Number(now.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }));
    return { date, hour, tz };
  }

  /**
   * One day, every store, in the dashboard's own order: footfall, Table A
   * (counter sale), Table B (customised sale). Multiple filings for a store on
   * one day are summed, matching the sheet renderer.
   */
  private async composeDigest(
    organisationId: string,
    localDate: string,
  ): Promise<{ body: string; stores: StoreDay[] }> {
    const stores = await this.prisma.store.findMany({
      where: { organisationId, isActive: true, isAggregate: false },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });

    const from = new Date(`${localDate}T00:00:00.000Z`);
    const reports = await this.prisma.dailyReport.findMany({
      where: { storeId: { in: stores.map((s) => s.id) }, reportDate: from },
    });
    const byStore = new Map<string, typeof reports>();
    for (const r of reports) {
      byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r]);
    }

    const num = (v: unknown): number => (v == null ? 0 : Number(v)) || 0;
    const days: StoreDay[] = stores.map((s) => {
      const rows = byStore.get(s.id) ?? [];
      const sum = (k: string) => rows.reduce((t, r) => t + num((r as Record<string, unknown>)[k]), 0);
      return {
        storeName: s.name,
        filed: rows.length > 0,
        walkIns: sum('walkIns'),
        enquiries: sum('seriousEnquiries'),
        conversions: sum('conversions'),
        counterSale: sum('deliveredBilled'),
        bookingsNew: sum('bookingsNew'),
        advanceReceived: sum('advanceReceived'),
      };
    });

    const filed = days.filter((d) => d.filed);
    const missing = days.filter((d) => !d.filed);
    const total = (k: keyof Omit<StoreDay, 'storeName' | 'filed'>) =>
      filed.reduce((t, d) => t + d[k], 0);

    const [y, m, d] = localDate.split('-');
    const lines: string[] = [
      `*Daily Sales Report — ${d}/${m}/${y}*`,
      `${filed.length} of ${days.length} stores filed`,
      '',
    ];
    for (const day of filed) {
      lines.push(
        `*${day.storeName}*`,
        `Footfall: ${day.walkIns} walk-ins · ${day.enquiries} enquiries · ${day.conversions} converted`,
        `Counter sale: ${inr(day.counterSale)}`,
        `Bookings: ${inr(day.bookingsNew)} new · ${inr(day.advanceReceived)} received`,
        '',
      );
    }
    if (missing.length) {
      lines.push(`_Not filed yet: ${missing.map((s) => s.storeName).join(', ')}_`, '');
    }
    lines.push(
      '*All stores*',
      `Footfall ${total('walkIns')} · Counter ${inr(total('counterSale'))} · Bookings ${inr(
        total('bookingsNew'),
      )} · Received ${inr(total('advanceReceived'))}`,
      '',
      '_Full sheet: Reporting & DSR on the dashboard._',
    );
    return { body: lines.join('\n'), stores: days };
  }

  /** The internal staff line — resolution shared with scheduled reports. */
  private internalRoute(organisationId: string) {
    return this.credentials.internalRoute(organisationId);
  }

  /** Compose and deliver now, whatever the hour. The test button, and the sweep's worker. */
  async sendNow(
    organisationId: string,
    options: { actor?: AuthUser; dateOverride?: string } = {},
  ): Promise<{
    preview: string;
    recipients: { name: string; phoneE164: string; delivered: boolean; dryRun: boolean }[];
  }> {
    const config = await this.read(organisationId);
    if (!config.recipients.length) {
      throw new BadRequestException('No recipients are set for the evening digest.');
    }
    const { date } = await this.localDate(organisationId, new Date());
    const { body } = await this.composeDigest(organisationId, options.dateOverride ?? date);

    const route = await this.internalRoute(organisationId);
    const recipients: { name: string; phoneE164: string; delivered: boolean; dryRun: boolean }[] = [];
    for (const r of config.recipients) {
      const sent = await this.whatsapp.sendText(organisationId, r.phoneE164, body, route);
      recipients.push({ ...r, delivered: sent.delivered, dryRun: sent.dryRun });
    }

    if (options.actor) {
      await this.audit.record(options.actor, {
        action: 'reporting.dsr_digest_sent',
        entityType: 'Organisation',
        entityId: organisationId,
        summary: `Evening DSR digest sent to ${recipients.length} recipient(s)`,
        metadata: { delivered: recipients.filter((r) => r.delivered).length, total: recipients.length },
      });
    }
    return { preview: body, recipients };
  }

  /**
   * The scheduler's half: every org whose local clock has passed its configured
   * hour and that has not been sent today's digest gets it now. Sending is
   * stamped BEFORE delivery is attempted so a partial failure never turns into
   * a duplicate blast on the next sweep — the per-recipient outcome is in the
   * log, and a person can use Send now to retry.
   */
  async sweep(now = new Date()): Promise<{ sent: number }> {
    const orgs = await this.prisma.organisation.findMany({ select: { id: true, settings: true } });
    let sent = 0;
    for (const org of orgs) {
      const config = resolveDigestConfig(
        ((org.settings ?? {}) as Record<string, unknown>).dsrDigest,
      );
      if (!config.enabled) continue;
      const { date, hour } = await this.localDate(org.id, now);
      if (hour < config.hourLocal || config.lastSentOn === date) continue;

      await updateOrgSettings(this.prisma, org.id, (settings) => {
        const current = resolveDigestConfig((settings as Record<string, unknown>).dsrDigest);
        return { ...settings, dsrDigest: { ...current, lastSentOn: date } as unknown as Record<string, unknown> };
      });
      try {
        const result = await this.sendNow(org.id, { dateOverride: date });
        sent += 1;
        this.logger.log(
          `digest for ${org.id}: ${result.recipients.filter((r) => r.delivered).length}/${result.recipients.length} delivered`,
        );
      } catch (err) {
        this.logger.error(`digest for ${org.id} failed: ${(err as Error).message}`);
      }
    }
    return { sent };
  }
}
