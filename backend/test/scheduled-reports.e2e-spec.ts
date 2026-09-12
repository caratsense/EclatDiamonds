import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { Workbook } from 'exceljs';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { ScheduledReportsService } from '../src/reporting/scheduled-reports.service';

/**
 * The month-end report nobody has to remember to run.
 *
 *  1. THE PERIOD IS ALWAYS A COMPLETED ONE. A monthly report run on the 1st
 *     covers the month that ended. A file with three days of the current month
 *     in it is the kind of number somebody quotes before noticing what it
 *     covers.
 *
 *  2. THE BOUNDARY IS THE BRANCH'S MIDNIGHT. In Asia/Kolkata a lead created at
 *     02:00 on the 1st is 20:30 UTC on the previous day. An unadjusted boundary
 *     files it in the wrong month, in the one figure a client reconciles.
 *
 *  3. EXACTLY ONCE PER PERIOD. An overlapping tick, a replica, a restart, and a
 *     manager pressing "send now" twice all collide on the same key. Nobody gets
 *     September's leads twice.
 *
 *  4. THE COLUMNS ARE THE TENANT'S. The workbook has the columns they chose, in
 *     their order — not sixteen columns and an instruction to ignore thirteen.
 *
 *  5. DELIVERY IS REPORTED HONESTLY. With no SMTP the file is still built and
 *     the run says `dry_run`, never `sent`.
 *
 *  6. IT RUNS AT THE BRANCH'S HOUR. A cron on the server's clock would send a
 *     chain's Auckland report in the middle of its night.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_rep_a',
  slug: 'rep-a',
  store: 'store_rep_a',
  other: 'store_rep_b',
  ho: 'ho.rep@rep-a.local',
  mgr: 'mgr.rep@rep-a.local',
  rep: 'rep.rep@rep-a.local',
};

/** The branch everything is anchored to. UTC+5:30, no DST. */
const TZ = 'Asia/Kolkata';

