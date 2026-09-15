import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { JobsService } from '../src/jobs/jobs.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The job queue reads the same clock the rows were written with.
 *
 * Prisma stores DateTime as a zone-less timestamp holding UTC. The claim query
 * used bare NOW(), which Postgres converts through the SESSION timezone, so on a
 * database whose default zone is not UTC (a developer machine in India is
 * Asia/Kolkata) a job due in an hour looked five and a half hours overdue: the
 * retry backoff did nothing and one drain burnt every attempt.
 *
 * The session zone is forced to Asia/Kolkata here so the assertion holds on any
 * machine, including a UTC one where the old query happened to be right.
 */

const KIND = 'test.clock-probe';

describe('Job queue clock (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  const ran: string[] = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    jobs = app.get(JobsService);
    jobs.register(KIND, async (payload) => {
      ran.push((payload as { tag: string }).tag);
      return { ok: true };
    });
    await prisma.jobTask.deleteMany({ where: { kind: KIND } });
  });

  afterAll(async () => {
    if (prisma) await prisma.jobTask.deleteMany({ where: { kind: KIND } });
    if (app) await app.close();
  });

  it('does not run a job before its time, whatever the session timezone', async () => {
    // Every pooled connection, not just one: the claim may use any of them.
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${(await prisma.$queryRawUnsafe<{ d: string }[]>('SELECT current_database() AS d'))[0].d}" SET timezone TO 'Asia/Kolkata'`);
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'Asia/Kolkata'`);

    await jobs.enqueue({
      kind: KIND,
      payload: { tag: 'later' },
      runAt: new Date(Date.now() + 60 * 60_000),
      idempotencyKey: 'clock-probe-later',
    });
    await jobs.enqueue({ kind: KIND, payload: { tag: 'now' }, idempotencyKey: 'clock-probe-now' });

    await jobs.drain(10);
    expect(ran).toContain('now');
    expect(ran).not.toContain('later');

    const later = await prisma.jobTask.findUniqueOrThrow({ where: { idempotencyKey: 'clock-probe-later' } });
    expect(later.status).toBe('pending');
    expect(later.attempts).toBe(0);

    // And a claimed row's lease is stamped in UTC, so a stale lease is reclaimable.
    const done = await prisma.jobTask.findUniqueOrThrow({ where: { idempotencyKey: 'clock-probe-now' } });
    expect(Math.abs(done.startedAt!.getTime() - Date.now())).toBeLessThan(5 * 60_000);
  });
});
