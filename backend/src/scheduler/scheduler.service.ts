import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService } from '../jobs/jobs.service';
import { StaffDigestService } from '../crm/staff-digest.service';
import { FollowUpRemindersService } from '../crm/follow-up-reminders.service';
import { VisitFeedbackService } from '../crm/visit-feedback.service';
import { ResponseSlaService } from '../crm/response-sla.service';
import { ScheduledReportsService } from '../reporting/scheduled-reports.service';
import { LoyaltyApiService } from '../loyalty/website/loyalty-api.service';
import { JobAlertsService } from '../jobs/job-alerts.service';
import { Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { businessDate, dateOnly, resolveTz, zonedParts } from '../common/tz.util';
import { HrmsService } from '../hrms/hrms.service';
import { PayrollService } from '../hrms/payroll.service';
import { GoldRateService } from '../integrations/gold-rate.service';
import { JobRunnerService } from './job-runner.service';
import { packMaintainsMetalRates } from '../config/entitlements';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { TEMPLATE_SYNC_JOB, TemplateSyncService } from '../omnichannel/template-sync.service';

/**
 * The principal scheduled work runs as.
 *
 * `dayClose` takes an AuthUser because a human normally triggers it, and it uses
 * that for the store-scope check. There is no human here, so the scheduler acts
 * as head office over every store — the same authority an HO user already has,
 * not a new one. It is a real id (not a random string) so anything the close
 * writes with attribution points somewhere meaningful in the audit trail.
 */
/**
 * Build the scheduler's principal for ONE store. Multi-tenant-safe: the actor is
 * scoped to that store's own organisation and only that store, so store-scope and
 * organisation checks pass for exactly the store being processed and nothing in
 * another tenant. Not `allStores` — background work never gets global authority.
 */
function systemActorForStore(store: { id: string; organisationId: string }): AuthUser {
  return {
    id: 'system-scheduler',
    name: 'CaratSense (automatic)',
    email: 'system@caratsense.local',
    role: Role.head_office,
    organisationId: store.organisationId,
    storeIds: [store.id],
    allStores: false,
  };
}

/**
 * Scheduled background work.
 *
 * ## Why an hourly tick rather than one nightly cron
 *
 * Cron expressions run on the SERVER's clock. Stores have their own timezones
 * (`Store.timezone`), and the whole attendance layer is built store-locally — a
 * single `0 2 * * *` would close each store at 02:00 UTC, which is 07:30 in the
 * morning in India, mid-shift. So this ticks every hour and asks each store what
 * time it is *there*, firing only for the ones whose local hour matches. Adding a
 * store in another timezone needs no scheduler change.
 *
 * Every job is claimed through {@link JobRunnerService}, so an hourly tick that
 * overlaps, a restart, or a second replica cannot double-run one.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly runner: JobRunnerService,
    private readonly hrms: HrmsService,
    private readonly goldRate: GoldRateService,
    private readonly jobs: JobsService,
    private readonly omnichannel: OmnichannelService,
    private readonly templateSync: TemplateSyncService,
    private readonly jobAlerts: JobAlertsService,
    private readonly staffDigest: StaffDigestService,
    private readonly followUpReminders: FollowUpRemindersService,
    private readonly visitFeedback: VisitFeedbackService,
    private readonly responseSla: ResponseSlaService,
    private readonly scheduledReports: ScheduledReportsService,
    private readonly loyaltyApi: LoyaltyApiService,
    private readonly payroll: PayrollService,
  ) {}

  /**
   * Drain the durable job queue (CaratOS Phase A8).
   *
   * Every minute rather than on a longer cron: an import a user just started
   * should begin within a minute, not on the hour. `drain` is self-guarded
   * against overlap and claims rows with FOR UPDATE SKIP LOCKED, so several
   * replicas ticking together take different jobs instead of colliding — which
   * is why this needs none of the run-claim machinery the hourly jobs use.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'jobs.drain' })
  async drainJobs(): Promise<void> {
    if (!this.enabled) return;
    // Message producers only have to commit a truthful `queued` row. The sweep
    // attaches durable work here, including messages composed by older CRM and
    // AI-draft paths which pre-date the omnichannel module.
    try {
      const swept = await this.omnichannel.sweepQueued(undefined, 200);
      if (swept.created) {
        this.logger.log(`Omnichannel: queued ${swept.created} delivery job(s)`);
      }
    } catch (e) {
      // A broken messaging provider must not stop imports, attribution pulls or
      // any other durable job already waiting in the queue.
      this.logger.error(`Omnichannel sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const outcome = await this.jobs.drain(25);
      if (outcome.processed) {
        this.logger.log(
          `Jobs: ${outcome.processed} processed (${outcome.succeeded} ok, ${outcome.failed} failed)`,
        );
      }
    } catch (e) {
      // The queue draining must never take the scheduler down with it — the
      // hourly attendance and rate jobs are unrelated and still have to run.
      this.logger.error(`Job drain failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Store-local hour at which yesterday is closed. Late enough to clear night shifts. */
  private get dayCloseHour(): number {
    const raw = Number(this.config.get<string>('DAY_CLOSE_HOUR'));
    return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 2;
  }

  /** Set SCHEDULER_ENABLED=false to silence all jobs (useful on a clone/staging). */
  private get enabled(): boolean {
    return (this.config.get<string>('SCHEDULER_ENABLED') ?? 'true') !== 'false';
  }

  /**
   * How often the gold-rate feed is pulled, in hours. Default 12 (an AM + PM
   * refresh, matching how IBJA publishes and how a jeweller re-rates through the
   * day) — low enough to track the market, high enough to sit inside a free feed
   * tier's monthly request quota. Clamped to 1–24h.
   */
  private get goldRateRefreshHours(): number {
    const raw = Number(this.config.get<string>('GOLD_RATE_REFRESH_HOURS'));
    return Number.isFinite(raw) && raw >= 1 && raw <= 24 ? raw : 12;
  }

  private async rosteredStores() {
    return this.prisma.store.findMany({
      // The "All Stores" aggregate is a UI convenience with no staff and no
      // attendance of its own; closing a day against it would be meaningless.
      where: { isActive: true, isAggregate: false },
      select: { id: true, name: true, timezone: true, organisationId: true },
    });
  }

  /**
   * Close out yesterday's attendance for any store where it is now the configured
   * local hour.
   *
   * Without this, absence had no record at all: someone who simply did not turn up
   * left no row, so payroll counted the day as unremarkable rather than missed.
   * `dayClose` is idempotent, and the run claim means a store is closed once per
   * business day regardless of restarts or replicas.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'attendance.day-close' })
  async closeAttendanceDays(): Promise<void> {
    if (!this.enabled) return;
    const now = new Date();

    for (const store of await this.rosteredStores()) {
      // A store must belong to an organisation to be processed — never run a job
      // with an unattributable/global principal.
      if (!store.organisationId) continue;
      const tz = resolveTz(store.timezone);
      if (zonedParts(now, tz).hour !== this.dayCloseHour) continue;

      // The day being closed is the one that just ended, store-locally.
      const today = businessDate(now, tz);
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const runKey = dateOnly(yesterday);

      const result = await this.runner.runOnce(
        store.organisationId!,
        'attendance.day-close',
        store.id,
        runKey,
        () =>
          this.hrms.dayClose(
            systemActorForStore({ id: store.id, organisationId: store.organisationId! }),
            { storeId: store.id, date: runKey },
          ),
      );
      if (result) {
        this.logger.log(`Day close ${runKey} for ${store.name}: ${JSON.stringify(result)}`);
      }
    }
  }

  /**
   * Draft each branch's payroll once its month has closed, where it is.
   *
   * Hourly for the same reason as the day close: month-end is midnight at the
   * branch, not on the server's clock. The service asks each store and returns
   * straight away for every branch whose month has not just closed.
   *
   * Not wrapped in `runOnce`: the unique claim on PayrollRun is the guard, and
   * unlike an in-process run key it holds across a restart part-way through a
   * run. Drafts only — nothing here issues or pays.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'hrms.payroll-month-end' })
  async draftMonthEndPayroll(): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await this.payroll.sweepMonthEnd();
      if (res.due) this.logger.log(`Month-end payroll: ${res.ran} run(s) of ${res.due} due`);
    } catch (e) {
      this.logger.error(
        `Month-end payroll sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Auto-pull a fresh market rate when a feed is configured, so nobody has to key
   * the rate in each morning.
   *
   * Quotes fall back to the last stored rate when the feed is absent, and a
   * fallback rate looks identical to a live one on the total — so a quiet feed is
   * a pricing error waiting to happen. The tick is hourly, and the run key is an
   * HOURLY bucket so `runOnce` fires one attempt per hour (deduped across
   * instances). The feed is only actually hit when the stored rate is older than
   * GOLD_RATE_REFRESH_HOURS (`refreshIfStale`), so a fresh rate costs nothing —
   * but a FAILED pull is retried the next hour instead of leaving the price stale
   * for the whole interval. A manager can still pull an intraday rate on demand
   * (POST /gold-rate/refresh) or override it by hand.
   *
   * Stored rates are per-organisation config, so the refresh runs ONCE PER ORG
   * (each writes/reads only its own MetalRate rows). The dedup scope is the org id,
   * so orgs don't block each other and each is retried independently. The spot
   * feed itself is global, so N orgs = N feed hits per stale window — fine at
   * today's tenant count; if that grows, fetch spot once and fan the write out.
   */
  /**
   * The morning call list.
   *
   * Hourly rather than on a fixed cron time, because the hour that matters is
   * each STORE's local one — a chain across two timezones wants nine in the
   * morning where the staff are, not nine where head office is. The service
   * checks the local hour itself and returns 'not-the-hour' for the other 23.
   *
   * Double-send is prevented by a unique key on (userId, businessDate) in the
   * database, not by this wrapper: runOnce keeps replicas from scanning at once,
   * but only the constraint can stop a retry after a partial run.
   */
  /**
   * Settle every first-response clock that is owed something.
   *
   * EVERY MINUTE, and deliberately not wrapped in `runOnce`. A five-minute
   * promise measured on an hourly tick is not a promise, and there is no run key
   * a minute-granular sweep could sensibly dedupe on. It needs none: the sweep
   * is idempotent by construction — a reply already recorded is skipped, and the
   * breach and the escalation are each claimed by a conditional UPDATE, so two
   * replicas sweeping the same second produce one alert between them.
   *
   * It is also restart-safe for the same reason. Nothing is held in memory; a
   * process that dies mid-sweep leaves rows that the next tick picks up exactly
   * where it left off.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'crm.response-sla' })
  async sweepResponseSla(): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await this.responseSla.sweep();
      if (res.breached || res.escalated) {
        this.logger.warn(
          `Response SLA: ${res.breached} breached, ${res.escalated} escalated ` +
            `(${res.examined} examined)`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Response SLA sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Follow-up reminders that have come due. Every minute: a reminder is a time
   * somebody chose, and the claim inside the sweep makes overlap harmless.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'crm.follow-up-reminders' })
  async sendFollowUpReminders(): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await this.followUpReminders.sweep();
      if (res.notified || res.released) {
        this.logger.log(
          `Follow-up reminders: ${res.notified} sent, ${res.skipped} skipped, ${res.released} released for retry`,
        );
      }
    } catch (e) {
      this.logger.error(`Follow-up reminder sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Automatic feedback asks after a visit, once each is due. */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'feedback.visit-requests' })
  async sendVisitFeedback(): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await this.visitFeedback.sweep();
      if (res.examined) {
        this.logger.log(
          `Visit feedback: ${res.queued} queued, ${res.handedToStaff} handed to staff, ` +
            `${res.cancelled} cancelled, ${res.retrying} retrying`,
        );
      }
    } catch (e) {
      this.logger.error(`Visit feedback sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'crm.staff-digest' })
  async sendStaffDigests(): Promise<void> {
    if (!this.enabled) return;
    const now = new Date();

    for (const store of await this.rosteredStores()) {
      if (!store.organisationId) continue;
      const tz = resolveTz(store.timezone);
      const runKey = `${dateOnly(businessDate(now, tz))}:${zonedParts(now, tz).hour}`;
      try {
        const res = await this.runner.runOnce(
          store.organisationId,
          'crm.staff-digest',
          store.id,
          runKey,
          () => this.staffDigest.runForStore(store.organisationId!, store.id, store.timezone, now),
        );
        if (res && res.sent) {
          this.logger.log(`Staff digest: ${res.sent} sent for ${store.name}`);
        }
      } catch (e) {
        // One branch's digest failing must not stop the others. The per-person
        // outcome is already recorded on StaffDigestRun either way.
        this.logger.error(
          `Staff digest failed for ${store.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * Reports that send themselves.
   *
   * Hourly, and the "is it the 1st at 07:00" question is asked per report in ITS
   * branch's timezone rather than written into a cron expression — a cron fires
   * on the server's clock, and month-end has to mean month-end where the staff
   * are.
   *
   * Not wrapped in `runOnce`: the unique key on (reportId, periodKey) in the
   * database is the guard, and it is the only one that holds across a restart
   * mid-send. A second replica ticking the same hour loses the insert and does
   * nothing.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'reporting.scheduled' })
  async sendScheduledReports(): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await this.scheduledReports.sweep();
      if (res.due) {
        this.logger.log(
          `Scheduled reports: ${res.delivered} delivered, ${res.skipped} already done ` +
            `(${res.due} due)`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Scheduled report sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Queue loyalty movements the tenant's website was never told about.
   *
   * Sending, retrying, backoff and the dead state all belong to the job queue
   * now (`loyalty.webhook`, drained every minute). This only catches a movement
   * whose announcement was never queued — a restart between the movement
   * committing and its queue insert. A movement announced zero times is a wrong
   * number in front of a customer.
   *
   * Not wrapped in `runOnce`: the delivery row is unique per movement, so two
   * replicas sweeping together queue it once between them.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'loyalty.announcements' })
  async pushLoyaltyAnnouncements(): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await this.loyaltyApi.sweepAnnouncements();
      if (res.queued) {
        this.logger.log(
          `Loyalty announcements: ${res.queued} queued across ${res.organisations} organisation(s)`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Loyalty announcement sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'pricing.gold-rate-refresh' })
  async refreshGoldRate(): Promise<void> {
    if (!this.enabled || !this.goldRate.enabled) return;

    // Dedup per hour across instances; refreshIfStale gates the actual feed call
    // on the stored rate's age, so this retries hourly until a pull succeeds.
    const hours = this.goldRateRefreshHours;
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const runKey = `hourly-${hourBucket}`;

    // Distinct organisations that actually operate a store — the only ones whose
    // rates matter. Never a global refresh with no tenant attribution.
    const orgRows = await this.prisma.store.findMany({
      where: { isActive: true, isAggregate: false },
      distinct: ['organisationId'],
      // The pack rides along on a relation that is already being traversed, so
      // the industry filter below costs no extra query.
      select: { organisationId: true, organisation: { select: { industryPackCode: true } } },
    });

    for (const { organisationId, organisation } of orgRows) {
      if (!organisationId) continue;
      /*
       * Only industries that actually have a metal rate.
       *
       * This loop selected every organisation owning a store, so a pharmacy or a
       * clinic accrued four gold prices an hour, for ever, from the moment it
       * added its first branch. Hiding the chip in the top bar did not stop that
       * — the rows were real, and a tenant that never sells gold was quietly
       * accumulating a price history of it.
       */
      if (!packMaintainsMetalRates(organisation?.industryPackCode)) continue;
      await this.runner.runOnce(organisationId, 'pricing.gold-rate-refresh', organisationId, runKey, async () => {
        const res = await this.goldRate.refreshIfStale(hours, organisationId);
        if (res.updated)
          this.logger.log(`Gold rates refreshed (${organisationId}): ${JSON.stringify(res.rates)}`);
        return res;
      });
    }
  }

  /**
   * Refresh WhatsApp template approval from the provider, once an hour.
   *
   * Meta pauses or disables a template for quality without telling anyone, and
   * a stored approval older than a day stops authorising sends. Without this
   * sweep the only way to regain a usable template would be for somebody to open
   * a screen and press a button, so an unattended weekend would silently stop
   * every out-of-window message. One job per connection, enqueued rather than
   * run inline, so a slow provider cannot hold the scheduler tick.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'omnichannel.template-sync' })
  async refreshMessageTemplates(): Promise<void> {
    if (!this.enabled) return;
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    let connections: Array<{ id: string; organisationId: string }>;
    try {
      connections = await this.templateSync.syncableIntegrations();
    } catch (e) {
      this.logger.error(
        `Template sync sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    for (const connection of connections) {
      try {
        await this.jobs.enqueue({
          kind: TEMPLATE_SYNC_JOB,
          organisationId: connection.organisationId,
          payload: { integrationId: connection.id },
          // One attempt per connection per hour across every replica.
          idempotencyKey: [
            TEMPLATE_SYNC_JOB,
            connection.organisationId,
            connection.id,
            `hourly-${hourBucket}`,
          ].join(':'),
          maxAttempts: 3,
        });
      } catch (e) {
        // One tenant's broken connection must not stop the others being queued.
        this.logger.warn(
          `Template sync could not be queued for ${connection.id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  /**
   * Look for work that died, and tell somebody.
   *
   * `GET /jobs/summary` has always counted dead jobs; nothing read it unless a
   * person opened the screen. A dead Meta lead fetch is a customer who filled in
   * a form and reached nobody, so it is worth a page rather than a discovery.
   *
   * Every fifteen minutes: often enough that a broken token is noticed within a
   * lunch break, rare enough that the alert channel is not itself the noise.
   * Deduplication lives in JobAlertsService — this only decides when to look.
   */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'jobs.dead-alerts' })
  async alertOnDeadJobs(): Promise<void> {
    if (!this.enabled) return;
    try {
      const alerts = await this.jobAlerts.sweep();
      if (alerts.length) {
        this.logger.warn(`Job alert sweep raised ${alerts.length} alert(s).`);
      }
    } catch (e) {
      this.logger.error(
        `Job alert sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
