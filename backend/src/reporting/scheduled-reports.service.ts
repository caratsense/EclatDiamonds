import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { EmailService } from '../integrations/email.service';
import {
  EXPORT_COLUMNS,
  LeadExportService,
  type ExportColumn,
} from '../crm/lead-export.service';
import {
  DEFAULT_TZ,
  instantFromLocalTime,
  resolveTz,
  zonedParts,
} from '../common/tz.util';

/**
 * The month-end report nobody has to remember to run.
 *
 * The manual export already exists and is untouched. This is the same workbook
 * on a schedule, and three decisions make the difference between a feature and
 * a support ticket:
 *
 * **The period is always a COMPLETED one.** A monthly report runs on the 1st and
 * covers the month that ended; it never covers "so far this month". A file with
 * three days in it is the kind of number somebody quotes in a meeting before
 * anybody notices what it actually covers.
 *
 * **The boundary is the BRANCH's midnight.** In Asia/Kolkata a lead created at
 * 02:00 on the 1st is 20:30 UTC on the previous day, so an unadjusted month
 * boundary files it in the wrong month — in the one figure a client reconciles
 * against. The window is computed with `instantFromLocalTime` and handed to the
 * export as exact instants.
 *
 * **Delivery is reported honestly.** With no SMTP configured the file is still
 * built and the run is recorded as `dry_run`, never `sent`. A tenant should find
 * out that mail is not configured from the screen, not from wondering why
 * nothing arrived.
 */

const CADENCES = ['monthly', 'weekly'] as const;
type Cadence = (typeof CADENCES)[number];

/** Only one report shape exists today. Named so the next one is additive. */
const KINDS = ['leads'] as const;

const MAX_RECIPIENTS = 20;

/** RFC-perfect email validation is a myth; this rejects the mistakes people make. */
const EMAIL = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]{2,}$/;

export interface ReportPeriod {
  /** '2026-08' or '2026-W35'. The idempotency key, and the file's name. */
  key: string;
  /** Inclusive start instant. */
  from: Date;
  /** EXCLUSIVE end instant. */
  to: Date;
  label: string;
}

