import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The roster grid and the employee's own schedule.
 *
 *  1. THE WEEKLY OFF MOVES. "Monday off this week, Friday the next" is the
 *     client's central requirement (9 Oct) and it is expressed as dated rows:
 *     a week that has any of them is governed by them, and the weekday pattern
 *     is silent for that week. The grid must say exactly that, or the manager
 *     plans against a calendar the register will not honour.
 *
 *  2. APPROVED AND PENDING LEAVE ARE NOT THE SAME THING. A grid that showed
 *     them alike would have managers rostering around a request nobody has
 *     approved — and refusing to roster a day the person is still expected on.
 *
 *  3. ONE CALL FILLS THE GRID. A week of a branch is 7 x headcount cells; the
 *     screen gets them in a single request, scope-filtered to the caller's
 *     branches.
 *
 *  4. AN EMPLOYEE MAY SEE THEIR OWN WEEK, AND NOBODY ELSE'S. The roster
 *     endpoints are manager-and-above, which left a salesperson unable to read
 *     their own offs anywhere.
 *
 *  5. A LOCKED MONTH IS LOCKED FOR PLANNING TOO. Payroll has been run from
 *     those offs; moving one afterwards would make the payslip unexplainable.
 */

const PASSWORD = 'password123';
const TZ = 'Asia/Kolkata';

const A = {
  org: 'org_roster_a',
  slug: 'roster-a',
  s1: 'store_roster_a1',
  s2: 'store_roster_a2',
};

const U = {
  ho: 'u_roster_ho',
  mgr: 'u_roster_mgr',
  rep: 'u_roster_rep',
  rep2: 'u_roster_rep2',
  // At the second branch only: the manager of branch one must never see them.
  rep3: 'u_roster_rep3',
};

const EMAIL: Record<string, string> = {
  [U.ho]: 'ho.roster@roster-a.local',
  [U.mgr]: 'mgr.roster@roster-a.local',
  [U.rep]: 'rep.roster@roster-a.local',
  [U.rep2]: 'rep2.roster@roster-a.local',
  [U.rep3]: 'rep3.roster@roster-a.local',
};

/**
 * November 2026. The 1st is a Sunday, so the Monday-based weeks inside the
 * month start clean: 2-8 and 9-15.
 */
const MONTH = '2026-11';
const FROM = '2026-11-02'; // Monday
const TO = '2026-11-15'; // Sunday, two full weeks later
const MONDAY_OFF = '2026-11-02';
const FRIDAY_OFF = '2026-11-13';
const SUNDAY_W1 = '2026-11-08';
const SUNDAY_W2 = '2026-11-15';
const HOLIDAY = '2026-11-11';
const ymd = (d: string) => new Date(`${d}T00:00:00.000Z`);

type Day = {
  date: string;
  weekday: number;
  employed: boolean;
  shift: { id: string; name: string; startTime: string; endTime: string } | null;
  shiftSource: string | null;
  isOff: boolean;
  offSource: string | null;
  isHoliday: boolean;
  holidayLabel: string | null;
  leave: { id: string; type: string; status: string; halfDay: boolean } | null;
  conflict: string | null;
};
type Employee = { userId: string; storeId: string; name: string; days: Day[]; weekOffDays: number[]; followsStore: boolean };

