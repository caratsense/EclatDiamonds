import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { businessDate, dateOnly, resolveTz, zonedParts } from '../common/tz.util';
import { HrmsService } from '../hrms/hrms.service';
import { GoldRateService } from '../integrations/gold-rate.service';
import { JobRunnerService } from './job-runner.service';

/**
 * The principal scheduled work runs as.
 *
 * `dayClose` takes an AuthUser because a human normally triggers it, and it uses
 * that for the store-scope check. There is no human here, so the scheduler acts
 * as head office over every store — the same authority an HO user already has,
 * not a new one. It is a real id (not a random string) so anything the close
 * writes with attribution points somewhere meaningful in the audit trail.
 */
const SYSTEM_ACTOR: AuthUser = {
  id: 'system-scheduler',
  name: 'CaratSense (automatic)',
  email: 'system@caratsense.local',
  role: Role.head_office,
  storeIds: [],
  allStores: true,
};

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
  ) {}

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
      select: { id: true, name: true, timezone: true },
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
      const tz = resolveTz(store.timezone);
      if (zonedParts(now, tz).hour !== this.dayCloseHour) continue;

      // The day being closed is the one that just ended, store-locally.
      const today = businessDate(now, tz);
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const runKey = dateOnly(yesterday);

      const result = await this.runner.runOnce(
        'attendance.day-close',
        store.id,
        runKey,
        () => this.hrms.dayClose(SYSTEM_ACTOR, { storeId: store.id, date: runKey }),
      );
      if (result) {
        this.logger.log(`Day close ${runKey} for ${store.name}: ${JSON.stringify(result)}`);
      }
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
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'pricing.gold-rate-refresh' })
  async refreshGoldRate(): Promise<void> {
    if (!this.enabled || !this.goldRate.enabled) return;

    // Dedup per hour across instances; refreshIfStale gates the actual feed call
    // on the stored rate's age, so this retries hourly until a pull succeeds.
    const hours = this.goldRateRefreshHours;
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const runKey = `hourly-${hourBucket}`;
    await this.runner.runOnce('pricing.gold-rate-refresh', 'global', runKey, async () => {
      const res = await this.goldRate.refreshIfStale(hours);
      if (res.updated) this.logger.log(`Gold rates refreshed: ${JSON.stringify(res.rates)}`);
      return res;
    });
  }
}
