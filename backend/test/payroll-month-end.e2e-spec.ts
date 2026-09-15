import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { PayrollService } from '../src/hrms/payroll.service';

/**
 * Month-end payroll drafts.
 *
 *  1. A MONTH CLOSES AT THE BRANCH'S MIDNIGHT. 23:30 on 31 August in India is
 *     still August; 00:30 on 1 September is not. A branch in New York closes at
 *     ITS midnight, five and a half hours of server clock later than the IST one
 *     would suggest.
 *
 *  2. A RETRIED OR CONCURRENT TICK DRAFTS NOTHING TWICE. The claim is a unique
 *     row, so three sweeps racing each other produce one run and one slip each.
 *
 *  3. IT ONLY EVER DRAFTS. Nothing the scheduler touches is issued.
 *
 *  4. THE PEOPLE WHO REVIEW PAY ARE TOLD, AND NOBODY ELSE. The branch's manager
 *     and head office hear; the salesperson and the other branch's manager do not.
 *
 *  5. A PERSON CAN RE-RUN A MONTH, AND IT IS AUDITED.
 *
 *  6. A LATE CORRECTION FLAGS AN ISSUED SLIP; IT NEVER MOVES IT.
 *
 * The sweep takes `now` as a parameter, so every boundary here is an exact
 * instant rather than whatever the wall clock happens to say.
 */

// Set before AppModule is imported: the hourly cron must not sweep alongside
// the test's own calls.
process.env.SCHEDULER_ENABLED = 'false';

const PASSWORD = 'password123';

const ORG = 'org_pme';
const IST = 'store_pme_ist';
const NY = 'store_pme_ny';
const USERS = {
  ho: { id: 'u_pme_ho', email: 'ho@pme.local', role: 'head_office', store: IST },
  mgrIst: { id: 'u_pme_mgr_ist', email: 'mgr.ist@pme.local', role: 'store_manager', store: IST },
  mgrNy: { id: 'u_pme_mgr_ny', email: 'mgr.ny@pme.local', role: 'store_manager', store: NY },
  repIst: { id: 'u_pme_rep_ist', email: 'rep.ist@pme.local', role: 'salesperson', store: IST },
  repNy: { id: 'u_pme_rep_ny', email: 'rep.ny@pme.local', role: 'salesperson', store: NY },
} as const;

const AUG = (day: number) => new Date(Date.UTC(2026, 7, day));

