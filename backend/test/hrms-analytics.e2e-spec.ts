import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Attendance analytics + reports (docs/modules/06-attendance.md, agent C).
 *
 *  1. The overview, the muster and the monthly summary are the same numbers for
 *     the same range — they come from one eligibility + classification pass.
 *  2. Every day of every eligible person is exactly one state.
 *  3. CSV carries the header row.
 *  4. A salesperson is refused; a store manager never sees another store.
 *  5. Sensitive columns are head office only; birthdays lose the year below it.
 */
process.env.SCHEDULER_ENABLED = 'false';

const PASSWORD = 'password123';
const ORG = 'org_han';
const A = 'store_han_a';
const B = 'store_han_b';
const USERS = {
  ho: { id: 'u_han_ho', role: 'head_office', store: A },
  mgrA: { id: 'u_han_mgr_a', role: 'store_manager', store: A },
  mgrB: { id: 'u_han_mgr_b', role: 'store_manager', store: B },
  repA: { id: 'u_han_rep_a', role: 'salesperson', store: A },
  newA: { id: 'u_han_new_a', role: 'salesperson', store: A },
  repB: { id: 'u_han_rep_b', role: 'salesperson', store: B },
} as const;
const email = (id: string) => `${id}@han.local`;
const AUG = (d: number) => new Date(Date.UTC(2026, 7, d));
const RANGE = 'from=2026-08-01&to=2026-08-07';

