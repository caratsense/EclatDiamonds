import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { updateOrgSettings } from '../config/org-settings';

/** Where the alert state lives, per tenant, inside `Organisation.settings`. */
const ALERT_STATE_KEY = 'opsJobAlertState';
const DEFAULT_DEAD_THRESHOLD = 1;
const DEFAULT_FAILED_THRESHOLD = 10;
const WEBHOOK_TIMEOUT_MS = 8_000;

/**
 * The two things worth waking someone for, and the job kinds that carry them.
 *
 * Kept explicit rather than alerting on every kind: a dead import job is a
 * data-entry problem someone will find on the imports screen, while a dead lead
 * fetch means a person who filled in a Meta form is sitting in nobody's list.
 */
const WATCHED = {
  lead_capture: {
    label: 'Meta lead capture',
    kinds: ['meta.lead_ads.fetch'],
    status: 'dead' as const,
    settingKey: 'deadLeadJobs',
  },
  outbound_delivery: {
    label: 'Outbound message delivery',
    kinds: ['omnichannel.deliver'],
    status: 'dead' as const,
    settingKey: 'deadDeliveryJobs',
  },
  delivery_failures: {
    label: 'Outbound delivery retries',
    kinds: ['omnichannel.deliver'],
    status: 'failed' as const,
    settingKey: 'failedDeliveryJobs',
  },
} as const;

type WatchKey = keyof typeof WATCHED;

export interface JobAlert {
  key: WatchKey;
  label: string;
  status: 'dead' | 'failed';
  count: number;
  threshold: number;
  /** 'firing' the first time it crosses, 'recovered' when it returns to zero. */
  state: 'firing' | 'recovered';
  organisationId: string;
  oldestAt: string | null;
}

interface AlertState {
  firing?: boolean;
  count?: number;
  at?: string;
}

/**
 * Turns "a job died" into something a person actually hears about.
 *
 * `GET /jobs/summary` has always had the numbers, but nothing read it on a
 * schedule, so a dead Meta lead-fetch — a real customer who filled in a form and
 * reached nobody — stayed invisible until someone happened to open the screen.
 *
 * Two deliberate limits. Alerts are DEDUPLICATED per tenant per condition: a
 * queue with forty dead jobs pages once, not forty times, and pages again only
 * after it recovers. And the payload carries counts, kinds and timestamps but
 * never a customer name, phone number, message body or provider token — an
 * alert leaves the trust boundary, and whoever runs the alert endpoint is not
 * necessarily allowed to see the tenant's customers.
 */
@Injectable()
export class JobAlertsService {
  private readonly logger = new Logger(JobAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private threshold(key: WatchKey): number {
    const configured = Number(
      this.config.get<string>(
        key === 'delivery_failures' ? 'OPS_ALERT_FAILED_THRESHOLD' : 'OPS_ALERT_DEAD_THRESHOLD',
      ),
    );
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    return key === 'delivery_failures' ? DEFAULT_FAILED_THRESHOLD : DEFAULT_DEAD_THRESHOLD;
  }

  /** One pass over every tenant. Returns the alerts it decided to send. */
  async sweep(organisationId?: string): Promise<JobAlert[]> {
    const organisations = organisationId
      ? [{ id: organisationId }]
      : await this.prisma.organisation.findMany({ select: { id: true } });

    const sent: JobAlert[] = [];
    for (const org of organisations) {
      try {
        sent.push(...(await this.sweepOrganisation(org.id)));
      } catch (error) {
        // One tenant's failure must not stop the sweep for the others.
        this.logger.warn(`Job alert sweep failed for ${org.id}: ${message(error)}`);
      }
    }
    return sent;
  }

  private async sweepOrganisation(organisationId: string): Promise<JobAlert[]> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const state = alertState(org?.settings);
    const decided: JobAlert[] = [];
    const nextState: Record<string, AlertState> = { ...state };

    for (const [key, watch] of Object.entries(WATCHED) as [WatchKey, (typeof WATCHED)[WatchKey]][]) {
      const threshold = this.threshold(key);
      const [count, oldest] = await Promise.all([
        this.prisma.jobTask.count({
          where: { organisationId, status: watch.status, kind: { in: [...watch.kinds] } },
        }),
        this.prisma.jobTask.findFirst({
          where: { organisationId, status: watch.status, kind: { in: [...watch.kinds] } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);

      const previous = state[watch.settingKey] ?? {};
      const shouldFire = count >= threshold;

      if (shouldFire && !previous.firing) {
        decided.push({
          key,
          label: watch.label,
          status: watch.status,
          count,
          threshold,
          state: 'firing',
          organisationId,
          oldestAt: oldest?.createdAt.toISOString() ?? null,
        });
        nextState[watch.settingKey] = { firing: true, count, at: new Date().toISOString() };
      } else if (!shouldFire && previous.firing) {
        decided.push({
          key,
          label: watch.label,
          status: watch.status,
          count,
          threshold,
          state: 'recovered',
          organisationId,
          oldestAt: null,
        });
        nextState[watch.settingKey] = { firing: false, count, at: new Date().toISOString() };
      } else if (shouldFire) {
        // Still firing: remember the current count, do not page again.
        nextState[watch.settingKey] = { ...previous, count };
      }
    }

    if (decided.length) {
      await updateOrgSettings(this.prisma, organisationId, (current) => ({
        ...current,
        [ALERT_STATE_KEY]: nextState,
      }));
      for (const alert of decided) await this.dispatch(alert);
    }
    return decided;
  }

  /**
   * Hand one alert to whatever is on the other end.
   *
   * With no destination configured this logs and returns — a missing webhook is
   * a deployment gap, not a reason to fail the sweep or lose the other alerts.
   */
  private async dispatch(alert: JobAlert): Promise<void> {
    const url = (this.config.get<string>('OPS_ALERT_WEBHOOK_URL') ?? '').trim();
    const line = `[job-alert] ${alert.state} ${alert.label}: ${alert.count} ${alert.status} (threshold ${alert.threshold}, tenant ${alert.organisationId})`;
    if (!url) {
      if (alert.state === 'firing') this.logger.error(line);
      else this.logger.log(line);
      return;
    }
    if (!/^https:\/\//i.test(url)) {
      this.logger.error('OPS_ALERT_WEBHOOK_URL must be an https URL; alert not sent.');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Counts and identifiers only. No customer, no message content, no token.
        body: JSON.stringify({
          source: 'caratos.jobs',
          state: alert.state,
          condition: alert.key,
          label: alert.label,
          jobStatus: alert.status,
          count: alert.count,
          threshold: alert.threshold,
          organisationId: alert.organisationId,
          oldestAt: alert.oldestAt,
          observedAt: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Alert webhook returned ${response.status}; ${line}`);
      }
    } catch (error) {
      // Never let the alert channel take down the thing it is watching.
      this.logger.warn(`Alert webhook failed (${message(error)}); ${line}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function alertState(settings: unknown): Record<string, AlertState> {
  const root = settings !== null && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
  const raw = root[ALERT_STATE_KEY];
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, AlertState>)
    : {};
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
