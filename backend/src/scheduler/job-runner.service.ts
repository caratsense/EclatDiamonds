import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Runs a scheduled job at most once per (job, scope, runKey), across every API
 * instance, and leaves a record of what happened.
 *
 * The claim is an INSERT against a unique index rather than an in-process flag or
 * a lock: `@Cron` fires inside each replica, and an in-memory guard only stops
 * the same process running twice. Two replicas closing the same business day
 * would both write attendance for it. Whoever inserts first owns the run.
 *
 * A Postgres advisory lock would also serialise this, but it is tied to the
 * connection that took it — with a pooled client the unlock is not guaranteed to
 * land on the same connection, so a crash could leave the lock held. A row is
 * simpler, survives restarts, and answers "did last night's close actually run?"
 * — which nothing recorded before.
 */
@Injectable()
export class JobRunnerService {
  private readonly logger = new Logger(JobRunnerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim and execute. Returns the job's value, or null when another instance
   * already claimed this exact run (which is a normal, quiet outcome).
   */
  async runOnce<T>(
    // Nullable for genuinely cross-tenant maintenance jobs (e.g. the WhatsApp
    // inbound sweep, whose events span organisations and may have none yet). The
    // organisationId column is itself nullable for exactly this "global" case.
    organisationId: string | null,
    job: string,
    scope: string,
    runKey: string,
    work: () => Promise<T>,
  ): Promise<T | null> {
    let claim: { id: string };
    try {
      claim = await this.prisma.scheduledJobRun.create({
        data: { organisationId, job, scope, runKey, status: 'running' },
        select: { id: true },
      });
    } catch (err) {
      // P2002 = unique violation: someone else has this run. Not an error.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null;
      }
      throw err;
    }

    try {
      const result = await work();
      await this.prisma.scheduledJobRun.update({
        where: { id: claim.id },
        data: {
          status: 'ok',
          endedAt: new Date(),
          detail: summarise(result),
        },
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`${job} [${scope}/${runKey}] failed: ${message}`);
      await this.prisma.scheduledJobRun.update({
        where: { id: claim.id },
        data: { status: 'failed', endedAt: new Date(), detail: message.slice(0, 500) },
      });
      // Swallowed on purpose: one store's failure must not stop the loop from
      // closing the others. The row records it, and the log carries the stack.
      return null;
    }
  }
}

/** Compact a job result into something readable in the run log. */
function summarise(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result.slice(0, 500);
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return null;
  }
}