async function teardown(prisma: PrismaService) {
  await prisma.rawPunchEvent.deleteMany({ where: { organisationId: ORG } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: ORG } });
  await prisma.leaveRequest.deleteMany({ where: { organisationId: ORG } });
  await prisma.storeHoliday.deleteMany({ where: { organisationId: ORG } });
  await prisma.employeeProfile.deleteMany({ where: { organisationId: ORG } });
  await prisma.department.deleteMany({ where: { organisationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}

describe('Attendance analytics + reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const get = (who: keyof typeof USERS, path: string) =>
    request(server()).get(path).set('Authorization', `Bearer ${tokens[who]}`);

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

    await prisma.organisation.create({
      data: { id: ORG, name: 'Analytics', slug: 'han', industryPackCode: 'jewellery' },
    });
    for (const [id, name] of [[A, 'Bandra'], [B, 'Juhu']]) {
      await prisma.store.create({
        data: { id, name, city: 'Mumbai', organisationId: ORG, timezone: 'Asia/Kolkata', weekOffDay: null },
      });
    }
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const u of Object.values(USERS)) {
      await prisma.user.create({
        data: {
          id: u.id,
          email: email(u.id),
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
    const dept = await prisma.department.create({ data: { organisationId: ORG, name: 'HAN Floor', storeId: A } });
    // Joins on the 3rd: not on the roster for the 1st and 2nd.
    await prisma.employeeProfile.create({
      data: {
        organisationId: ORG,
        userId: USERS.newA.id,
        employeeCode: 'HAN002',
        departmentId: dept.id,
        dateOfJoining: AUG(3),
        dateOfBirth: new Date(Date.UTC(1995, 7, 14)),
        bloodGroup: 'O+',
        address: '1 Test Lane',
      },
    });
    await prisma.employeeProfile.create({
      data: { organisationId: ORG, userId: USERS.repA.id, employeeCode: 'HAN001', departmentId: dept.id },
    });

    const rec = (staffId: string, storeId: string, d: number, extra: Record<string, unknown>) =>
      prisma.attendanceRecord.create({
        data: { organisationId: ORG, storeId, staffId, staffName: staffId, date: AUG(d), ...extra } as never,
      });
    const at = (d: number, hhmm: string) => new Date(`2026-08-0${d}T${hhmm}:00+05:30`);
    // repA: present, present+late, absent, half day, on leave, holiday (store), not marked.
    await rec(USERS.repA.id, A, 1, { status: 'present', checkInAt: at(1, '10:00'), checkOutAt: at(1, '19:00'), workedMins: 540, dayFraction: 1 });
    await rec(USERS.repA.id, A, 2, { status: 'present', isLate: true, lateMinutes: 20, checkInAt: at(2, '10:35'), dayFraction: 1 });
    await rec(USERS.repA.id, A, 3, { status: 'absent', dayFraction: 0 });
    await rec(USERS.repA.id, A, 4, { status: 'half_day', checkInAt: at(4, '10:00'), checkOutAt: at(4, '14:00'), workedMins: 240, dayFraction: 0.5 });
    await prisma.leaveRequest.create({
      data: { organisationId: ORG, storeId: A, staffId: USERS.repA.id, type: 'casual', status: 'approved', fromDate: AUG(5), toDate: AUG(5), days: 1 },
    });
    await prisma.storeHoliday.create({ data: { organisationId: ORG, storeId: A, date: AUG(6), label: 'Test' } });
    // newA: absent 3rd and 4th (a 2-day run), present 5th.
    await rec(USERS.newA.id, A, 3, { status: 'absent', dayFraction: 0 });
    await rec(USERS.newA.id, A, 4, { status: 'absent', dayFraction: 0 });
    await rec(USERS.newA.id, A, 5, { status: 'present', checkInAt: at(5, '10:00'), checkOutAt: at(5, '19:30'), workedMins: 570, overtimeMins: 30, dayFraction: 1 });
    // Store B.
    await rec(USERS.repB.id, B, 1, { status: 'present', checkInAt: at(1, '10:00'), dayFraction: 1 });

    for (const [key, u] of Object.entries(USERS)) {
      tokens[key] = (
        await request(server()).post('/auth/login').send({ email: email(u.id), password: PASSWORD }).expect(201)
      ).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('overview, muster and monthly summary reconcile for the same range', async () => {
    const q = `${RANGE}&storeId=${A}`;
    const ov = (await get('ho', `/hrms/analytics/overview?${q}`).expect(200)).body;
    const sum = (await get('ho', `/hrms/reports/monthly-summary?${q}`).expect(200)).body;
    const mus = (await get('ho', `/hrms/reports/muster?${q}`).expect(200)).body;

    const muster = (code: string) => mus.rows.reduce((s: number, r: any) => s + r[`n_${code}`], 0);
    expect(ov.kpis.presentDays).toBe(sum.totals.present);
    expect(ov.kpis.presentDays).toBe(muster('P') + muster('L'));
    expect(ov.kpis.absentDays).toBe(sum.totals.absent);
    expect(ov.kpis.absentDays).toBe(muster('A'));
    expect(ov.kpis.leaveDays).toBe(sum.totals.on_leave);
    expect(ov.kpis.leaveDays).toBe(muster('LV'));
    expect(ov.kpis.halfDays).toBe(sum.totals.half_day);
    expect(ov.kpis.halfDays).toBe(muster('HD'));
    expect(ov.kpis.lateCount).toBe(sum.totals.late);
    expect(ov.kpis.lateCount).toBe(muster('L'));
    expect(ov.kpis.overtimeHours).toBe(sum.totals.overtimeHours);

    // The fixture's known shape (only our two A staff are on A's roster).
    const repA = sum.rows.find((r: any) => r.employeeCode === 'HAN001');
    expect(repA).toMatchObject({ present: 2, late: 1, absent: 1, half_day: 1, on_leave: 1, holiday: 1, not_marked: 1 });
    expect(repA.payableDays).toBe(4.5); // 1 + 1 + 0.5 + leave + holiday; absent and not-marked unpaid
    const newA = sum.rows.find((r: any) => r.employeeCode === 'HAN002');
    // Joined on the 3rd: 5 roster days, never 7.
    expect(newA.present + newA.absent + newA.on_leave + newA.half_day + newA.week_off + newA.holiday + newA.not_marked).toBe(5);
    expect(mus.rows.find((r: any) => r.employeeCode === 'HAN002')['2026-08-01']).toBeUndefined();

    // Every day: the states sum to that day's roster.
    for (const d of ov.trend) {
      const states = d.present + d.half_day + d.absent + d.on_leave + d.week_off + d.holiday + d.not_marked;
      const roster = mus.rows.filter((r: any) => r[d.date] !== undefined).length;
      expect(states).toBe(roster);
    }
    expect(ov.kpis.newJoiners).toBe(1);
  });

  it('constant-absent finds the 2-day run', async () => {
    const r = (await get('mgrA', `/hrms/reports/constant-absent?${RANGE}&minDays=2`).expect(200)).body;
    expect(r.rows).toEqual([expect.objectContaining({ employeeCode: 'HAN002', from: '2026-08-03', to: '2026-08-04', days: 2 })]);
  });

  it('CSV has the header row and is an attachment', async () => {
    const res = await get('mgrA', `/hrms/reports/monthly-summary?${RANGE}&format=csv`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const [header] = res.text.slice(1).split('\r\n');
    expect(header.startsWith('Code,Name,Store,Department,Designation,Present,Late')).toBe(true);
  });

  it('every report kind answers JSON with columns and rows', async () => {
    const kinds = [
      'daily-register', 'muster', 'monthly-summary', 'in-out', 'late-early', 'missed-punch',
      'constant-absent', 'leave-balance', 'leave-register', 'punch-log', 'gps', 'birthdays',
      'hiring', 'separation', 'employee-details',
    ];
    for (const k of kinds) {
      const r = (await get('mgrA', `/hrms/reports/${k}?${RANGE}`).expect(200)).body;
      expect(r.kind).toBe(k);
      expect(Array.isArray(r.columns)).toBe(true);
      expect(Array.isArray(r.rows)).toBe(true);
    }
    await get('mgrA', `/hrms/reports/nope?${RANGE}`).expect(404);
  });

  it('a salesperson is refused', async () => {
    await get('repA', `/hrms/analytics/overview?${RANGE}`).expect(403);
    await get('repA', `/hrms/reports/muster?${RANGE}`).expect(403);
  });

  it("a store manager cannot see another store", async () => {
    await get('mgrA', `/hrms/analytics/overview?${RANGE}&storeId=${B}`).expect(403);
    await get('mgrA', `/hrms/reports/daily-register?${RANGE}&storeId=${B}`).expect(403);
    const ov = (await get('mgrA', `/hrms/analytics/overview?${RANGE}`).expect(200)).body;
    expect(ov.byStore.map((s: any) => s.storeId)).toEqual([A]);
    const reg = (await get('mgrA', `/hrms/reports/daily-register?${RANGE}`).expect(200)).body;
    expect(reg.rows.some((r: any) => r.userId === USERS.repB.id)).toBe(false);
    // Head office sees both.
    const hoOv = (await get('ho', `/hrms/analytics/overview?${RANGE}`).expect(200)).body;
    expect(hoOv.byStore.map((s: any) => s.storeId).sort()).toEqual([A, B]);
  });

  it('sensitive columns are head office only; birthdays lose the year below it', async () => {
    const mgr = (await get('mgrA', `/hrms/reports/employee-details?${RANGE}`).expect(200)).body;
    expect(mgr.columns.map((c: any) => c.key)).not.toEqual(expect.arrayContaining(['address']));
    expect(JSON.stringify(mgr.rows)).not.toContain('1 Test Lane');
    const ho = (await get('ho', `/hrms/reports/employee-details?${RANGE}&storeId=${A}`).expect(200)).body;
    expect(ho.rows.find((r: any) => r.employeeCode === 'HAN002')).toMatchObject({ address: '1 Test Lane', bloodGroup: 'O+' });

    const bm = (await get('mgrA', `/hrms/reports/birthdays?${RANGE}&month=8`).expect(200)).body;
    expect(bm.rows[0].birthday).toBe('14 Aug');
    const bh = (await get('ho', `/hrms/reports/birthdays?${RANGE}&month=8&storeId=${A}`).expect(200)).body;
    expect(bh.rows[0].birthday).toBe('1995-08-14');
  });
});
