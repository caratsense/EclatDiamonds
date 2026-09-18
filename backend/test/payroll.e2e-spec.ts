import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Individual weekly offs, and a payslip built from the attendance register.
 *
 *  1. THE OFF DAY IS THE PERSON'S, NOT THE BRANCH'S. A shop that never closes
 *     rotates its staff. Marking the whole floor off on Tuesday while half of it
 *     is serving customers makes the register fiction and every figure computed
 *     from it wrong. Their own roster REPLACES the branch's; it does not add to
 *     it.
 *
 *  2. NO ROSTER MEANS TODAY'S BEHAVIOUR. An employee with no rows follows the
 *     store's weekOffDay exactly as before.
 *
 *  3. A DAY WITH NO RECORD IS NOT QUIETLY PAID, and it is distinguishable from
 *     a recorded absence — "they did not come" and "the register says nothing"
 *     are different conversations.
 *
 *  4. MONTHLY AND DAILY ARE NOT THE SAME SUM. On a monthly salary the offs and
 *     holidays are paid; on a daily wage they are not. Paying one as the other
 *     is a real overpayment every month.
 *
 *  5. AN ISSUED PAYSLIP DOES NOT MOVE. Once an employee has been shown a number,
 *     a roster corrected afterwards must not change it.
 *
 *  6. PAY IS NOT PUBLIC. A colleague cannot read somebody else's slip, and a
 *     store manager cannot set what their own team is paid.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_pay_a',
  slug: 'pay-a',
  store: 'store_pay_a',
  ho: 'ho.pay@pay-a.local',
  mgr: 'mgr.pay@pay-a.local',
  rep: 'rep.pay@pay-a.local',
  rep2: 'rep2.pay@pay-a.local',
};

/** September 2026: 30 days, 1st is a Tuesday. */
const PERIOD = '2026-09';
const SEPT = (day: number) => new Date(Date.UTC(2026, 8, day));

