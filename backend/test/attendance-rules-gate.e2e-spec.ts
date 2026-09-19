import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * No automatic absence on rules nobody has confirmed, and an attendance-only
 * Head Office.
 *
 *  1. "No weekly off", "no holidays" and a 15-minute grace are all valid
 *     settings, so an unconfigured location looks exactly like a configured
 *     one. Until HR confirms a location's rules through a date, an unpunched
 *     day there stays "not marked" — the day close and processing runs never
 *     turn it into "absent".
 *  2. Only head office confirms; not without a shift, not years ahead.
 *  3. A Head Office location takes attendance only: no footfall, targets or
 *     DSR, and it is never a row in a store KPI.
 */

const PASSWORD = 'password123';
const A = {
  org: 'org_gate',
  slug: 'gate',
  store: 'store_gate_a',
  hoLoc: 'store_gate_ho',
  ho: 'ho@gate.local',
  mgr: 'mgr@gate.local',
};
const D = '2026-09-02';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function teardown(prisma: PrismaService) {
  await prisma.attendanceProcessingRun.deleteMany({ where: { organisationId: A.org } });
  await prisma.salesTarget.deleteMany({ where: { store: { organisationId: A.org } } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.rawPunchEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.shift.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Attendance rules gate and attendance-only locations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoT: string;
  let mgrT: string;
  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const rowsOn = (date: string) => prisma.attendanceRecord.findMany({ where: { storeId: A.store, date: day(date) } });
  const close = (date: string) =>
    request(server()).post('/hrms/attendance/day-close').set(auth(hoT)).send({ storeId: A.store, date }).expect(201);

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'Gate', slug: A.slug, industryPackCode: 'jewellery' } });
    await prisma.store.create({
      data: {
        id: A.store, name: 'Bandra', city: 'Mumbai', organisationId: A.org,
        shifts: { create: { organisationId: A.org, name: 'Day', startTime: '10:00', endTime: '19:00' } },
      },
    });
    await prisma.store.create({
      data: { id: A.hoLoc, name: 'Head Office', city: 'Mumbai', organisationId: A.org, attendanceOnly: true, geofenceRadiusM: null },
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [id, email, role, store] of [
      ['u_gate_ho', A.ho, 'head_office', A.store],
      ['u_gate_mgr', A.mgr, 'store_manager', A.store],
      ['u_gate_rep', 'rep@gate.local', 'salesperson', A.store],
      ['u_gate_off', 'off@gate.local', 'salesperson', A.hoLoc],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email, name: id, role, passwordHash: hash, isActive: true, approvalStatus: 'approved',
          organisationId: A.org, userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('an unconfirmed location closes a day without inventing an absence', async () => {
    const res = await close(D);
    expect(res.body).toMatchObject({ markedAbsent: 0, markedNonWorking: 0 });
    expect(res.body.notMarked).toBeGreaterThan(0);
    expect(res.body.ruleGaps).toEqual(['weekly offs, holidays and grace minutes not confirmed']);
    expect(await rowsOn(D)).toHaveLength(0);
  });

  it('the rules status shows what is configured and why absence is off', async () => {
    const res = await request(server()).get('/hrms/attendance/rules').set(auth(hoT)).expect(200);
    const a = res.body.find((s: { storeId: string }) => s.storeId === A.store);
    const ho = res.body.find((s: { storeId: string }) => s.storeId === A.hoLoc);
    expect(a).toMatchObject({
      attendanceOnly: false,
      automaticAbsence: false,
      confirmedThrough: null,
      weekOffDay: null,
      holidays: 0,
      shifts: [{ name: 'Day', graceMins: 15 }],
    });
    expect(ho).toMatchObject({ attendanceOnly: true, geofence: 'unverified', automaticAbsence: false });
    expect(ho.gaps).toContain('no shift set up');
  });

  it('only head office confirms — not without a shift, not years ahead', async () => {
    const confirm = (t: string, body: object) => request(server()).post('/hrms/attendance/rules/confirm').set(auth(t)).send(body);
    await confirm(mgrT, { storeId: A.store, through: D }).expect(403);
    await confirm(hoT, { storeId: A.hoLoc, through: D }).expect(400);
    const far = new Date(Date.now() + 3 * 365 * 86_400_000).toISOString().slice(0, 10);
    await confirm(hoT, { storeId: A.store, through: far }).expect(400);
    expect((await prisma.store.findUniqueOrThrow({ where: { id: A.store } })).attendanceRulesConfirmedThrough).toBeNull();
  });

  it('once confirmed, the day closes as absent — but only through the confirmed date', async () => {
    await request(server()).post('/hrms/attendance/rules/confirm').set(auth(hoT)).send({ storeId: A.store, through: D }).expect(201);
    expect(await prisma.auditLog.count({ where: { organisationId: A.org, action: 'attendance.rules_confirm' } })).toBe(1);

    const res = await close(D);
    expect(res.body.ruleGaps).toEqual([]);
    const rep = (await rowsOn(D)).find((r) => r.staffId === 'u_gate_rep');
    expect(rep).toMatchObject({ status: 'absent', source: 'auto' });

    const next = await close('2026-09-03');
    expect(next.body.ruleGaps).toEqual([`rules confirmed only through ${D}`]);
    expect(await rowsOn('2026-09-03')).toHaveLength(0);
  });

  it('withdrawing it withdraws the app’s own absences on the next run, never a human’s', async () => {
    await prisma.attendanceRecord.updateMany({
      where: { storeId: A.store, date: day(D), staffId: 'u_gate_mgr' },
      data: { source: 'manager' },
    });
    await request(server()).post('/hrms/attendance/rules/confirm').set(auth(hoT)).send({ storeId: A.store, through: null }).expect(201);
    await request(server()).post('/hrms/processing-runs').set(auth(hoT)).send({ from: D, to: D, storeId: A.store }).expect(201);

    const rows = await rowsOn(D);
    expect(rows.find((r) => r.staffId === 'u_gate_rep')).toBeUndefined();
    expect(rows.find((r) => r.staffId === 'u_gate_mgr')).toMatchObject({ status: 'absent', source: 'manager' });
  });

  it('Head Office takes attendance only: no targets, footfall or DSR, and no KPI row', async () => {
    await request(server())
      .post('/targets')
      .set(auth(hoT))
      .send({ storeId: A.hoLoc, period: '2026-09', amount: 100000 })
      .expect(400);
    await expect(app.get((await import('../src/common/store-scope.service')).StoreScopeService).assertTradingStore(A.hoLoc))
      .rejects.toThrow('attendance-only');
    await request(server()).post('/targets').set(auth(hoT)).send({ storeId: A.store, period: '2026-09', amount: 100000 }).expect(201);

    const ach = await request(server()).get('/targets/achievement?period=2026-09').set(auth(hoT)).expect(200);
    const ids = ach.body.items.map((i: { storeId: string }) => i.storeId);
    expect(ids).toContain(A.store);
    expect(ids).not.toContain(A.hoLoc);
  });
});