@Injectable()
export class ScheduledReportsService {
  private readonly log = new Logger(ScheduledReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly exports: LeadExportService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  // ==========================================================================
  // Definitions
  // ==========================================================================

  async list(user: AuthUser) {
    const rows = await this.prisma.scheduledReport.findMany({
      where: {
        ...this.scope.orgFilter(user),
        // A report for a branch is visible to whoever can see that branch; a
        // chain-wide report (storeId null) is visible to everybody in the tenant
        // because its CONTENTS are still scoped at build time by the recipient's
        // own store list.
        OR: [{ storeId: null }, { storeId: { in: user.storeIds } }],
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        store: { select: { id: true, name: true } },
        runs: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      storeId: r.storeId,
      storeName: r.store?.name ?? null,
      cadence: r.cadence,
      sendHour: r.sendHour,
      columns: r.columns,
      recipients: r.recipients,
      isActive: r.isActive,
      lastRunAt: r.lastRunAt,
      lastRun: r.runs[0]
        ? {
            periodKey: r.runs[0].periodKey,
            rows: r.runs[0].rows,
            status: r.runs[0].status,
            emailStatus: r.runs[0].emailStatus,
            emailDetail: r.runs[0].emailDetail,
            createdAt: r.runs[0].createdAt,
          }
        : null,
    }));
  }

  async runs(user: AuthUser, reportId: string, limit = 24) {
    await this.mustReach(user, reportId);
    return this.prisma.scheduledReportRun.findMany({
      where: { reportId, ...this.scope.orgFilter(user) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async create(
    user: AuthUser,
    input: {
      name: string;
      kind?: string;
      storeId?: string | null;
      cadence?: string;
      sendHour?: number;
      columns?: string[];
      recipients?: string[];
      isActive?: boolean;
    },
  ) {
    const data = this.validate(user, input);
    try {
      const row = await this.prisma.scheduledReport.create({
        data: {
          organisationId: user.organisationId,
          name: input.name.trim(),
          createdById: user.id,
          ...data,
        },
      });
      await this.audit.record(user, {
        action: 'reporting.scheduled_report_created',
        entityType: 'ScheduledReport',
        entityId: row.id,
        storeId: row.storeId,
        summary: `Scheduled report "${row.name}" (${row.cadence})`,
        metadata: { recipients: row.recipients.length, columns: row.columns },
      });
      return row;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('A report with that name already exists here.');
      }
      throw err;
    }
  }

  async update(
    user: AuthUser,
    reportId: string,
    input: {
      name?: string;
      storeId?: string | null;
      cadence?: string;
      sendHour?: number;
      columns?: string[];
      recipients?: string[];
      isActive?: boolean;
    },
  ) {
    await this.mustReach(user, reportId);
    const data = this.validate(user, input);
    const row = await this.prisma.scheduledReport.update({
      where: { id: reportId },
      data: { ...(input.name ? { name: input.name.trim() } : {}), ...data },
    });
    await this.audit.record(user, {
      action: 'reporting.scheduled_report_updated',
      entityType: 'ScheduledReport',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Changed scheduled report "${row.name}"`,
      metadata: { cadence: row.cadence, isActive: row.isActive, columns: row.columns },
    });
    return row;
  }

  async remove(user: AuthUser, reportId: string) {
    const report = await this.mustReach(user, reportId);
    await this.prisma.scheduledReport.delete({ where: { id: reportId } });
    await this.audit.record(user, {
      action: 'reporting.scheduled_report_deleted',
      entityType: 'ScheduledReport',
      entityId: reportId,
      storeId: report.storeId,
      summary: `Deleted scheduled report "${report.name}"`,
    });
    return { deleted: true };
  }

  /**
   * Shared validation for create and update.
   *
   * `storeId` goes through `assertStoreAllowed`, so a manager cannot schedule a
   * chain-wide report by naming a branch that is not theirs — the scheduled
   * build runs with no human present, and this is the only place that check can
   * be made.
   */
  private validate(
    user: AuthUser,
    input: {
      kind?: string;
      storeId?: string | null;
      cadence?: string;
      sendHour?: number;
      columns?: string[];
      recipients?: string[];
      isActive?: boolean;
    },
  ) {
    if (input.kind !== undefined && !(KINDS as readonly string[]).includes(input.kind)) {
      throw new BadRequestException(`kind must be one of: ${KINDS.join(', ')}.`);
    }
    if (input.cadence !== undefined && !(CADENCES as readonly string[]).includes(input.cadence)) {
      throw new BadRequestException(`cadence must be one of: ${CADENCES.join(', ')}.`);
    }
    if (input.sendHour !== undefined && (input.sendHour < 0 || input.sendHour > 23)) {
      throw new BadRequestException('sendHour must be an hour of the day, 0 to 23.');
    }
    if (input.storeId) this.scope.assertStoreAllowed(user, input.storeId);

    if (input.columns !== undefined) {
      const bad = input.columns.filter(
        (c) => !(EXPORT_COLUMNS as readonly string[]).includes(c),
      );
      if (bad.length) {
        throw new BadRequestException(`Not a column this report can carry: ${bad.join(', ')}.`);
      }
    }
    if (input.recipients !== undefined) {
      const cleaned = input.recipients.map((r) => r.trim()).filter(Boolean);
      if (cleaned.length > MAX_RECIPIENTS) {
        throw new BadRequestException(
          `A report can go to at most ${MAX_RECIPIENTS} addresses. Use a distribution list for more.`,
        );
      }
      const bad = cleaned.filter((r) => !EMAIL.test(r));
      if (bad.length) {
        throw new BadRequestException(`That does not look like an email address: ${bad[0]}`);
      }
      input.recipients = cleaned;
    }

    return {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.storeId !== undefined ? { storeId: input.storeId || null } : {}),
      ...(input.cadence !== undefined ? { cadence: input.cadence } : {}),
      ...(input.sendHour !== undefined ? { sendHour: input.sendHour } : {}),
      ...(input.columns !== undefined ? { columns: input.columns } : {}),
      ...(input.recipients !== undefined ? { recipients: input.recipients } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    };
  }

  private async mustReach(user: AuthUser, reportId: string) {
    const row = await this.prisma.scheduledReport.findFirst({
      where: { id: reportId, ...this.scope.orgFilter(user) },
    });
    if (!row) throw new NotFoundException('No such report here.');
    if (row.storeId) this.scope.assertStoreAllowed(user, row.storeId);
    return row;
  }

  // ==========================================================================
  // Periods
  // ==========================================================================

  /**
   * Is it time, at the branch, and if so which period has just ended?
   *
   * Returns null on all 8,759 other hours of the year. The hour check is
   * deliberately here rather than in a cron expression: a cron fires on the
   * SERVER's clock, and "the 1st at 07:00" has to mean the 1st at 07:00 where
   * the staff are.
   */
  dueNow(
    report: { cadence: string; sendHour: number },
    now: Date,
    tz: string,
  ): ReportPeriod | null {
    const p = zonedParts(now, tz);
    if (p.hour !== report.sendHour) return null;
    if (report.cadence === 'monthly') {
      if (p.day !== 1) return null;
      return this.monthEnding(now, tz);
    }
    if (report.cadence === 'weekly') {
      // 1 = Monday. The week that ended yesterday.
      if (p.weekday !== 1) return null;
      return this.weekEnding(now, tz);
    }
    return null;
  }

  /** The calendar month that ended immediately before `now`, at the branch. */
  monthEnding(now: Date, tz: string): ReportPeriod {
    const p = zonedParts(now, tz);
    // Month is 1-12; Date.UTC takes 0-11, so `p.month - 2` is the month before.
    const startLocal = new Date(Date.UTC(p.year, p.month - 2, 1));
    const endLocal = new Date(Date.UTC(p.year, p.month - 1, 1));
    const from = instantFromLocalTime(startLocal, 0, tz);
    const to = instantFromLocalTime(endLocal, 0, tz);
    const key = `${startLocal.getUTCFullYear()}-${String(startLocal.getUTCMonth() + 1).padStart(2, '0')}`;
    return {
      key,
      from,
      to,
      label: startLocal.toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    };
  }

  /** The Monday-to-Sunday week that ended immediately before `now`, at the branch. */
  weekEnding(now: Date, tz: string): ReportPeriod {
    const p = zonedParts(now, tz);
    const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
    // Back to this week's Monday, then back one more week.
    const daysSinceMonday = (p.weekday + 6) % 7;
    const thisMonday = new Date(today.getTime() - daysSinceMonday * 86_400_000);
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86_400_000);
    const from = instantFromLocalTime(lastMonday, 0, tz);
    const to = instantFromLocalTime(thisMonday, 0, tz);
    return {
      key: `${lastMonday.getUTCFullYear()}-W${String(isoWeek(lastMonday)).padStart(2, '0')}`,
      from,
      to,
      label: `week of ${lastMonday.toISOString().slice(0, 10)}`,
    };
  }

  // ==========================================================================
  // Building and sending
  // ==========================================================================

  /**
   * Build one report for one period and deliver it.
   *
   * Returns null when this period has already been delivered — which is the
   * normal outcome of an overlapping tick, a second replica or a restart, and is
   * not an error. The run row is claimed BEFORE the workbook is built, so two
   * instances starting together do not both spend a minute on the same file.
   */
  async runFor(
    reportId: string,
    period: ReportPeriod,
    trigger: 'scheduled' | 'manual' = 'scheduled',
  ): Promise<{ rows: number; emailStatus: string; periodKey: string } | null> {
    const report = await this.prisma.scheduledReport.findUnique({
      where: { id: reportId },
      include: { store: { select: { id: true, name: true, timezone: true } } },
    });
    if (!report) return null;

    let runId: string;
    try {
      const claim = await this.prisma.scheduledReportRun.create({
        data: {
          organisationId: report.organisationId,
          reportId: report.id,
          periodKey: period.key,
          periodFrom: period.from,
          periodTo: period.to,
          recipients: report.recipients,
          status: 'ok',
          emailStatus: 'no_recipients',
        },
        select: { id: true },
      });
      runId = claim.id;
    } catch (err) {
      // P2002 = this period is already delivered. The whole point.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null;
      }
      throw err;
    }

    try {
      const actor = await this.actorFor(report.organisationId, report.storeId);
      const { buffer, rows } = await this.exports.build(actor, {
        fromInstant: period.from,
        toInstant: period.to,
        storeId: report.storeId ?? undefined,
        columns: (report.columns.length
          ? report.columns
          : EXPORT_COLUMNS) as unknown as ExportColumn[],
        filenameStem: `${slug(report.name)}-${period.key}`,
      });

      const filename = `${slug(report.name)}-${period.key}.xlsx`;
      const delivery = await this.deliver(report, period, buffer, filename, rows);

      await this.prisma.scheduledReportRun.update({
        where: { id: runId },
        data: {
          rows,
          // `empty` rather than `ok`: a branch with no leads last month gets a
          // row that says so, instead of a blank file that reads like a fault.
          status: rows === 0 ? 'empty' : 'ok',
          emailStatus: delivery.status,
          emailDetail: delivery.detail,
          detail: `${trigger} · ${period.label}`,
        },
      });
      await this.prisma.scheduledReport.update({
        where: { id: report.id },
        data: { lastRunAt: new Date() },
      });
      return { rows, emailStatus: delivery.status, periodKey: period.key };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The claim STAYS. A failed period is recorded as failed rather than
      // retried forever; the screen shows it and a person can re-run it.
      await this.prisma.scheduledReportRun.update({
        where: { id: runId },
        data: { status: 'failed', detail: message.slice(0, 500) },
      });
      this.log.error(`Scheduled report ${report.name} failed for ${period.key}: ${message}`);
      return { rows: 0, emailStatus: 'failed', periodKey: period.key };
    }
  }

  private async deliver(
    report: { name: string; recipients: string[] },
    period: ReportPeriod,
    buffer: Buffer,
    filename: string,
    rows: number,
  ): Promise<{ status: string; detail: string | null }> {
    if (report.recipients.length === 0) {
      return {
        status: 'no_recipients',
        detail: 'The file was produced. Nobody is configured to receive it.',
      };
    }
    const body =
      `${report.name} for ${period.label}.\n\n` +
      `${rows.toLocaleString('en-IN')} lead${rows === 1 ? '' : 's'} in this period.\n\n` +
      `Generated by CaratSense.`;
    const result = await this.email.send(
      report.recipients.join(', '),
      `${report.name} — ${period.label}`,
      body,
      [
        {
          filename,
          content: buffer,
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    );
    if (result.dryRun) {
      // Never 'sent'. A tenant should learn that mail is not configured from
      // this screen, not from wondering why nothing arrived.
      return {
        status: 'dry_run',
        detail: 'Email is not configured on this server, so nothing was delivered.',
      };
    }
    if (!result.sent) {
      return { status: 'failed', detail: result.error ?? 'The mail server refused it.' };
    }
    return { status: 'sent', detail: `Sent to ${report.recipients.length} recipient(s).` };
  }

  /**
   * The principal a scheduled build runs as.
   *
   * Head office OF THAT TENANT, over the report's own branch or all of them —
   * never global authority. `storeIds` is a real list, so the export's scope
   * filter behaves exactly as it would for a person, and a bug there cannot
   * reach another organisation.
   */
  private async actorFor(organisationId: string, storeId: string | null): Promise<AuthUser> {
    const storeIds = storeId
      ? [storeId]
      : (
          await this.prisma.store.findMany({
            where: { organisationId },
            select: { id: true },
          })
        ).map((s) => s.id);
    return {
      id: 'system-scheduler',
      name: 'CaratSense (automatic)',
      email: 'system@caratsense.local',
      role: Role.head_office,
      organisationId,
      storeIds,
      allStores: false,
    };
  }

  // ==========================================================================
  // The tick
  // ==========================================================================

  /**
   * Every active report in the estate, asked whether it is due at ITS branch.
   *
   * Cross-tenant, like the SLA sweep: one query for everything active rather
   * than a loop over organisations.
   */
  async sweep(now = new Date()): Promise<{ due: number; delivered: number; skipped: number }> {
    const reports = await this.prisma.scheduledReport.findMany({
      where: { isActive: true },
      include: { store: { select: { timezone: true } } },
    });
    let due = 0;
    let delivered = 0;
    let skipped = 0;

    for (const report of reports) {
      const tz = await this.tzFor(report.organisationId, report.store?.timezone ?? null);
      const period = this.dueNow(report, now, tz);
      if (!period) continue;
      due++;
      try {
        const res = await this.runFor(report.id, period);
        if (res) delivered++;
        else skipped++;
      } catch (e) {
        // One tenant's report must not stop everybody else's.
        this.log.error(
          `Scheduled report sweep failed for ${report.name}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return { due, delivered, skipped };
  }

  /**
   * A person asking for a period now, without waiting for the 1st.
   *
   * Uses the same `runFor`, so a manual run of a period already delivered is a
   * no-op rather than a second copy in everybody's inbox.
   */
  async runNow(user: AuthUser, reportId: string) {
    const report = await this.mustReach(user, reportId);
    const store = report.storeId
      ? await this.prisma.store.findUnique({
          where: { id: report.storeId },
          select: { timezone: true },
        })
      : null;
    const tz = await this.tzFor(report.organisationId, store?.timezone ?? null);
    const period =
      report.cadence === 'weekly'
        ? this.weekEnding(new Date(), tz)
        : this.monthEnding(new Date(), tz);

    const res = await this.runFor(report.id, period, 'manual');
    await this.audit.record(user, {
      action: 'reporting.scheduled_report_run',
      entityType: 'ScheduledReport',
      entityId: report.id,
      storeId: report.storeId,
      summary: `Ran "${report.name}" for ${period.label}`,
      metadata: { periodKey: period.key, alreadyDelivered: res === null },
    });
    return (
      res ?? {
        rows: 0,
        emailStatus: 'already_delivered',
        periodKey: period.key,
        alreadyDelivered: true,
      }
    );
  }

  /** Download the current definition's last completed period, as a person. */
  async download(user: AuthUser, reportId: string) {
    const report = await this.mustReach(user, reportId);
    const tz = await this.scope.resolveTimezone(user, report.storeId ?? undefined);
    const period =
      report.cadence === 'weekly'
        ? this.weekEnding(new Date(), tz)
        : this.monthEnding(new Date(), tz);

    // Built as the CALLER, not as the scheduler: a manager downloading a
    // chain-wide report gets their own branches, which is the same rule the
    // manual export already follows.
    return this.exports.build(user, {
      fromInstant: period.from,
      toInstant: period.to,
      storeId: report.storeId ?? undefined,
      columns: (report.columns.length
        ? report.columns
        : EXPORT_COLUMNS) as unknown as ExportColumn[],
      filenameStem: `${slug(report.name)}-${period.key}`,
    });
  }

  /** The branch's zone, or the tenant's first branch, or the platform default. */
  private async tzFor(organisationId: string, storeTz: string | null): Promise<string> {
    if (storeTz) return resolveTz(storeTz);
    const first = await this.prisma.store.findFirst({
      where: { organisationId },
      orderBy: { createdAt: 'asc' },
      select: { timezone: true },
    });
    return resolveTz(first?.timezone ?? DEFAULT_TZ);
  }
}

/** ISO-8601 week number of a UTC-midnight date. */
function isoWeek(date: Date): number {
  const d = new Date(date.getTime());
  // Thursday decides the year an ISO week belongs to.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** A filename a mail client will not mangle. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'report'
  );
}