async function teardown(prisma: PrismaService) {
  await prisma.payrollRun.deleteMany({ where: { organisationId: A.org } });
  await prisma.payslip.deleteMany({ where: { organisationId: A.org } });
  await prisma.staffCompensation.deleteMany({ where: { organisationId: A.org } });
  await prisma.staffWeekOff.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.rawPunchEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.storeHoliday.deleteMany({ where: { organisationId: A.org } });
  await prisma.leaveRequest.deleteMany({ where: { organisationId: A.org } });
  await prisma.shift.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Individual weekly offs and attendance-based payslips (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let hoT: string;
  let mgrT: string;
  let repT: string;
  let rep2T: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** Attendance for one day. */
  async function mark(
    staffId: string,
    day: number,
    status: string,
    opts: { dayFraction?: number; overtimeMins?: number } = {},
  ) {
    return prisma.attendanceRecord.create({
      data: {
        organisationId: A.org,
        storeId: A.store,
        staffId,
        date: SEPT(day),
        status: status as never,
        dayFraction: opts.dayFraction != null ? opts.dayFraction : undefined,
        overtimeMins: opts.overtimeMins,
      },
    });
  }

  /** Every working day of September present, for one person. */
  async function fullMonth(staffId: string, skip: number[] = []) {
    for (let d = 1; d <= 30; d++) {
      if (skip.includes(d)) continue;
      await mark(staffId, d, 'present', { dayFraction: 1 });
    }
  }

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');

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
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Pay A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: {
        id: A.store,
        name: 'Bandra',
        city: 'Mumbai',
        organisationId: A.org,
        timezone: 'Asia/Kolkata',
        // The branch closes on Sundays. The fallback for anybody with no roster.
        weekOffDay: 0,
      },
    });
    for (const [id, email, role] of [
      ['u_pay_ho', A.ho, 'head_office'],
      ['u_pay_mgr', A.mgr, 'store_manager'],
      ['u_pay_rep', A.rep, 'salesperson'],
      ['u_pay_rep2', A.rep2, 'salesperson'],
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
          userStores: { create: { storeId: A.store, isPrimary: true } },
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
    rep2T = await login(A.rep2);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. Weekly offs
  // ==========================================================================

  it('with no roster, everybody follows the branch', async () => {
    const res = await request(server())
      .get('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      .expect(200);

    const rep = res.body.staff.find((s: { userId: string }) => s.userId === 'u_pay_rep');
    expect(rep.days).toEqual([]);
    expect(rep.followsStore).toBe(true);
    // Sunday, from the store.
    expect(rep.effectiveDays).toEqual([0]);
  });

  it('an employee gets their own day, and it REPLACES the branch’s', async () => {
    await request(server())
      .put('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      // Wednesday.
      .send({ userId: 'u_pay_rep', days: [3] })
      .expect(200);

    const res = await request(server())
      .get('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      .expect(200);
    const rep = res.body.staff.find((s: { userId: string }) => s.userId === 'u_pay_rep');
    expect(rep.days).toEqual([3]);
    expect(rep.followsStore).toBe(false);
    // NOT [0, 3]. Somebody whose day off moved to Wednesday is not also off on
    // Sunday — that would give them two days and nobody asked for it.
    expect(rep.effectiveDays).toEqual([3]);
  });

  it('two days off is allowed; four is a data-entry error', async () => {
    await request(server())
      .put('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep2', days: [0, 4] })
      .expect(200);

    await request(server())
      .put('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep2', days: [0, 1, 2, 3] })
      .expect(400);
  });

  it('clearing the roster puts them back on the branch’s day', async () => {
    await request(server())
      .put('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep2', days: [] })
      .expect(200);

    const res = await request(server())
      .get('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      .expect(200);
    const rep2 = res.body.staff.find((s: { userId: string }) => s.userId === 'u_pay_rep2');
    expect(rep2.followsStore).toBe(true);
    expect(rep2.effectiveDays).toEqual([0]);
  });

  it('the day close marks each person off on THEIR day, not the branch’s', async () => {
    // Wednesday 2 September 2026. The branch's off day is Sunday.
    const wednesday = '2026-09-02';
    await request(server())
      .post('/hrms/attendance/day-close')
      .set(auth(mgrT))
      .send({ storeId: A.store, date: wednesday })
      .expect(201);

    const rows = await prisma.attendanceRecord.findMany({
      where: { storeId: A.store, date: new Date(`${wednesday}T00:00:00.000Z`) },
    });
    const rep = rows.find((r) => r.staffId === 'u_pay_rep');
    const rep2 = rows.find((r) => r.staffId === 'u_pay_rep2');

    // The one rostered off on Wednesday.
    expect(rep!.status).toBe('week_off');
    // The one who follows the branch: Wednesday is a working day, so absent.
    expect(rep2!.status).toBe('absent');

    // Clear them so the payslip tests start from a known register.
    await prisma.attendanceRecord.deleteMany({
      where: { storeId: A.store, date: new Date(`${wednesday}T00:00:00.000Z`) },
    });
  });

  // ==========================================================================
  // 2. Compensation
  // ==========================================================================

  it('a store manager cannot set what their own team is paid', async () => {
    await request(server())
      .put('/hrms/payroll/compensation')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', amount: 30_000 })
      .expect(403);
  });

  it('head office records it, and the audit trail does not carry the amount', async () => {
    await request(server())
      .put('/hrms/payroll/compensation')
      .set(auth(hoT))
      .send({ userId: 'u_pay_rep', basis: 'monthly', amount: 30_000, paidLeavePerMonth: 1 })
      .expect(200);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'hrms.compensation_set' },
    });
    expect(audit).toBeTruthy();
    // An audit list is read by people not entitled to everybody's salary.
    expect(JSON.stringify(audit)).not.toContain('30000');
  });

  it('a colleague cannot read somebody else’s pay', async () => {
    await request(server())
      .get('/hrms/payroll/compensation/u_pay_rep')
      .set(auth(rep2T))
      .expect(403);

    const own = await request(server())
      .get('/hrms/payroll/compensation/u_pay_rep')
      .set(auth(repT))
      .expect(200);
    expect(own.body.amount).toBe(30_000);
  });

  it('a store manager cannot read pay or write weekly offs across store scope', async () => {
    const otherStore = 'store_pay_other';
    const otherUser = 'u_pay_other';
    await prisma.store.create({
      data: {
        id: otherStore,
        name: 'Other Branch',
        city: 'Pune',
        organisationId: A.org,
        timezone: 'Asia/Kolkata',
      },
    });
    await prisma.user.create({
      data: {
        id: otherUser,
        email: 'other.pay@pay-a.local',
        name: 'Other Branch Rep',
        role: 'salesperson',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        isActive: true,
        approvalStatus: 'approved',
        organisationId: A.org,
        userStores: { create: { storeId: otherStore, isPrimary: true } },
      },
    });
    await prisma.staffCompensation.create({
      data: {
        organisationId: A.org,
        userId: otherUser,
        basis: 'monthly',
        amount: 25_000,
      },
    });

    await request(server())
      .get(`/hrms/payroll/compensation/${otherUser}`)
      .set(auth(mgrT))
      .expect(404);
    await request(server())
      .put('/hrms/payroll/week-offs')
      .set(auth(mgrT))
      .send({ userId: otherUser, storeId: A.store, days: [2] })
      .expect(400);
    expect(await prisma.staffWeekOff.count({ where: { userId: otherUser } })).toBe(0);
  });

  // ==========================================================================
  // 3. The payslip
  // ==========================================================================

  it('refuses to generate for somebody whose pay nobody recorded', async () => {
    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep2', periodKey: PERIOD })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/No pay is recorded/i);
  });

  it('a full month present pays the full salary', async () => {
    await fullMonth('u_pay_rep');

    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(201);

    expect(res.body.calendarDays).toBe(30);
    expect(res.body.presentDays).toBe(30);
    expect(res.body.unpaidDays).toBe(0);
    expect(res.body.perDayRate).toBe(1000);
    expect(res.body.netPay).toBe(30_000);
    expect(res.body.status).toBe('draft');
    // Said on every slip, so "net pay" is never read as take-home.
    expect(res.body.note).toMatch(/before tax/i);
  });

  it('an absence costs exactly one day; a half day costs half', async () => {
    await prisma.attendanceRecord.deleteMany({
      where: { staffId: 'u_pay_rep', date: { in: [SEPT(10), SEPT(11)] } },
    });
    await mark('u_pay_rep', 10, 'absent');
    await mark('u_pay_rep', 11, 'half_day', { dayFraction: 0.5 });

    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(201);

    expect(res.body.presentDays).toBe(28.5);
    expect(res.body.unpaidDays).toBe(1.5);
    // 30,000 − 1.5 × 1,000.
    expect(res.body.netPay).toBe(28_500);
  });

  it('weekly offs and holidays are paid on a monthly salary', async () => {
    // Two Sundays replaced by week_off rows, and a declared holiday.
    await prisma.attendanceRecord.deleteMany({
      where: { staffId: 'u_pay_rep', date: { in: [SEPT(6), SEPT(13), SEPT(20)] } },
    });
    await mark('u_pay_rep', 6, 'week_off');
    await mark('u_pay_rep', 13, 'week_off');
    await mark('u_pay_rep', 20, 'holiday');

    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(201);

    expect(res.body.weeklyOffDays).toBe(2);
    expect(res.body.holidayDays).toBe(1);
    expect(res.body.presentDays).toBe(25.5);
    // The three non-working days cost nothing: still only the absence and the
    // half day.
    expect(res.body.unpaidDays).toBe(1.5);
    expect(res.body.netPay).toBe(28_500);
  });

  it('approved leave inside the allowance is free; beyond it is not', async () => {
    await prisma.attendanceRecord.deleteMany({
      where: { staffId: 'u_pay_rep', date: { in: [SEPT(15), SEPT(16)] } },
    });
    await mark('u_pay_rep', 15, 'on_leave');
    await mark('u_pay_rep', 16, 'on_leave');

    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(201);

    expect(res.body.paidLeaveDays).toBe(2);
    // One day of leave is allowed; the second is unpaid. 1.5 + 1.
    expect(res.body.unpaidDays).toBe(2.5);
    expect(res.body.netPay).toBe(27_500);
  });

  it('a day the register says nothing about is not quietly paid', async () => {
    await prisma.attendanceRecord.deleteMany({
      where: { staffId: 'u_pay_rep', date: SEPT(25) },
    });

    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(201);
    expect(res.body.unpaidDays).toBe(3.5);

    const detail = await request(server())
      .get(`/hrms/payroll/payslips/${res.body.id}`)
      .set(auth(mgrT))
      .expect(200);
    const day25 = detail.body.breakdown.find((d: { date: string }) => d.date === '2026-09-25');
    // Marked distinctly from `absent`: "they did not come" and "the register says
    // nothing" are different conversations with a payroll clerk.
    expect(day25.kind).toBe('no_record');
    expect(day25.paid).toBe(false);
  });

  it('overtime is unpaid unless a rate was set', async () => {
    await prisma.attendanceRecord.deleteMany({ where: { staffId: 'u_pay_rep', date: SEPT(26) } });
    await mark('u_pay_rep', 26, 'present', { dayFraction: 1, overtimeMins: 120 });

    const without = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(201);
    expect(without.body.overtimeMins).toBe(120);
    // Recorded, not paid. Paying it by accident is worse than the conversation
    // about whether to.
    expect(without.body.overtimeAmount).toBe(0);

    await request(server())
      .put('/hrms/payroll/compensation')
      .set(auth(hoT))
      .send({
        userId: 'u_pay_rep',
        basis: 'monthly',
        amount: 30_000,
        paidLeavePerMonth: 1,
        overtimeHourlyRate: 200,
      })
      .expect(200);

    const withRate = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(201);
    expect(withRate.body.overtimeAmount).toBe(400);
    expect(withRate.body.netPay).toBe(withRate.body.earnedAmount + 400);
  });

  it('a daily wage does NOT pay the offs and holidays', async () => {
    await request(server())
      .put('/hrms/payroll/compensation')
      .set(auth(hoT))
      .send({ userId: 'u_pay_rep2', basis: 'daily', amount: 1_000 })
      .expect(200);

    // Twenty days worked, two week offs, the rest nothing.
    for (let d = 1; d <= 20; d++) await mark('u_pay_rep2', d, 'present', { dayFraction: 1 });
    await mark('u_pay_rep2', 21, 'week_off');
    await mark('u_pay_rep2', 22, 'holiday');

    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep2', periodKey: PERIOD })
      .expect(201);

    expect(res.body.basis).toBe('daily');
    expect(res.body.presentDays).toBe(20);
    // Twenty days worked at 1,000. The off day and the holiday are not paid —
    // which is the entire difference between the two bases.
    expect(res.body.netPay).toBe(20_000);
    expect(res.body.deductionAmount).toBe(0);
  });

  it('a whole branch at once, naming whoever it could not do', async () => {
    const res = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ storeId: A.store, periodKey: PERIOD })
      .expect(201);

    expect(res.body.generated).toBe(2);
    // The manager has no pay recorded. Named, not merely counted.
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].name).toBe('u_pay_mgr');
    expect(res.body.skipped[0].reason).toMatch(/No pay is recorded/i);
  });

  it('an issued payslip does not move, however the roster changes afterwards', async () => {
    const list = await request(server())
      .get(`/hrms/payroll/payslips?periodKey=${PERIOD}&userId=u_pay_rep`)
      .set(auth(mgrT))
      .expect(200);
    const slip = list.body[0];
    const netBefore = slip.netPay;

    const issued = await request(server())
      .post(`/hrms/payroll/payslips/${slip.id}/issue`)
      .set(auth(mgrT))
      .expect(201);
    expect(issued.body.status).toBe('issued');
    expect(issued.body.issuedAt).toBeTruthy();

    // Somebody corrects the register a week later.
    await mark('u_pay_rep', 25, 'present', { dayFraction: 1 });

    // Regenerating is refused. The number the employee was shown is the number.
    const again = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: PERIOD })
      .expect(400);
    expect(JSON.stringify(again.body)).toMatch(/already been issued/i);

    const after = await request(server())
      .get(`/hrms/payroll/payslips/${slip.id}`)
      .set(auth(mgrT))
      .expect(200);
    expect(after.body.netPay).toBe(netBefore);
  });

  it('issuing twice is harmless', async () => {
    const list = await request(server())
      .get(`/hrms/payroll/payslips?periodKey=${PERIOD}&userId=u_pay_rep`)
      .set(auth(mgrT))
      .expect(200);
    const res = await request(server())
      .post(`/hrms/payroll/payslips/${list.body[0].id}/issue`)
      .set(auth(mgrT))
      .expect(201);
    expect(res.body.status).toBe('issued');
  });

  it('an employee sees their own slips and nobody else’s', async () => {
    const mine = await request(server())
      .get('/hrms/payroll/payslips')
      .set(auth(repT))
      .expect(200);
    expect(mine.body.length).toBeGreaterThan(0);
    expect(mine.body.every((s: { userId: string }) => s.userId === 'u_pay_rep')).toBe(true);

    await request(server())
      .get('/hrms/payroll/payslips?userId=u_pay_rep')
      .set(auth(rep2T))
      .expect(403);
  });

  it('a period that is not a month is refused', async () => {
    await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: 'September' })
      .expect(400);
    await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(mgrT))
      .send({ userId: 'u_pay_rep', periodKey: '2026-13' })
      .expect(400);
  });

  it('February knows how long it is', async () => {
    await request(server())
      .put('/hrms/payroll/compensation')
      .set(auth(hoT))
      .send({ userId: 'u_pay_mgr', basis: 'monthly', amount: 28_000 })
      .expect(200);

    // 2028 is a leap year.
    const leap = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(hoT))
      .send({ userId: 'u_pay_mgr', periodKey: '2028-02' })
      .expect(201);
    expect(leap.body.calendarDays).toBe(29);

    const ordinary = await request(server())
      .post('/hrms/payroll/payslips/generate')
      .set(auth(hoT))
      .send({ userId: 'u_pay_mgr', periodKey: '2027-02' })
      .expect(201);
    expect(ordinary.body.calendarDays).toBe(28);
    // The day rate is the MONTH's, so a short month's absence costs slightly
    // more per day — which is how a monthly salary actually works.
    expect(ordinary.body.perDayRate).toBe(1000);
  });
});
