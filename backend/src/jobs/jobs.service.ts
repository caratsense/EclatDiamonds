import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { runAsPlatform, runAsTenant } from '../common/tenant-context';

/**
 * JobsService — durable background work on PostgreSQL (CaratOS Phase A8).
 *
 * WHY NOT REDIS/BULLMQ: the system already runs Postgres and already has a
 * scheduler. A broker would add a second service that can be down, a second
 * thing to back up, and a second place tenant data lives — to move a few hundred
 * jobs a day. `SELECT … FOR UPDATE SKIP LOCKED` is the right tool at this size
 * and is transactionally consistent with the data the jobs operate on, which a
 * separate broker never is.
 *
 * GUARANTEES
 *   at-least-once  — a worker that dies mid-job has its lease reclaimed and the
 *                    job runs again. Handlers must therefore be idempotent; the
 *                    `idempotencyKey` on enqueue prevents duplicate ENQUEUES, not
 *                    duplicate EXECUTIONS, and that distinction matters.
 *   ordered-ish    — priority then runAt. Not a strict FIFO, and nothing here
 *                    pretends otherwise.
 *   tenant-bound   — every tenant job runs inside runAsTenant, so a handler that
 *                    reads the ambient tenant gets the right one.
 */

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<unknown>;

export interface JobContext {
  jobId: string;
  organisationId: string | null;
  attempt: number;
  kind: string;
}

/** Lease length. A job still 'running' with an older lock is presumed abandoned. */
const LEASE_MINUTES = 15;

/**
 * Exponential backoff, capped. attempt 1 → 1m, 2 → 4m, 3 → 9m … capped at 1h.
 * Exported so a handler recording its own "next retry" states the same time the
 * queue will actually use.
 */
export function backoffMs(attempt: number): number {
  return Math.min(attempt * attempt * 60_000, 60 * 60_000);
}