async function teardown(prisma: PrismaService) {
  const users = Object.values(U);
  await prisma.payrollPeriodLock.deleteMany({ where: { organisationId: A.org } });
  await prisma.shiftAssignment.deleteMany({ where: { organisationId: A.org } });
  await prisma.staffDayOff.deleteMany({ where: { organisationId: A.org } });
  await prisma.staffWeekOff.deleteMany({ where: { organisationId: A.org } });
  await prisma.leaveRequest.deleteMany({ where: { organisationId: A.org } });
  await prisma.storeHoliday.deleteMany({ where: { organisationId: A.org } });
  await prisma.shift.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.notification.deleteMany({ where: { userId: { in: users } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Roster grid and my schedule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const token: Record<string, string> = {};
  let shiftId: string;

  const server = () => app.getHttpServer();
  const auth = (id: string) => ({ Authorization: `Bearer ${token[id]}` });

  const rosterFor = async (as: string, query = `from=${FROM}&to=${TO}`) =>
    (await request(server()).get(`/hrms/roster?${query}`).set(auth(as)).expect(200)).body;

  const rowOf = (body: { employees: Employee[] }, userId: string, storeId = A.s1) =>
    body.employees.find((e) => e.userId === userId && e.storeId === storeId)!;

  const dayOf = (row: Employee, date: string) => row.days.find((d) => d.date === date)!;

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
      data: { id: A.org, name: 'Roster A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    for (const [id, name] of [
      [A.s1, 'Bandra'],
      [A.s2, 'Colaba'],
    ] as const) {
      await prisma.store.create({
        data: {
          id,
          name,
          city: 'Mumbai',
          organisationId: A.org,
          timezone: TZ,
          // The branch closes on Sundays: the fallback for anybody unrostered.
          weekOffDay: 0,
        },
      });
    }
    for (const [id, role, storeId] of [
      [U.ho, 'head_office', A.s1],
      [U.mgr, 'store_manager', A.s1],
      [U.rep, 'salesperson', A.s1],
      [U.rep2, 'salesperson', A.s1],
      [U.rep3, 'salesperson', A.s2],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email: EMAIL[id],
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
    const shift = await prisma.shift.create({
      data: {
        organisationId: A.org,
        storeId: A.s1,
        name: 'Morning',
        startTime: '10:00',
        endTime: '19:00',
      },
    });
    shiftId = shift.id;
    await prisma.storeHoliday.create({
      data: { organisationId: A.org, storeId: A.s1, date: ymd(HOLIDAY), label: 'Diwali' },
    });

    const login = async (id: string) =>
      (
        await request(server())
          .post('/auth/login')
          .send({ email: EMAIL[id], password: PASSWORD })
          .expect(201)
      ).body.token;
    for (const id of [U.ho, U.mgr, U.rep, U.rep2, U.rep3]) token[id] = await login(id);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. The dated roster, as the grid reports it
  // ==========================================================================

  it('a dated Monday off and the next week a dated Friday off are exactly the offs', async () => {
    // The manager plans the two weeks: Monday in the first, Friday in the second.
    await request(server())
      .put('/hrms/payroll/day-offs')
      .set(auth(U.mgr))
      .send({
        storeId: A.s1,
        month: MONTH,
        entries: [{ userId: U.rep, dates: [MONDAY_OFF, FRIDAY_OFF] }],
      })
      .expect(200);

    const body = await rosterFor(U.mgr);
    expect(body.from).toBe(FROM);
    expect(body.to).toBe(TO);
    expect(body.dates).toHaveLength(14);

    const rep = rowOf(body, U.rep);
    expect(rep.days).toHaveLength(14);
    expect(rep.days.filter((d) => d.isOff).map((d) => d.date)).toEqual([MONDAY_OFF, FRIDAY_OFF]);
    expect(dayOf(rep, MONDAY_OFF).offSource).toBe('dated');
    expect(dayOf(rep, FRIDAY_OFF).offSource).toBe('dated');
    // Both weeks are planned, so the branch's Sunday is silent in both - this
    // is the whole point of a dated roster.
    expect(dayOf(rep, SUNDAY_W1).isOff).toBe(false);
    expect(dayOf(rep, SUNDAY_W2).isOff).toBe(false);
  });

  it('an unplanned colleague still follows the branch pattern', async () => {
    const rep2 = rowOf(await rosterFor(U.mgr), U.rep2);
    expect(rep2.followsStore).toBe(true);
    expect(rep2.weekOffDays).toEqual([0]);
    expect(rep2.days.filter((d) => d.isOff).map((d) => d.date)).toEqual([SUNDAY_W1, SUNDAY_W2]);
    expect(dayOf(rep2, SUNDAY_W1).offSource).toBe('pattern');
  });

  it('the branch holiday rides on the cell and on the envelope', async () => {
    const body = await rosterFor(U.mgr);
    expect(body.holidays).toEqual([
      expect.objectContaining({ storeId: A.s1, date: HOLIDAY, label: 'Diwali' }),
    ]);
    expect(dayOf(rowOf(body, U.rep), HOLIDAY).isHoliday).toBe(true);
    expect(dayOf(rowOf(body, U.rep), HOLIDAY).holidayLabel).toBe('Diwali');
    expect(dayOf(rowOf(body, U.rep), FRIDAY_OFF).isHoliday).toBe(false);
  });

  // ==========================================================================
  // 2. Shifts resolved for the date, and the conflict signal
  // ==========================================================================

  it('the assigned shift is resolved per date; an unassigned colleague shows the branch default', async () => {
    await request(server())
      .post('/hrms/shift-assignments')
      .set(auth(U.mgr))
      .send({ userId: U.rep, shiftId, effectiveFrom: '2026-11-10' })
      .expect(201);

    const body = await rosterFor(U.mgr);
    const rep = rowOf(body, U.rep);
    // Before the assignment starts there is nothing planned, so the cell shows
    // the shift the register would nonetheless time them against.
    expect(dayOf(rep, '2026-11-09').shiftSource).toBe('store_default');
    expect(dayOf(rep, '2026-11-10').shiftSource).toBe('assignment');
    expect(dayOf(rep, '2026-11-10').shift).toEqual(
      expect.objectContaining({ id: shiftId, name: 'Morning', startTime: '10:00', endTime: '19:00' }),
    );
    expect(dayOf(rowOf(body, U.rep2), '2026-11-10').shiftSource).toBe('store_default');
  });

  it('approved and pending leave are distinguishable, and only approved collides with a shift', async () => {
    const leave = async (staffId: string, date: string, status: 'approved' | 'pending') =>
      prisma.leaveRequest.create({
        data: {
          organisationId: A.org,
          storeId: A.s1,
          staffId,
          type: 'casual',
          status,
          fromDate: ymd(date),
          toDate: ymd(date),
        },
      });
    // The rep is rostered on the Morning shift from the 10th and approved away
    // on the 12th: the cell a manager has to look at.
    await leave(U.rep, '2026-11-12', 'approved');
    await leave(U.rep, '2026-11-11', 'pending');
    // The rep2 is approved away too, but nobody assigned them a shift.
    await leave(U.rep2, '2026-11-12', 'approved');

    const body = await rosterFor(U.mgr);
    const rep = rowOf(body, U.rep);
    expect(dayOf(rep, '2026-11-12').leave).toEqual(
      expect.objectContaining({ status: 'approved', type: 'casual', halfDay: false }),
    );
    expect(dayOf(rep, '2026-11-11').leave).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(dayOf(rep, '2026-11-12').conflict).toBe('shift_on_approved_leave');
    // A pending application is not time off yet: nothing collides with it.
    expect(dayOf(rep, '2026-11-11').conflict).toBeNull();
    // No assignment, no plan to collide with - the branch default is not a plan.
    expect(dayOf(rowOf(body, U.rep2), '2026-11-12').conflict).toBeNull();
    expect(dayOf(rowOf(body, U.rep2), '2026-11-12').leave).toEqual(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  // ==========================================================================
  // 3. Scope and the self variant
  // ==========================================================================

  it("a manager's grid stops at their own branches; head office sees both", async () => {
    const mine = await rosterFor(U.mgr);
    expect(mine.employees.map((e: Employee) => e.userId)).not.toContain(U.rep3);
    expect(mine.stores.map((s: { id: string }) => s.id)).toEqual([A.s1]);

    const all = await rosterFor(U.ho);
    expect(all.employees.map((e: Employee) => e.userId)).toContain(U.rep3);
    // Asking for a branch outside the caller's scope is refused, not silently widened.
    await request(server())
      .get(`/hrms/roster?from=${FROM}&to=${TO}&storeId=${A.s2}`)
      .set(auth(U.mgr))
      .expect(403);
  });

  it('a salesperson cannot read the branch roster, but can read their own schedule', async () => {
    await request(server())
      .get(`/hrms/roster?from=${FROM}&to=${TO}`)
      .set(auth(U.rep))
      .expect(403);

    const mine = (
      await request(server())
        .get(`/hrms/schedule/me?from=${FROM}&to=${TO}`)
        .set(auth(U.rep))
        .expect(200)
    ).body;
    expect(mine.employees.map((e: Employee) => e.userId)).toEqual([U.rep]);
    const rep = rowOf(mine, U.rep);
    // The same per-date shape the manager's grid returns.
    expect(rep.days.filter((d) => d.isOff).map((d) => d.date)).toEqual([MONDAY_OFF, FRIDAY_OFF]);
    expect(dayOf(rep, '2026-11-10').shiftSource).toBe('assignment');
    expect(dayOf(rep, HOLIDAY).isHoliday).toBe(true);
    expect(dayOf(rep, '2026-11-12').leave).toEqual(expect.objectContaining({ status: 'approved' }));

    // A colleague's schedule is not reachable from here at all.
    const theirs = (
      await request(server())
        .get(`/hrms/schedule/me?from=${FROM}&to=${TO}`)
        .set(auth(U.rep2))
        .expect(200)
    ).body;
    expect(theirs.employees.map((e: Employee) => e.userId)).toEqual([U.rep2]);
  });

  it('the span is bounded and ordered', async () => {
    await request(server())
      .get(`/hrms/roster?from=${TO}&to=${FROM}`)
      .set(auth(U.mgr))
      .expect(400);
    await request(server())
      .get('/hrms/roster?from=2026-11-01&to=2026-12-15')
      .set(auth(U.mgr))
      .expect(400);
    await request(server())
      .get('/hrms/roster?from=November&to=2026-11-15')
      .set(auth(U.mgr))
      .expect(400);
    await request(server())
      .get(`/hrms/schedule/me?from=${FROM}`)
      .set(auth(U.rep))
      .expect(400);
  });

  // ==========================================================================
  // 4. The payroll lock governs planning too
  // ==========================================================================

  it('a locked month refuses a roster write', async () => {
    await request(server())
      .post('/hrms/payroll-locks')
      .set(auth(U.ho))
      .send({ month: MONTH })
      .expect(201);

    await request(server())
      .put('/hrms/payroll/day-offs')
      .set(auth(U.mgr))
      .send({ storeId: A.s1, month: MONTH, entries: [{ userId: U.rep, dates: ['2026-11-04'] }] })
      .expect(409);
    await request(server())
      .post('/hrms/shift-assignments')
      .set(auth(U.mgr))
      .send({ userId: U.rep2, shiftId, effectiveFrom: '2026-11-20' })
      .expect(409);

    // The plan is unchanged, and the grid still reads.
    const rep = rowOf(await rosterFor(U.mgr), U.rep);
    expect(rep.days.filter((d) => d.isOff).map((d) => d.date)).toEqual([MONDAY_OFF, FRIDAY_OFF]);
  });

  it('a manager plans nobody at their own rank', async () => {
    await request(server())
      .post(`/hrms/payroll-locks/${MONTH}/reopen`)
      .set(auth(U.ho))
      .send({ reason: 'roster test' })
      .expect(201);

    await request(server())
      .put('/hrms/payroll/day-offs')
      .set(auth(U.mgr))
      .send({ storeId: A.s1, month: MONTH, entries: [{ userId: U.mgr, dates: ['2026-11-04'] }] })
      .expect(403);
    await request(server())
      .post('/hrms/shift-assignments')
      .set(auth(U.mgr))
      .send({ userId: U.mgr, shiftId, effectiveFrom: '2026-11-20' })
      .expect(403);
  });

  it('one person cannot hold two assignments over the same dates', async () => {
    const evening = await prisma.shift.create({
      data: {
        organisationId: A.org,
        storeId: A.s1,
        name: 'Evening',
        startTime: '14:00',
        endTime: '23:00',
      },
    });
    // The second assignment closes the first the day before it starts.
    await request(server())
      .post('/hrms/shift-assignments')
      .set(auth(U.mgr))
      .send({ userId: U.rep2, shiftId, effectiveFrom: '2026-11-02' })
      .expect(201);
    await request(server())
      .post('/hrms/shift-assignments')
      .set(auth(U.mgr))
      .send({ userId: U.rep2, shiftId: evening.id, effectiveFrom: '2026-11-20' })
      .expect(201);

    const rows = (
      await request(server())
        .get(`/hrms/shift-assignments?userId=${U.rep2}`)
        .set(auth(U.mgr))
        .expect(200)
    ).body as { id: string; shiftId: string; effectiveFrom: string; effectiveTo: string | null }[];
    const morning = rows.find((r) => r.shiftId === shiftId)!;
    expect(morning.effectiveTo).toBe('2026-11-19');

    // Re-opening its end over the Evening row would put the person on two
    // shifts at once, and the register could not say which one they were late for.
    await request(server())
      .patch(`/hrms/shift-assignments/${morning.id}`)
      .set(auth(U.mgr))
      .send({ effectiveTo: '2026-11-25' })
      .expect(409);

    // The grid switches shift on the effective date, from the one fetch.
    const week = rowOf(await rosterFor(U.mgr, 'from=2026-11-16&to=2026-11-22'), U.rep2);
    expect(dayOf(week, '2026-11-19').shift!.name).toBe('Morning');
    expect(dayOf(week, '2026-11-20').shift!.name).toBe('Evening');
    expect(dayOf(week, '2026-11-20').shiftSource).toBe('assignment');
  });
});