async function teardown(prisma: PrismaService) {
  await prisma.scheduledReportRun.deleteMany({ where: { organisationId: A.org } });
  await prisma.scheduledReport.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: A.org } } });
  await prisma.lead.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Scheduled reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reports: ScheduledReportsService;

  let hoT: string;
  let mgrT: string;
  let repT: string;
  let leadSeq = 0;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** A lead created at an exact instant, so month boundaries can be pinned. */
  async function lead(createdAt: Date, storeId = A.store) {
    leadSeq += 1;
    return prisma.lead.create({
      data: {
        organisationId: A.org,
        storeId,
        ref: `LD-REP-${leadSeq}`,
        customerName: `Customer ${leadSeq}`,
        phone: `9198100${String(10000 + leadSeq)}`,
        source: 'walk_in',
        stage: 'inquiry',
        createdAt,
      },
      select: { id: true },
    });
  }

  /** Read an XLSX response back as rows, so the assertion is on the real file. */
  async function sheetOf(res: request.Response): Promise<string[][]> {
    const wb = new Workbook();
    await wb.xlsx.load(res.body as never);
    const ws = wb.worksheets[0];
    const out: string[][] = [];
    ws.eachRow((row) => {
      const values = row.values as unknown[];
      out.push(values.slice(1).map((v) => (v == null ? '' : String(v))));
    });
    return out;
  }

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { ScheduledReportsService: S } = await import(
      '../src/reporting/scheduled-reports.service'
    );

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
    reports = app.get(S);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Rep A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.createMany({
      data: [
        { id: A.store, name: 'Bandra', city: 'Mumbai', organisationId: A.org, timezone: TZ },
        { id: A.other, name: 'Pune', city: 'Pune', organisationId: A.org, timezone: TZ },
      ],
    });
    for (const [id, email, role, storeId] of [
      ['u_rep_ho', A.ho, 'head_office', A.store],
      ['u_rep_mgr', A.mgr, 'store_manager', A.store],
      ['u_rep_rep', A.rep, 'salesperson', A.store],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: A.org,
          userStores: { create: { storeId, isPrimary: true } },
        },
      });
    }

    const login = async (email: string) =>
      (
        await request(server())
          .post('/auth/login')
          .send({ email, password: PASSWORD })
          .expect(201)
      ).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    repT = await login(A.rep);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. Periods
  // ==========================================================================

  it('a monthly report covers the month that ENDED, at the branch', () => {
    // 09:00 IST on 1 October 2026.
    const now = new Date('2026-10-01T03:30:00.000Z');
    const period = reports.monthEnding(now, TZ);

    expect(period.key).toBe('2026-09');
    // 00:00 IST on 1 September is 18:30 UTC on 31 August. If the window were
    // built from UTC midnight instead, a lead created in the small hours of the
    // 1st would land in August's report — in the number a client reconciles.
    expect(period.from.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(period.to.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('a weekly report covers Monday to Sunday, just ended', () => {
    // Monday 5 October 2026, 09:00 IST.
    const now = new Date('2026-10-05T03:30:00.000Z');
    const period = reports.weekEnding(now, TZ);

    // The week of Monday 28 September.
    expect(period.from.toISOString()).toBe('2026-09-27T18:30:00.000Z');
    expect(period.to.toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(period.key).toMatch(/^2026-W\d\d$/);
  });

  it('it is due on the 1st at the configured hour and at no other time', () => {
    const monthly = { cadence: 'monthly', sendHour: 7 };
    // 07:00 IST on the 1st.
    expect(reports.dueNow(monthly, new Date('2026-10-01T01:30:00.000Z'), TZ)).toBeTruthy();
    // 08:00 IST on the 1st — the next hour, already sent.
    expect(reports.dueNow(monthly, new Date('2026-10-01T02:30:00.000Z'), TZ)).toBeNull();
    // 07:00 IST on the 2nd.
    expect(reports.dueNow(monthly, new Date('2026-10-02T01:30:00.000Z'), TZ)).toBeNull();

    // 07:00 IST on the 1st is 01:30 UTC — a different DAY in UTC terms for part
    // of the month. A cron on the server's clock could not express this.
    expect(reports.dueNow(monthly, new Date('2026-09-30T20:00:00.000Z'), TZ)).toBeNull();

    const weekly = { cadence: 'weekly', sendHour: 7 };
    // Monday 5 October, 07:00 IST.
    expect(reports.dueNow(weekly, new Date('2026-10-05T01:30:00.000Z'), TZ)).toBeTruthy();
    // Tuesday.
    expect(reports.dueNow(weekly, new Date('2026-10-06T01:30:00.000Z'), TZ)).toBeNull();
  });

  // ==========================================================================
  // 2. Definitions
  // ==========================================================================

  it('a salesperson cannot schedule a file of every customer’s phone number', async () => {
    await request(server())
      .post('/reporting/scheduled')
      .set(auth(repT))
      .send({ name: 'Mine', cadence: 'monthly' })
      .expect(403);
  });

  it('a manager creates one, and the columns are theirs to choose', async () => {
    const res = await request(server())
      .post('/reporting/scheduled')
      .set(auth(mgrT))
      .send({
        name: 'Month-end leads',
        cadence: 'monthly',
        sendHour: 7,
        storeId: A.store,
        columns: ['customerName', 'phone', 'nextFollowUp'],
        recipients: ['owner@example.com', 'manager@example.com'],
      })
      .expect(201);

    expect(res.body.columns).toEqual(['customerName', 'phone', 'nextFollowUp']);
    expect(res.body.recipients).toHaveLength(2);
    expect(res.body.isActive).toBe(true);
  });

  it('refuses a column that does not exist and an address that is not one', async () => {
    await request(server())
      .post('/reporting/scheduled')
      .set(auth(mgrT))
      .send({ name: 'Bad columns', columns: ['customerName', 'bankBalance'] })
      .expect(400);

    const bad = await request(server())
      .post('/reporting/scheduled')
      .set(auth(mgrT))
      .send({ name: 'Bad address', recipients: ['owner at example.com'] })
      .expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/email address/i);
  });

  it('refuses a second report with the same name', async () => {
    const dup = await request(server())
      .post('/reporting/scheduled')
      .set(auth(mgrT))
      .send({ name: 'Month-end leads' })
      .expect(400);
    expect(JSON.stringify(dup.body)).toMatch(/already exists/i);
  });

  it('refuses a branch the manager cannot see', async () => {
    await request(server())
      .post('/reporting/scheduled')
      .set(auth(mgrT))
      .send({ name: 'Someone else’s branch', storeId: A.other })
      .expect(403);
  });

  // ==========================================================================
  // 3. Running it
  // ==========================================================================

  it('builds the period’s file, with the chosen columns, and records the run', async () => {
    // Three leads inside September (IST), one on 31 August, one on 1 October.
    await lead(new Date('2026-09-05T06:00:00.000Z'));
    await lead(new Date('2026-09-20T06:00:00.000Z'));
    // 00:30 IST on 1 September = 19:00 UTC on 31 August. INSIDE September at the
    // branch, and the row a UTC-boundary window would lose.
    await lead(new Date('2026-08-31T19:00:00.000Z'));
    // 23:30 IST on 31 August = 18:00 UTC. Outside September.
    await lead(new Date('2026-08-31T18:00:00.000Z'));
    // 00:30 IST on 1 October. Outside September.
    await lead(new Date('2026-09-30T19:00:00.000Z'));

    const list = await request(server()).get('/reporting/scheduled').set(auth(mgrT)).expect(200);
    const report = list.body.find((r: { name: string }) => r.name === 'Month-end leads');

    const period = reports.monthEnding(new Date('2026-10-01T03:30:00.000Z'), TZ);
    const res = await reports.runFor(report.id, period);

    expect(res).toBeTruthy();
    expect(res!.periodKey).toBe('2026-09');
    // Three, not two and not four: the branch's own September.
    expect(res!.rows).toBe(3);

    const runs = await prisma.scheduledReportRun.findMany({ where: { reportId: report.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    // No SMTP in the test environment. Honest label, not 'sent'.
    expect(runs[0].emailStatus).toBe('dry_run');
    expect(runs[0].emailDetail).toMatch(/not configured/i);
    expect(runs[0].recipients).toHaveLength(2);
  });

  it('running the same period again delivers nothing', async () => {
    const list = await request(server()).get('/reporting/scheduled').set(auth(mgrT)).expect(200);
    const report = list.body.find((r: { name: string }) => r.name === 'Month-end leads');
    const period = reports.monthEnding(new Date('2026-10-01T03:30:00.000Z'), TZ);

    // A second replica, an overlapping tick, a restart, a manager pressing the
    // button twice — all of them arrive here.
    expect(await reports.runFor(report.id, period)).toBeNull();
    expect(await reports.runFor(report.id, period)).toBeNull();

    expect(await prisma.scheduledReportRun.count({ where: { reportId: report.id } })).toBe(1);
  });

  it('the sweep sends nothing on an ordinary Tuesday afternoon', async () => {
    const res = await reports.sweep(new Date('2026-10-06T09:00:00.000Z'));
    expect(res.due).toBe(0);
    expect(res.delivered).toBe(0);
  });

  it('an empty period is reported as empty, not as a fault', async () => {
    const created = await request(server())
      .post('/reporting/scheduled')
      .set(auth(mgrT))
      .send({ name: 'Quiet month', cadence: 'monthly', storeId: A.store })
      .expect(201);

    // January 2020: nothing was created then.
    const period = reports.monthEnding(new Date('2020-02-01T03:30:00.000Z'), TZ);
    const res = await reports.runFor(created.body.id, period);
    expect(res!.rows).toBe(0);

    const run = await prisma.scheduledReportRun.findFirst({
      where: { reportId: created.body.id },
    });
    expect(run!.status).toBe('empty');
    // Nobody configured to receive it, said plainly rather than as a failure.
    expect(run!.emailStatus).toBe('no_recipients');
  });

  // ==========================================================================
  // 4. The file itself
  // ==========================================================================

  it('the download is a real workbook with exactly the chosen columns', async () => {
    const list = await request(server()).get('/reporting/scheduled').set(auth(mgrT)).expect(200);
    const report = list.body.find((r: { name: string }) => r.name === 'Month-end leads');

    const res = await request(server())
      .get(`/reporting/scheduled/${report.id}/download.xlsx`)
      .set(auth(mgrT))
      // supertest's text parser mangles binary; collect the bytes instead.
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/month-end-leads-\d{4}-\d{2}\.xlsx/);

    const rows = await sheetOf(res);
    // Three columns, in the order the tenant chose — not sixteen.
    expect(rows[0]).toEqual(['Customer', 'Phone', 'Next follow-up']);
  });

  // ==========================================================================
  // 5. Editing and switching off
  // ==========================================================================

  it('the run history is readable, and the list shows the last outcome', async () => {
    const list = await request(server()).get('/reporting/scheduled').set(auth(mgrT)).expect(200);
    const report = list.body.find((r: { name: string }) => r.name === 'Month-end leads');
    expect(report.lastRun.periodKey).toBe('2026-09');
    expect(report.lastRun.rows).toBe(3);
    expect(report.lastRun.emailStatus).toBe('dry_run');

    const runs = await request(server())
      .get(`/reporting/scheduled/${report.id}/runs`)
      .set(auth(mgrT))
      .expect(200);
    expect(runs.body).toHaveLength(1);
  });

  it('switching a report off takes it out of the sweep', async () => {
    const list = await request(server()).get('/reporting/scheduled').set(auth(mgrT)).expect(200);
    const report = list.body.find((r: { name: string }) => r.name === 'Month-end leads');

    await request(server())
      .patch(`/reporting/scheduled/${report.id}`)
      .set(auth(mgrT))
      .send({ isActive: false })
      .expect(200);

    // The 1st at 07:00 IST, exactly when it would otherwise have been due.
    await reports.sweep(new Date('2026-11-01T01:30:00.000Z'));

    const stillListed = await prisma.scheduledReport.findUnique({ where: { id: report.id } });
    expect(stillListed!.isActive).toBe(false);
    // No October run for it. Asserted on THIS report rather than on the sweep's
    // total, because the other report in this tenant is still switched on and is
    // legitimately due at the same instant.
    expect(
      await prisma.scheduledReportRun.count({
        where: { reportId: report.id, periodKey: '2026-10' },
      }),
    ).toBe(0);
  });

  it('head office can delete one, and its history goes with it', async () => {
    const created = await request(server())
      .post('/reporting/scheduled')
      .set(auth(hoT))
      .send({ name: 'Temporary', cadence: 'weekly' })
      .expect(201);

    await reports.runFor(created.body.id, reports.weekEnding(new Date(), 'Asia/Kolkata'));
    expect(
      await prisma.scheduledReportRun.count({ where: { reportId: created.body.id } }),
    ).toBe(1);

    await request(server())
      .delete(`/reporting/scheduled/${created.body.id}`)
      .set(auth(hoT))
      .expect(200);

    expect(await prisma.scheduledReport.findUnique({ where: { id: created.body.id } })).toBeNull();
    expect(
      await prisma.scheduledReportRun.count({ where: { reportId: created.body.id } }),
    ).toBe(0);
  });
});