@Injectable()
export class JobsService {
  private readonly log = new Logger(JobsService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private draining = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a handler for a job kind. Called from a module's onModuleInit.
   * Registering twice is a programming error and is refused loudly rather than
   * silently replacing a handler.
   */
  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`A handler for job kind "${kind}" is already registered.`);
    }
    this.handlers.set(kind, handler);
  }

  registeredKinds(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * Queue work.
   *
   * `idempotencyKey` MUST include the organisation id when the job is
   * tenant-owned — the uniqueness is table-wide, so a key like
   * `"import:batch-7"` would let one tenant's enqueue block another's.
   */
  async enqueue(input: {
    kind: string;
    payload: Prisma.InputJsonValue;
    organisationId?: string | null;
    idempotencyKey?: string;
    runAt?: Date;
    priority?: number;
    maxAttempts?: number;
    createdById?: string;
  }): Promise<{ id: string; deduplicated: boolean }> {
    if (!this.handlers.has(input.kind)) {
      // Enqueuing work nothing can run leaves a row that retries to 'dead' and
      // pages someone at 3am. Refuse at the point of the mistake.
      throw new Error(
        `No handler registered for job kind "${input.kind}". Registered: ${
          this.registeredKinds().join(', ') || '(none)'
        }`,
      );
    }

    if (input.idempotencyKey) {
      const open = await this.prisma.jobTask.findFirst({
        where: {
          idempotencyKey: input.idempotencyKey,
          status: { in: ['pending', 'running'] },
        },
        select: { id: true },
      });
      if (open) return { id: open.id, deduplicated: true };
    }

    try {
      const job = await this.prisma.jobTask.create({
        data: {
          kind: input.kind,
          payload: input.payload,
          organisationId: input.organisationId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          runAt: input.runAt ?? new Date(),
          priority: input.priority ?? 0,
          maxAttempts: input.maxAttempts ?? 5,
          createdById: input.createdById ?? null,
        },
        select: { id: true },
      });
      return { id: job.id, deduplicated: false };
    } catch (e) {
      // A finished job keeps its key, so a re-run of the same logical work
      // collides. That is a legitimate "already done", not an error.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && input.idempotencyKey) {
        const prior = await this.prisma.jobTask.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (prior) return { id: prior.id, deduplicated: true };
      }
      throw e;
    }
  }

  /**
   * Claim one job atomically.
   *
   * `FOR UPDATE SKIP LOCKED` inside the sub-select is what makes this safe with
   * several replicas: two workers racing pick different rows instead of both
   * taking the same one, and neither blocks waiting for the other.
   */
  private async claim(): Promise<ClaimedJob | null> {
    /*
     * UTC, stated. Prisma stores DateTime as `timestamp` WITHOUT a zone, holding
     * UTC. Bare NOW() is a timestamptz, and comparing or assigning it to such a
     * column converts through the SESSION timezone: on a database whose default
     * zone is Asia/Kolkata every retry looked 5h30m overdue (backoff ignored, all
     * attempts burnt in one drain) and every lease looked 5h30m fresh (a dead
     * worker's job not reclaimed). The row's clock and this query's clock must
     * be the same clock.
     */
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "JobTask" SET
        status = 'running',
        "lockedBy" = ${this.workerId},
        "lockedAt" = (NOW() AT TIME ZONE 'UTC'),
        "startedAt" = COALESCE("startedAt", (NOW() AT TIME ZONE 'UTC')),
        attempts = attempts + 1,
        "updatedAt" = (NOW() AT TIME ZONE 'UTC')
      WHERE id = (
        SELECT id FROM "JobTask"
        WHERE status = 'pending' AND "runAt" <= (NOW() AT TIME ZONE 'UTC')
        ORDER BY priority DESC, "runAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, kind, payload, "organisationId", attempts, "maxAttempts";
    `;
    return rows[0] ?? null;
  }

  /**
   * Return abandoned jobs to the queue.
   *
   * A worker that was killed mid-job leaves a row stuck in 'running' forever.
   * The lease turns that from a permanent stall into a delayed retry.
   */
  async reclaimStale(): Promise<number> {
    const cutoff = new Date(Date.now() - LEASE_MINUTES * 60_000);
    const result = await this.prisma.jobTask.updateMany({
      where: { status: 'running', lockedAt: { lt: cutoff } },
      data: { status: 'pending', lockedBy: null, lockedAt: null, lastError: 'Worker lease expired; retrying.' },
    });
    if (result.count) {
      this.log.warn(`Reclaimed ${result.count} job(s) from workers that stopped responding.`);
    }
    return result.count;
  }

  /**
   * Run up to `max` due jobs. Called by the scheduler; also usable directly in
   * tests so a job can be driven without waiting for a tick.
   *
   * Self-guarded against overlap: a slow batch must not have a second tick
   * running on top of it inside the same process.
   */
  async drain(max = 10): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.draining) return { processed: 0, succeeded: 0, failed: 0 };
    this.draining = true;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    try {
      await this.reclaimStale();
      let reclaimedAt = Date.now();
      for (let i = 0; i < max; i++) {
        // A long drain must not hold back a job orphaned by a restart until it
        // ends: look for expired leases at least once a minute.
        if (Date.now() - reclaimedAt > 60_000) {
          await this.reclaimStale();
          reclaimedAt = Date.now();
        }
        const job = await this.claim();
        if (!job) break;
        processed++;
        const ok = await this.run(job);
        if (ok) succeeded++;
        else failed++;
      }
    } finally {
      this.draining = false;
    }
    return { processed, succeeded, failed };
  }

  private async run(job: ClaimedJob): Promise<boolean> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      // Handler removed between enqueue and execution (a rollback, say). Park it
      // as dead rather than retrying something that can never succeed.
      await this.prisma.jobTask.update({
        where: { id: job.id },
        data: {
          status: 'dead',
          finishedAt: new Date(),
          lastError: `No handler registered for "${job.kind}".`,
          lockedBy: null,
          lockedAt: null,
        },
      });
      return false;
    }

    const ctx: JobContext = {
      jobId: job.id,
      organisationId: job.organisationId,
      attempt: job.attempts,
      kind: job.kind,
    };

    // Bind the tenant for the whole handler, so anything reading ambient context
    // (logging, and later RLS) sees the right organisation. A platform job says
    // so explicitly rather than running with no scope at all.
    const invoke = () => handler(job.payload, ctx);
    const bound = job.organisationId
      ? () => runAsTenant({ organisationId: job.organisationId as string, actor: 'job', requestId: job.id }, invoke)
      : () => runAsPlatform(`job:${job.kind}`, invoke, job.id);

    try {
      const result = await bound();
      await this.prisma.jobTask.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          result: (result ?? undefined) as Prisma.InputJsonValue | undefined,
          lastError: null,
          lockedBy: null,
          lockedAt: null,
        },
      });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const exhausted = job.attempts >= job.maxAttempts;
      await this.prisma.jobTask.update({
        where: { id: job.id },
        data: {
          // 'dead' is a terminal state needing a human. It is deliberately
          // distinct from 'failed' so a dashboard can show "needs attention"
          // separately from "will retry shortly".
          status: exhausted ? 'dead' : 'pending',
          runAt: exhausted ? undefined : new Date(Date.now() + backoffMs(job.attempts)),
          finishedAt: exhausted ? new Date() : null,
          lastError: message.slice(0, 2000),
          lockedBy: null,
          lockedAt: null,
        },
      });
      this.log[exhausted ? 'error' : 'warn'](
        `Job ${job.kind} (${job.id}) ${exhausted ? 'died after' : 'failed on'} attempt ${job.attempts}: ${message}`,
      );
      return false;
    }
  }

  /** Queue visibility, organisation-scoped. */
  async list(
    organisationId: string,
    opts: { status?: string; kind?: string; limit?: number } = {},
  ) {
    return this.prisma.jobTask.findMany({
      where: {
        organisationId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    });
  }

  /** Counts by status, for the "is anything stuck?" panel. */
  async summary(organisationId: string) {
    const grouped = await this.prisma.jobTask.groupBy({
      by: ['status'],
      where: { organisationId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;
    return {
      counts,
      needsAttention: counts.dead,
      registeredKinds: this.registeredKinds(),
    };
  }

  /** Put a dead job back on the queue after the cause has been fixed. */
  async retry(organisationId: string, jobId: string) {
    const job = await this.prisma.jobTask.findFirst({
      where: { id: jobId, organisationId },
      select: { id: true, status: true },
    });
    if (!job) return null;
    if (job.status !== 'dead' && job.status !== 'succeeded') return null;
    return this.prisma.jobTask.update({
      where: { id: jobId },
      data: {
        status: 'pending',
        attempts: 0,
        runAt: new Date(),
        lastError: null,
        finishedAt: null,
        startedAt: null,
      },
    });
  }
}

interface ClaimedJob {
  id: string;
  kind: string;
  payload: unknown;
  organisationId: string | null;
  attempts: number;
  maxAttempts: number;
}