async function teardown(prisma: PrismaService) {
  const ids = Object.values(USERS).map((u) => u.id);
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.payrollRun.deleteMany({ where: { organisationId: ORG } });
  await prisma.payslip.deleteMany({ where: { organisationId: ORG } });
  await prisma.staffCompensation.deleteMany({ where: { organisationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}

describe('Month-end payroll drafts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payroll: PayrollService;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const schedulerRuns = (periodKey: string, storeId?: string) =>
    prisma.payrollRun.findMany({
      where: { organisationId: ORG, periodKey, trigger: 'scheduler', ...(storeId ? { storeId } : {}) },
    });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { PayrollService: Payroll } = await import('../src/hrms/payroll.service');

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(P);
    payroll = app.get(Payroll);
    await teardown(prisma);

    await prisma.organisation.create({
      data: { id: ORG, name: 'Month End', slug: 'pme', industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: IST, name: 'Bandra', city: 'Mumbai', organisationId: ORG, timezone: 'Asia/Kolkata' },
    });
    await prisma.store.create({
      data: { id: NY, name: 'Madison', city: 'New York', organisationId: ORG, timezone: 'America/New_York' },
    });

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const u of Object.values(USERS)) {
      await prisma.user.create({
        data: {
          id: u.id,
          email: u.email,
          name: u.id,
          role: u.role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: ORG,
          userStores: { create: { storeId: u.store, isPrimary: true } },
        },
      });
    }

    // August has 31 days, so 31,000 a month is 1,000 a day.
    for (const id of [USERS.repIst.id, USERS.repNy.id]) {
      await prisma.staffCompensation.create({
        data: { organisationId: ORG, userId: id, basis: 'monthly', amount: 31_000 },
      });
    }
    // The IST salesperson: every day present except an absence on the 10th and a
    // half day on the 11th. The NY one: every day present.
    for (let d = 1; d <= 31; d++) {
      const [status, dayFraction] = d === 10 ? ['absent', 0] : d === 11 ? ['half_day', 0.5] : ['present', 1];
      await prisma.attendanceRecord.create({
        data: {
          organisationId: ORG,
          storeId: IST,
          staffId: USERS.repIst.id,
          date: AUG(d),
          status: status as never,
          dayFraction,
        },
      });
      await prisma.attendanceRecord.create({
        data: {
          organisationId: ORG,
          storeId: NY,
          staffId: USERS.repNy.id,
          date: AUG(d),
          status: 'present',
          dayFraction: 1,
        },
      });
    }

    for (const [key, u] of Object.entries(USERS)) {
      tokens[key] = (
        await request(server()).post('/auth/login').send({ email: u.email, password: PASSWORD }).expect(201)
      ).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. The boundary
  // ==========================================================================

  it('at 23:30 on 31 August in India, August has not closed', async () => {
    await payroll.sweepMonthEnd(new Date('2026-08-31T23:30:00+05:30'));

    expect(await prisma.payrollRun.count({ where: { organisationId: ORG } })).toBe(0);
    expect(await prisma.payslip.count({ where: { organisationId: ORG } })).toBe(0);
  });

  it('at 00:30 on 1 September in India, the Indian branch drafts August — and only that branch', async () => {
    await payroll.sweepMonthEnd(new Date('2026-09-01T00:30:00+05:30'));

    const [run] = await schedulerRuns('2026-08', IST);
    expect(run).toBeTruthy();
    expect(run.status).toBe('completed');
    expect(run.generated).toBe(1);
    // The manager has no pay recorded, and is NAMED rather than merely counted.
    expect(run.skipped).toBe(1);
    expect(JSON.stringify(run.skippedDetail)).toContain(USERS.mgrIst.id);
    expect(run.finishedAt).toBeTruthy();

    // It is still 15:00 on 31 August in New York.
    expect(await schedulerRuns('2026-08', NY)).toHaveLength(0);

    const slip = await prisma.payslip.findUnique({
      where: { userId_periodKey: { userId: USERS.repIst.id, periodKey: '2026-08' } },
    });
    // The existing register rules, unchanged: one absence, one half day.
    expect(Number(slip!.presentDays)).toBe(29.5);
    expect(Number(slip!.unpaidDays)).toBe(1.5);
    expect(Number(slip!.netPay)).toBe(29_500);
  });

  it('a branch in New York closes August at its own midnight', async () => {
    // 23:30 on 31 August in New York.
    await payroll.sweepMonthEnd(new Date('2026-09-01T03:30:00Z'));
    expect(await schedulerRuns('2026-08', NY)).toHaveLength(0);

    // 00:30 on 1 September in New York.
    await payroll.sweepMonthEnd(new Date('2026-09-01T04:30:00Z'));
    const [run] = await schedulerRuns('2026-08', NY);
    expect(run?.status).toBe('completed');
    expect(run?.generated).toBe(1);
  });

  // ==========================================================================
  // 2. Idempotence
  // ==========================================================================

  it('a retried tick later in the window drafts nothing again', async () => {
    const before = await prisma.payslip.findUnique({
      where: { userId_periodKey: { userId: USERS.repIst.id, periodKey: '2026-08' } },
    });
    await payroll.sweepMonthEnd(new Date('2026-09-03T10:00:00+05:30'));

    expect(await schedulerRuns('2026-08')).toHaveLength(2);
    const after = await prisma.payslip.findUnique({
      where: { userId_periodKey: { userId: USERS.repIst.id, periodKey: '2026-08' } },
    });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it('three sweeps racing at the same instant make one run and one slip', async () => {
    // September has no attendance at all — the slip is drafted regardless, and
    // says so day by day. It is the claim being raced here, not the figures.
    const at = new Date('2026-10-01T00:30:00+05:30');
    await Promise.all([payroll.sweepMonthEnd(at), payroll.sweepMonthEnd(at), payroll.sweepMonthEnd(at)]);

    expect(await schedulerRuns('2026-09', IST)).toHaveLength(1);
    expect(
      await prisma.payslip.count({ where: { userId: USERS.repIst.id, periodKey: '2026-09' } }),
    ).toBe(1);
  });

  it('two manual runs of the same month at once still leave one slip per person', async () => {
    const [a, b] = await Promise.all(
      [0, 1].map(() =>
        request(server())
          .post('/hrms/payroll/runs')
          .set(auth(tokens.mgrIst))
          .send({ storeId: IST, periodKey: '2026-08' }),
      ),
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect([a.body.status, b.body.status]).toEqual(['completed', 'completed']);
    expect(
      await prisma.payslip.count({ where: { userId: USERS.repIst.id, periodKey: '2026-08' } }),
    ).toBe(1);
  });

  // ==========================================================================
  // 3. Drafts only
  // ==========================================================================

  it('never issues anything', async () => {
    const slips = await prisma.payslip.findMany({ where: { organisationId: ORG } });
    expect(slips.length).toBeGreaterThan(0);
    for (const s of slips) {
      expect(s.status).toBe('draft');
      expect(s.issuedAt).toBeNull();
      expect(s.issuedById).toBeNull();
    }

    const res = await request(server())
      .get('/hrms/payroll/payslips?periodKey=2026-08')
      .set(auth(tokens.repIst))
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].note).toMatch(/before tax and statutory deductions/i);
  });

  // ==========================================================================
  // 4. Who is told
  // ==========================================================================

  it('tells the branch manager and head office, and not the salesperson or another branch', async () => {
    const [run] = await schedulerRuns('2026-08', IST);
    const told = await prisma.notification.findMany({
      where: { entityType: 'PayrollRun', entityId: run.id },
      select: { userId: true, title: true, body: true },
    });
    const who = told.map((n) => n.userId).sort();
    expect(who).toEqual([USERS.ho.id, USERS.mgrIst.id].sort());
    expect(told[0].title).toContain('August 2026');
    expect(told[0].body).toMatch(/Nothing has been issued/);
  });

  it('records the scheduler’s run in the audit trail as the automation, not a person', async () => {
    const [run] = await schedulerRuns('2026-08', IST);
    const row = await prisma.auditLog.findFirst({
      where: { organisationId: ORG, action: 'hrms.payroll_month_end', entityId: run.id },
    });
    expect(row?.systemActorId).toBe('payroll_month_end');
    expect(row?.actorId).toBeNull();
  });

  // ==========================================================================
  // 5. Re-running
  // ==========================================================================

  it('a manager re-runs a branch-month, and it is audited against them', async () => {
    const res = await request(server())
      .post('/hrms/payroll/runs')
      .set(auth(tokens.mgrIst))
      .send({ storeId: IST, periodKey: '2026-08' })
      .expect(201);
    expect(res.body.trigger).toBe('user');
    expect(res.body.triggeredById).toBe(USERS.mgrIst.id);
    expect(res.body.status).toBe('completed');
    expect(res.body.schedulerKey).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: ORG, action: 'hrms.payroll_rerun', entityId: res.body.id },
    });
    expect(audit?.actorId).toBe(USERS.mgrIst.id);

    const log = await request(server())
      .get('/hrms/payroll/runs?periodKey=2026-08')
      .set(auth(tokens.mgrIst))
      .expect(200);
    const triggers = new Set(log.body.map((r: { trigger: string }) => r.trigger));
    expect(triggers).toEqual(new Set(['scheduler', 'user']));
    // Their own branch only.
    expect(log.body.every((r: { storeId: string }) => r.storeId === IST)).toBe(true);
  });

  it('a salesperson cannot run or read payroll runs, and a manager cannot run another branch', async () => {
    await request(server())
      .post('/hrms/payroll/runs')
      .set(auth(tokens.repIst))
      .send({ storeId: IST, periodKey: '2026-08' })
      .expect(403);
    await request(server()).get('/hrms/payroll/runs').set(auth(tokens.repIst)).expect(403);
    await request(server())
      .post('/hrms/payroll/runs')
      .set(auth(tokens.mgrNy))
      .send({ storeId: IST, periodKey: '2026-08' })
      .expect(403);
  });

  // ==========================================================================
  // 6. After issue
  // ==========================================================================

  it('a correction after issue flags the slip and does not move it', async () => {
    const list = await request(server())
      .get(`/hrms/payroll/payslips?periodKey=2026-08&userId=${USERS.repIst.id}`)
      .set(auth(tokens.mgrIst))
      .expect(200);
    const slipId = list.body[0].id;
    await request(server())
      .post(`/hrms/payroll/payslips/${slipId}/issue`)
      .set(auth(tokens.mgrIst))
      .expect(201);
    const issued = await prisma.payslip.findUniqueOrThrow({ where: { id: slipId } });

    // A week later the manager corrects the absence on the 10th.
    await request(server())
      .post('/hrms/attendance')
      .set(auth(tokens.mgrIst))
      .send({ staffId: USERS.repIst.id, storeId: IST, status: 'present', date: '2026-08-10' })
      .expect(201);

    const after = await request(server())
      .get(`/hrms/payroll/payslips/${slipId}`)
      .set(auth(tokens.mgrIst))
      .expect(200);
    // The number the employee was shown is the number.
    expect(after.body.status).toBe('issued');
    expect(after.body.netPay).toBe(29_500);
    expect(after.body.presentDays).toBe(29.5);
    expect(after.body.breakdown).toEqual(issued.breakdown);
    // And the late correction is visible beside it.
    expect(after.body.differenceDetectedAt).toBeTruthy();
    expect(after.body.difference.days).toEqual([
      { date: '2026-08-10', was: { kind: 'absent', credit: 0 }, now: { kind: 'present', credit: 1 } },
    ]);
    expect(after.body.difference.presentDays).toEqual({ was: 29.5, now: 30.5 });

    // A re-run counts it as issued and different, and still does not touch it.
    const rerun = await request(server())
      .post('/hrms/payroll/runs')
      .set(auth(tokens.mgrIst))
      .send({ storeId: IST, periodKey: '2026-08' })
      .expect(201);
    expect(rerun.body.generated).toBe(0);
    expect(rerun.body.issued).toBe(1);
    expect(rerun.body.differences).toBe(1);

    const final = await prisma.payslip.findUniqueOrThrow({ where: { id: slipId } });
    expect(Number(final.netPay)).toBe(29_500);
    expect(final.breakdown).toEqual(issued.breakdown);
    expect(final.issuedAt?.getTime()).toBe(issued.issuedAt?.getTime());
  });
});
