import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import {
  AttendanceOpsService,
  attributePunches,
  classifyDay,
  DAY_STATES,
  deriveFromPunches,
  instantFromUnambiguousLocal,
} from '../src/hrms/attendance-ops.service';
import { businessDate, dateOnly, instantFromLocalTime, weekdayInTz } from '../src/common/tz.util';

/**
 * Attendance operations (docs/modules/06-attendance.md, backend agent B).
 *
 *  1. TODAY ADDS UP. Every eligible employee has exactly one primary state and
 *     the seven states sum to the denominator; `late` is counted beside them.
 *     A profiled employee without a login counts; a separated or not-yet-joined
 *     one does not.
 *  2. THE LEDGER IS THE TRUTH. Every write path appends a raw punch; a
 *     correction supersedes (voids) rather than deletes; a processing run gives
 *     the same register as the correction did, and a second run changes nothing.
 *  3. A LOCKED MONTH IS LOCKED — for edits and for processing — until reopened.
 *  4. GEOFENCE P0: a confident fix outside the fence is refused even with a note.
 *  5. FLEXIBLE SHIFTS ARE NEVER LATE; assignments are effective-dated.
 */

const PASSWORD = 'password123';
const TZ = 'Asia/Kolkata';
const MUMBAI = { lat: 19.229, lng: 72.857 };
const A = { org: 'org_ops_b', slug: 'ops-b', s1: 'store_ops_b1', s2: 'store_ops_b2' };

const U = {
  ho: 'u_opsb_ho',
  mgr: 'u_opsb_mgr',
  mgr2: 'u_opsb_mgr2',
  repA: 'u_opsb_a',
  repB: 'u_opsb_b',
  repC: 'u_opsb_c',
  repD: 'u_opsb_d',
  repE: 'u_opsb_e',
  repF: 'u_opsb_f',
  repH: 'u_opsb_h',
  noLogin: 'u_opsb_nologin',
  separated: 'u_opsb_sep',
  future: 'u_opsb_future',
  repG: 'u_opsb_g',
};

const DAY = 86_400_000;
const today = businessDate(new Date(), TZ);
const dayOff = (n: number) => new Date(today.getTime() + n * DAY);
const at = (d: Date, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return instantFromLocalTime(d, h * 60 + m, TZ);
};

async function teardown(prisma: PrismaService) {
  const users = Object.values(U);
  await prisma.rawPunchEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceProcessingRun.deleteMany({ where: { organisationId: A.org } });
  await prisma.payrollPeriodLock.deleteMany({ where: { organisationId: A.org } });
  await prisma.shiftAssignment.deleteMany({ where: { organisationId: A.org } });
  await prisma.employeeProfile.deleteMany({ where: { organisationId: A.org } });
  await prisma.staffWeekOff.deleteMany({ where: { organisationId: A.org } });
  await prisma.notification.deleteMany({ where: { userId: { in: users } } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.payslip.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.attendanceRegularization.deleteMany({ where: { organisationId: A.org } });
  await prisma.leaveRequest.deleteMany({ where: { organisationId: A.org } });
  await prisma.leaveBalance.deleteMany({ where: { userId: { in: users } } });
  await prisma.storeHoliday.deleteMany({ where: { organisationId: A.org } });
  await prisma.shift.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

// ===========================================================================
// Pure rules
// ===========================================================================

describe('attendance-ops pure rules', () => {
  const none = { onLeave: false, isHoliday: false, isWeekOff: false };

  it('resolves store-local operator input and refuses DST gaps or folds', () => {
    expect(
      instantFromUnambiguousLocal('2026-09-10', '09:30', 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-10T04:00:00.000Z');
    expect(() =>
      instantFromUnambiguousLocal('2026-03-08', '02:30', 'America/New_York'),
    ).toThrow(/does not exist/);
    expect(() =>
      instantFromUnambiguousLocal('2026-11-01', '01:30', 'America/New_York'),
    ).toThrow(/ambiguous/);
  });

  it('classifyDay gives exactly one state; late is a modifier of present', () => {
    expect(classifyDay(none, { status: 'late', isLate: true })).toEqual({ state: 'present', isLate: true });
    expect(classifyDay(none, { status: 'present', isLate: false })).toEqual({ state: 'present', isLate: false });
    expect(classifyDay(none, { status: 'half_day', isLate: true })).toEqual({ state: 'half_day', isLate: true });
    // A record wins over the calendar; without one, leave > holiday > week off.
    expect(classifyDay({ onLeave: true, isHoliday: true, isWeekOff: true }, { status: 'present', isLate: false }).state).toBe('present');
    expect(classifyDay({ onLeave: true, isHoliday: true, isWeekOff: true }, null).state).toBe('on_leave');
    expect(classifyDay({ onLeave: false, isHoliday: true, isWeekOff: true }, null).state).toBe('holiday');
    expect(classifyDay({ onLeave: false, isHoliday: false, isWeekOff: true }, null).state).toBe('week_off');
    expect(classifyDay(none, null).state).toBe('not_marked');
    for (const s of ['present', 'late', 'half_day', 'absent', 'on_leave', 'week_off', 'holiday'] as const) {
      expect(DAY_STATES).toContain(classifyDay(none, { status: s, isLate: false }).state);
    }
  });

  it('a night batch out-punch after midnight closes the shift it opened', () => {
    const d = new Date(Date.UTC(2026, 8, 10));
    const p = (id: string, kind: string, when: Date) => ({ id, kind, eventAt: when, source: 'self', voidedAt: null });
    const days = attributePunches(
      [p('1', 'in', at(d, '21:00')), p('2', 'out', instantFromLocalTime(d, 26 * 60, TZ))],
      TZ,
    );
    expect(days.get('2026-09-10')?.outs.map((x) => x.id)).toEqual(['2']);
    expect(days.get('2026-09-11')).toBeUndefined();
  });

  it('a flexible shift never computes lateness or early-out', () => {
    const d = new Date(Date.UTC(2026, 8, 10));
    const day = {
      ins: [{ id: '1', kind: 'in', eventAt: at(d, '13:00'), source: 'self', voidedAt: null }],
      outs: [{ id: '2', kind: 'out', eventAt: at(d, '15:00'), source: 'self', voidedAt: null }],
    };
    const rigid = { startTime: '09:30', endTime: '18:30', bufferMins: 15, fullDayMins: null, halfDayMins: null };
    expect(deriveFromPunches(day, rigid, TZ).isLate).toBe(true);
    expect(deriveFromPunches(day, rigid, TZ).earlyOutMinutes).toBeGreaterThan(0);
    const flex = { ...rigid, startTime: '05:00', endTime: '23:00', isFlexible: true };
    const r = deriveFromPunches(day, flex, TZ);
    expect(r.isLate).toBe(false);
    expect(r.lateMinutes).toBeNull();
    expect(r.earlyOutMinutes).toBeNull();
    // Its 18-hour window is not a length to fill: 2 h worked is a day, not 0.
    expect(r.dayFraction).toBe(1);
  });
});

// ===========================================================================
// Through the API
// ===========================================================================

describe('Attendance operations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let attendanceOps: AttendanceOpsService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const P = dayOff(-2); // a closed past day for register work

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service');
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
    prisma = app.get(PS);
    attendanceOps = app.get(AttendanceOpsService);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'Ops B', slug: A.slug, industryPackCode: 'jewellery' } });
    await prisma.store.createMany({
      data: [
        { id: A.s1, name: 'Bandra', city: 'Mumbai', organisationId: A.org, timezone: TZ, latitude: MUMBAI.lat, longitude: MUMBAI.lng, geofenceRadiusM: 150 },
        { id: A.s2, name: 'Kala Ghoda', city: 'Mumbai', organisationId: A.org, timezone: TZ },
      ],
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mk = async (id: string, role: string, store: string, isActive = true) =>
      prisma.user.create({
        data: {
          id,
          email: `${id}@ops-b.local`,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive,
          approvalStatus: 'approved',
          organisationId: A.org,
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    await mk(U.ho, 'head_office', A.s1);
    await mk(U.mgr, 'store_manager', A.s1);
    await mk(U.mgr2, 'store_manager', A.s1);
    for (const id of [U.repA, U.repB, U.repC, U.repD, U.repE, U.repF, U.repH, U.separated, U.future]) {
      await mk(id, 'salesperson', A.s1);
    }
    await mk(U.noLogin, 'salesperson', A.s1, false);
    await mk(U.repG, 'salesperson', A.s2);

    const profile = (userId: string, code: string, extra: object = {}) =>
      prisma.employeeProfile.create({ data: { organisationId: A.org, userId, employeeCode: code, ...extra } });
    await profile(U.noLogin, 'OPS01', { dateOfJoining: dayOff(-1) });
    await profile(U.separated, 'OPS02', { status: 'separated', exitDate: dayOff(-30) });
    await profile(U.future, 'OPS03', { dateOfJoining: dayOff(1) });
    await profile(U.repE, 'OPS04');

    for (const who of [U.ho, U.mgr, U.mgr2, U.repA, U.repB, U.repE]) {
      t[who] = (await request(server()).post('/auth/login').send({ email: `${who}@ops-b.local`, password: PASSWORD }).expect(201)).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // --- 4. Geofence P0 --------------------------------------------------------

  it('refuses a check-in with a confident fix outside the fence, even with a note', async () => {
    const res = await request(server())
      .post('/hrms/attendance/check-in')
      .set(as(U.repA))
      .send({ lat: MUMBAI.lat + 0.01, lng: MUMBAI.lng, accuracyM: 10, note: 'customer visit' })
      .expect(400);
    expect(res.body.message).toMatch(/must be at the store/);
    expect(await prisma.rawPunchEvent.count({ where: { userId: U.repA } })).toBe(0);
  });

  it('a check-in with no fix still needs a note, and with one it is recorded for review + in the ledger', async () => {
    await request(server()).post('/hrms/attendance/check-in').set(as(U.repA)).send({}).expect(400);
    const res = await request(server())
      .post('/hrms/attendance/check-in')
      .set(as(U.repA))
      .send({ note: 'GPS off indoors' })
      .expect(201);
    expect(res.body.withinFence).toBe(false);
    const punches = await prisma.rawPunchEvent.findMany({ where: { userId: U.repA } });
    expect(punches).toHaveLength(1);
    expect(punches[0]).toMatchObject({ kind: 'in', source: 'self', storeId: A.s1, note: 'GPS off indoors' });
  });

  // --- 1. Today --------------------------------------------------------------

  it('Today: the seven states sum to the denominator; late is counted beside them', async () => {
    const rec = (staffId: string, status: string, extra: object = {}) =>
      prisma.attendanceRecord.create({
        data: { organisationId: A.org, storeId: A.s1, staffId, staffName: staffId, date: today, status: status as never, ...extra },
      });
    await rec(U.repB, 'absent');
    await rec(U.repF, 'half_day');
    await rec(U.repH, 'late', { isLate: true, lateMinutes: 20, checkInAt: new Date() });
    await prisma.leaveRequest.create({
      data: { organisationId: A.org, storeId: A.s1, staffId: U.repC, staffName: U.repC, type: 'casual', status: 'approved', fromDate: today, toDate: today, days: 1 },
    });
    await prisma.staffWeekOff.create({
      data: { organisationId: A.org, userId: U.repD, storeId: A.s1, dayOfWeek: weekdayInTz(instantFromLocalTime(today, 720, TZ), TZ) },
    });
    await prisma.storeHoliday.create({ data: { organisationId: A.org, storeId: A.s2, date: today, label: 'Local' } });

    const res = await request(server()).get('/hrms/attendance/today').set(as(U.ho)).expect(200);
    const body = res.body;
    const { late, ...states } = body.counts;
    // THE INVARIANT. If a state is ever double-counted or dropped, this fails.
    expect(Object.values(states).reduce((a: number, b) => a + (b as number), 0)).toBe(body.denominator);
    expect(body.rows).toHaveLength(body.denominator);
    expect(new Set(body.rows.map((r: { userId: string }) => r.userId)).size).toBe(body.denominator);

    expect(body.counts).toEqual({
      present: 2, // repA (checked in), repH (late)
      late: 1,
      half_day: 1,
      absent: 1,
      on_leave: 1,
      week_off: 1,
      holiday: 1, // repG at the store on holiday
      not_marked: 4, // mgr, mgr2, repE, the profiled employee with no login
    });
    const ids = body.rows.map((r: { userId: string }) => r.userId);
    expect(ids).toContain(U.noLogin); // profile governs, not the login flag
    expect(ids).not.toContain(U.separated);
    expect(ids).not.toContain(U.future);
    expect(ids).not.toContain(U.ho); // head office is not rostered
    expect(body.stores.map((s: { date: string }) => s.date)).toEqual([dateOnly(today), dateOnly(today)]);

    // A salesperson cannot open it.
    await request(server()).get('/hrms/attendance/today').set(as(U.repB)).expect(403);
  });

  // --- 2. Ledger, corrections, processing -------------------------------------

  let shiftG: string;
  let recordE: string;

  it('a manager-added punch builds the day, with lateness from the store shift', async () => {
    shiftG = (
      await request(server())
        .post('/hrms/shifts')
        .set(as(U.mgr))
        .send({ storeId: A.s1, name: 'General', code: 'G', startTime: '09:30', endTime: '18:30', bufferMins: 15 })
        .expect(201)
    ).body.id;
    for (const [kind, when] of [
      ['in', at(P, '10:20')],
      ['out', at(P, '19:30')],
    ] as const) {
      await request(server())
        .post('/hrms/punches')
        .set(as(U.mgr))
        .send({
          userId: U.repE,
          storeId: A.s1,
          kind,
          ...(kind === 'in'
            ? { localDate: dateOnly(P), localTime: '10:20' }
            : { at: when.toISOString() }),
          note: 'device missed it',
        })
        .expect(201);
    }
    await request(server())
      .post('/hrms/punches')
      .set(as(U.mgr))
      .send({
        userId: U.repE,
        storeId: A.s1,
        kind: 'in',
        at: at(P, '10:35').toISOString(),
        localDate: dateOnly(P),
        localTime: '10:35',
        note: 'ambiguous input contract',
      })
      .expect(400);
    const row = await prisma.attendanceRecord.findUniqueOrThrow({
      where: { storeId_staffId_date: { storeId: A.s1, staffId: U.repE, date: P } },
    });
    recordE = row.id;
    expect(row).toMatchObject({ status: 'late', isLate: true, lateMinutes: 35, workedMins: 550, shiftId: shiftG });
    expect(Number(row.dayFraction)).toBe(1);
  });

  it('head office corrects a row: the old punch is voided (kept), a manager punch replaces it, audited', async () => {
    const res = await request(server())
      .patch(`/hrms/attendance/${recordE}`)
      .set(as(U.ho))
      .send({ checkIn: '09:40', note: 'badge log shows 09:40' })
      .expect(200);
    expect(res.body).toMatchObject({ recordId: recordE, status: 'present', isLate: false, checkIn: '09:40', employeeCode: 'OPS04' });

    const ins = await prisma.rawPunchEvent.findMany({ where: { userId: U.repE, kind: 'in' }, orderBy: { receivedAt: 'asc' } });
    expect(ins).toHaveLength(2);
    expect(ins[0].voidedAt).not.toBeNull();
    expect(ins[1]).toMatchObject({ source: 'manager', voidedAt: null });
    expect(ins[1].eventAt.getTime()).toBe(at(P, '09:40').getTime());

    const audit = await prisma.auditLog.findFirst({ where: { organisationId: A.org, action: 'attendance.update', entityId: recordE } });
    expect(audit?.metadata).toMatchObject({ note: 'badge log shows 09:40' });

    await request(server()).patch(`/hrms/attendance/${recordE}`).set(as(U.ho)).send({ checkIn: '09:40' }).expect(400); // note required
    await request(server()).patch(`/hrms/attendance/${recordE}`).set(as(U.repB)).send({ checkIn: '09:40', note: 'x' }).expect(403);
  });

  it('a processing run is reproducible: same punches, same register; the second run changes nothing', async () => {
    // A pre-ledger row: times on the register, nothing in the ledger.
    const legacyDay = dayOff(-3);
    await prisma.attendanceRecord.create({
      data: {
        organisationId: A.org, storeId: A.s1, staffId: U.repB, staffName: U.repB, date: legacyDay, status: 'present',
        checkInAt: at(legacyDay, '09:35'), checkOutAt: at(legacyDay, '18:40'), shiftId: shiftG, source: 'self',
        workedMins: 545, dayFraction: 1, overtimeMins: 5, earlyOutMinutes: 0, lateMinutes: 0,
      },
    });
    const beforeE = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: recordE } });
    const punchesBefore = await prisma.rawPunchEvent.findMany({ where: { organisationId: A.org }, orderBy: { id: 'asc' } });

    const run1 = (
      await request(server())
        .post('/hrms/processing-runs')
        .set(as(U.ho))
        .send({ from: dateOnly(legacyDay), to: dateOnly(P), storeId: A.s1 })
        .expect(201)
    ).body;
    expect(run1.status).toBe('done');
    expect(run1.processed).toBeGreaterThan(0);

    // The corrected day is exactly what the correction produced.
    const afterE = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: recordE } });
    for (const k of ['status', 'isLate', 'lateMinutes', 'workedMins', 'overtimeMins', 'earlyOutMinutes', 'shiftId'] as const) {
      expect(afterE[k]).toEqual(beforeE[k]);
    }
    expect(afterE.checkInAt?.getTime()).toBe(beforeE.checkInAt?.getTime());

    // The legacy row kept its times, and they are now in the ledger.
    const legacy = await prisma.attendanceRecord.findUniqueOrThrow({
      where: { storeId_staffId_date: { storeId: A.s1, staffId: U.repB, date: legacyDay } },
    });
    expect(legacy.checkInAt?.getTime()).toBe(at(legacyDay, '09:35').getTime());
    expect(legacy.status).toBe('present');
    expect(legacy.calculationVersion).toBe('2026-09-18.v1');
    expect(legacy.shiftSnapshot).toMatchObject({
      shiftId: shiftG,
      startTime: '09:30',
      endTime: '18:30',
    });
    expect(await prisma.rawPunchEvent.count({ where: { userId: U.repB, idempotencyKey: { startsWith: 'backfill:' } } })).toBe(2);

    // Nobody else punched on P, so they are absent now (and the week-off man is not off on P).
    const absentP = await prisma.attendanceRecord.findUniqueOrThrow({
      where: { storeId_staffId_date: { storeId: A.s1, staffId: U.repA, date: P } },
    });
    expect(absentP).toMatchObject({ status: 'absent', source: 'auto' });

    // Punches are never mutated: every pre-existing punch is byte-for-byte the same.
    const punchesAfter = await prisma.rawPunchEvent.findMany({ where: { id: { in: punchesBefore.map((p) => p.id) } }, orderBy: { id: 'asc' } });
    expect(punchesAfter).toEqual(punchesBefore);

    // Other stores are never touched.
    expect(await prisma.attendanceRecord.count({ where: { storeId: A.s2 } })).toBe(0);

    const run2 = (
      await request(server())
        .post('/hrms/processing-runs')
        .set(as(U.ho))
        .send({ from: dateOnly(legacyDay), to: dateOnly(P), storeId: A.s1 })
        .expect(201)
    ).body;
    expect(run2.changed).toBe(0);
    expect(run2.processed).toBe(run1.processed);

    const runs = (await request(server()).get('/hrms/processing-runs').set(as(U.ho)).expect(200)).body;
    expect(runs.map((r: { id: string }) => r.id).slice(0, 2)).toEqual([run2.id, run1.id]);
    await request(server()).post('/hrms/processing-runs').set(as(U.mgr)).send({ from: dateOnly(P), to: dateOnly(P) }).expect(403);
  });

  it('reports a processing run as partially_failed when one employee-day fails', async () => {
    const original = attendanceOps.reprocessDay.bind(attendanceOps);
    let inject = true;
    const spy = jest.spyOn(attendanceOps, 'reprocessDay').mockImplementation(async (args) => {
      if (inject) {
        inject = false;
        throw new Error('injected employee-day failure');
      }
      return original(args);
    });
    try {
      const run = (
        await request(server())
          .post('/hrms/processing-runs')
          .set(as(U.ho))
          .send({ from: dateOnly(P), to: dateOnly(P), storeId: A.s1 })
          .expect(201)
      ).body;
      expect(run.status).toBe('partially_failed');
      expect(run.processed).toBeGreaterThan(1);
      expect(run.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'injected employee-day failure' }),
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('voiding a punch keeps the row as evidence and recomputes the day', async () => {
    const out = await prisma.rawPunchEvent.findFirstOrThrow({ where: { userId: U.repE, kind: 'out', voidedAt: null } });
    await request(server()).delete(`/hrms/punches/${out.id}`).set(as(U.mgr)).send({ reason: 'duplicate' }).expect(200);
    expect((await prisma.rawPunchEvent.findUniqueOrThrow({ where: { id: out.id } })).voidedAt).not.toBeNull();
    const row = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: recordE } });
    expect(row.checkOutAt).toBeNull();
    expect(row.workedMins).toBeNull();

    const log = (await request(server()).get(`/hrms/punches?from=${dateOnly(P)}&to=${dateOnly(P)}&userId=${U.repE}`).set(as(U.mgr)).expect(200)).body;
    expect(log.map((p: { kind: string; voidedAt: string | null }) => [p.kind, !!p.voidedAt]).sort()).toEqual(
      [['in', false], ['in', true], ['out', true]].sort(),
    );
    expect(log[0]).toHaveProperty('local');
  });

  it('the day close appends one auto-close punch, however often it runs', async () => {
    const d = dayOff(-4);
    const dangling = await prisma.attendanceRecord.create({
      data: { organisationId: A.org, storeId: A.s1, staffId: U.repH, staffName: U.repH, date: d, status: 'present', checkInAt: at(d, '09:30'), shiftId: shiftG },
    });
    for (let i = 0; i < 2; i++) {
      await request(server()).post('/hrms/attendance/day-close').set(as(U.mgr)).send({ storeId: A.s1, date: dateOnly(d) }).expect(201);
    }
    const auto = await prisma.rawPunchEvent.findMany({ where: { userId: U.repH, source: 'auto' } });
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ kind: 'out', idempotencyKey: `auto:${dangling.id}:out` });
    expect(auto[0].eventAt.getTime()).toBe(at(d, '18:30').getTime());
  });

  // --- 5. Flexible shifts and effective-dated assignments ---------------------

  it('assignments are effective-dated; a flexible assigned shift is never late', async () => {
    const flex = (
      await request(server())
        .post('/hrms/shifts')
        .set(as(U.mgr))
        .send({ storeId: A.s1, name: 'Flexible', code: 'F', startTime: '05:00', endTime: '23:00', isFlexible: true })
        .expect(201)
    ).body;
    expect(flex).toMatchObject({ isFlexible: true, code: 'F' });

    const first = (
      await request(server()).post('/hrms/shift-assignments').set(as(U.mgr)).send({ userId: U.repH, shiftId: shiftG, effectiveFrom: dateOnly(dayOff(-20)) }).expect(201)
    ).body;
    await request(server()).post('/hrms/shift-assignments').set(as(U.mgr)).send({ userId: U.repH, shiftId: flex.id, effectiveFrom: dateOnly(dayOff(-10)) }).expect(201);
    const list = (await request(server()).get(`/hrms/shift-assignments?userId=${U.repH}`).set(as(U.mgr)).expect(200)).body;
    expect(list.find((a: { id: string }) => a.id === first.id).effectiveTo).toBe(dateOnly(dayOff(-11)));
    await request(server())
      .patch(`/hrms/shift-assignments/${first.id}`)
      .set(as(U.mgr))
      .send({ effectiveTo: dateOnly(dayOff(-5)) })
      .expect(409);

    // 13:00 on a flexible day: on time. The same 13:00 on the G shift (day -15): late.
    const mark = (d: Date) =>
      request(server())
        .post('/hrms/attendance')
        .set(as(U.mgr))
        .send({ staffId: U.repH, storeId: A.s1, status: 'present', date: dateOnly(d), checkInLocal: '13:00' })
        .expect(201);
    expect((await mark(dayOff(-6))).body).toMatchObject({ isLate: false, status: 'present', shiftId: flex.id });
    expect((await mark(dayOff(-15))).body).toMatchObject({ isLate: true, shiftId: shiftG });
    // The manager's mark is in the ledger too.
    expect(await prisma.rawPunchEvent.count({ where: { userId: U.repH, source: 'manager' } })).toBe(2);

    // A shift still assigned cannot simply vanish.
    await request(server()).delete(`/hrms/shifts/${flex.id}`).set(as(U.mgr)).expect(409);
    await request(server()).delete(`/hrms/shifts/${flex.id}?force=1`).set(as(U.mgr)).expect(200);
    expect(await prisma.shift.count({ where: { id: flex.id } })).toBe(0);

    const edited = (await request(server()).patch(`/hrms/shifts/${shiftG}`).set(as(U.mgr)).send({ bufferMins: 30, code: 'GEN' }).expect(200)).body;
    expect(edited).toMatchObject({ bufferMins: 30, code: 'GEN', isFlexible: false });
  });

  // --- Approvals, leave, balances, holidays -----------------------------------

  it('the approvals inbox holds leave and regularizations; approving a fix writes regularization punches', async () => {
    await request(server())
      .post('/hrms/leave')
      .set(as(U.repE))
      .send({ type: 'casual', fromDate: dateOnly(dayOff(20)), toDate: dateOnly(dayOff(20)), reason: 'family' })
      .expect(201);
    const regDay = dayOff(-5);
    await request(server())
      .post('/hrms/regularize')
      .set(as(U.repB))
      .send({ date: dateOnly(regDay), requestedCheckIn: at(regDay, '09:31').toISOString(), requestedCheckOut: at(regDay, '18:35').toISOString(), reason: 'forgot' })
      .expect(201);

    const inbox = (await request(server()).get('/hrms/approvals?status=pending').set(as(U.mgr)).expect(200)).body;
    const leave = inbox.find((i: { kind: string }) => i.kind === 'leave');
    const reg = inbox.find((i: { kind: string }) => i.kind === 'regularization');
    expect(leave).toMatchObject({ staffId: U.repE, leaveType: 'casual', halfDay: false, status: 'pending', storeName: 'Bandra' });
    expect(typeof leave.ageHours).toBe('number');
    expect(reg).toMatchObject({ staffId: U.repB, from: dateOnly(regDay), status: 'pending' });

    await request(server()).patch(`/hrms/regularize/${reg.id}`).set(as(U.mgr)).send({ status: 'approved' }).expect(200);
    const regPunches = await prisma.rawPunchEvent.findMany({ where: { userId: U.repB, source: 'regularization' } });
    expect(regPunches.map((p) => p.idempotencyKey).sort()).toEqual([`regularization:${reg.id}:in`, `regularization:${reg.id}:out`]);

    // Edit the pending leave, then delete it.
    const edited = (
      await request(server())
        .patch(`/hrms/leave/${leave.id}/edit`)
        .set(as(U.mgr))
        .send({ fromDate: dateOnly(dayOff(21)), toDate: dateOnly(dayOff(21)), type: 'sick', halfDay: true, reason: 'moved' })
        .expect(200)
    ).body;
    expect(edited).toMatchObject({ typeCode: 'sick', days: 0.5, halfDay: true });
    await request(server()).delete(`/hrms/leave/${leave.id}`).set(as(U.mgr)).send({ reason: 'withdrawn by phone' }).expect(200);
    expect(await prisma.leaveRequest.count({ where: { id: leave.id } })).toBe(0);
  });

  it('balances carry an id; only head office adjusts them, with a note', async () => {
    const rows = (await request(server()).get(`/hrms/leave/balances?staffId=${U.repE}`).set(as(U.mgr)).expect(200)).body;
    const casual = rows.find((r: { type: string }) => r.type === 'casual');
    expect(casual.id).toBeTruthy();
    await request(server()).patch(`/hrms/leave/balances/${casual.id}`).set(as(U.mgr)).send({ allocated: 20, note: 'x' }).expect(403);
    await request(server()).patch(`/hrms/leave/balances/${casual.id}`).set(as(U.ho)).send({ allocated: 20 }).expect(400);
    const res = (await request(server()).patch(`/hrms/leave/balances/${casual.id}`).set(as(U.ho)).send({ allocated: 20, note: 'carry-forward' }).expect(200)).body;
    expect(res.allocated).toBe(20);
    await request(server()).post('/hrms/leave/balances').set(as(U.ho)).send({ userId: U.repE, type: 'casual', year: casual.year, allocated: 5 }).expect(409);
  });

  it('a holiday can be moved and deleted', async () => {
    const h = (await request(server()).post('/hrms/holidays').set(as(U.mgr)).send({ storeId: A.s1, date: dateOnly(dayOff(30)), label: 'Diwali' }).expect(201)).body;
    const moved = (await request(server()).patch(`/hrms/holidays/${h.id}`).set(as(U.mgr)).send({ date: dateOnly(dayOff(31)) }).expect(200)).body;
    expect(moved).toMatchObject({ date: dateOnly(dayOff(31)), label: 'Diwali' });
    await request(server()).delete(`/hrms/holidays/${h.id}`).set(as(U.mgr)).expect(200);
  });

  it('the register is paginated', async () => {
    const q = `/hrms/attendance/register?from=${dateOnly(dayOff(-20))}&to=${dateOnly(today)}&storeId=${A.s1}`;
    const page1 = (await request(server()).get(`${q}&page=1&pageSize=2`).set(as(U.mgr)).expect(200)).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThan(2);
    expect(page1.items[0]).toHaveProperty('recordId');
    expect(page1.items[0]).toHaveProperty('source');
    const page2 = (await request(server()).get(`${q}&page=2&pageSize=2`).set(as(U.mgr)).expect(200)).body;
    expect(page2.items[0].recordId).not.toBe(page1.items[0].recordId);
    const lateOnly = (await request(server()).get(`${q}&status=late&pageSize=500`).set(as(U.mgr)).expect(200)).body;
    expect(lateOnly.items.every((r: { isLate: boolean }) => r.isLate)).toBe(true);
  });

  // --- No self or peer correction ----------------------------------------------

  it('nobody corrects their own day; a manager cannot correct a peer; head office can', async () => {
    const d = dayOff(-7);
    const mgrRow = await prisma.attendanceRecord.create({
      data: { organisationId: A.org, storeId: A.s1, staffId: U.mgr, staffName: U.mgr, date: d, status: 'absent', source: 'auto' },
    });
    const markBody = (staffId: string) => ({ staffId, storeId: A.s1, status: 'present', date: dateOnly(d), checkInAt: at(d, '09:30').toISOString() });
    const punchBody = (userId: string) => ({ userId, storeId: A.s1, kind: 'in', at: at(d, '09:30').toISOString(), note: 'x' });

    // Self.
    await request(server()).post('/hrms/attendance').set(as(U.mgr)).send(markBody(U.mgr)).expect(403);
    await request(server()).patch(`/hrms/attendance/${mgrRow.id}`).set(as(U.mgr)).send({ checkIn: '09:30', note: 'x' }).expect(403);
    await request(server()).delete(`/hrms/attendance/${mgrRow.id}`).set(as(U.mgr)).send({ reason: 'x' }).expect(403);
    await request(server()).post('/hrms/punches').set(as(U.mgr)).send(punchBody(U.mgr)).expect(403);
    await request(server()).post('/hrms/punches').set(as(U.ho)).send(punchBody(U.ho)).expect(403);
    // Peer (same rank).
    await request(server()).post('/hrms/attendance').set(as(U.mgr2)).send(markBody(U.mgr)).expect(403);
    await request(server()).patch(`/hrms/attendance/${mgrRow.id}`).set(as(U.mgr2)).send({ checkIn: '09:30', note: 'x' }).expect(403);
    await request(server()).delete(`/hrms/attendance/${mgrRow.id}`).set(as(U.mgr2)).send({ reason: 'x' }).expect(403);
    await request(server()).post('/hrms/punches').set(as(U.mgr2)).send(punchBody(U.mgr)).expect(403);
    await request(server()).post('/hrms/shift-assignments').set(as(U.mgr2)).send({ userId: U.mgr, shiftId: shiftG, effectiveFrom: dateOnly(d) }).expect(403);
    expect(await prisma.rawPunchEvent.count({ where: { userId: { in: [U.mgr, U.ho] } } })).toBe(0);

    // Head office corrects the manager, and a manager's punch cannot be voided by a peer.
    await request(server()).patch(`/hrms/attendance/${mgrRow.id}`).set(as(U.ho)).send({ checkIn: '09:30', note: 'forgot to punch' }).expect(200);
    const p = await prisma.rawPunchEvent.findFirstOrThrow({ where: { userId: U.mgr, voidedAt: null } });
    await request(server()).delete(`/hrms/punches/${p.id}`).set(as(U.mgr2)).send({}).expect(403);
    await request(server()).delete(`/hrms/punches/${p.id}`).set(as(U.mgr)).send({}).expect(403);

    // A peer cannot edit or delete a peer's leave either.
    const lv = await prisma.leaveRequest.create({
      data: { organisationId: A.org, storeId: A.s1, staffId: U.mgr, staffName: U.mgr, type: 'casual', status: 'pending', fromDate: dayOff(40), toDate: dayOff(40), days: 1 },
    });
    await request(server()).delete(`/hrms/leave/${lv.id}`).set(as(U.mgr2)).send({ reason: 'x' }).expect(403);
    await request(server()).delete(`/hrms/leave/${lv.id}`).set(as(U.mgr)).send({ reason: 'x' }).expect(403);
    await request(server()).delete(`/hrms/leave/${lv.id}`).set(as(U.ho)).send({ reason: 'x' }).expect(200);
  });

  it('an assignment whose shift is gone is not reachable, and deleting a shift leaves none dangling', async () => {
    const dangling = await prisma.shiftAssignment.create({
      data: { organisationId: A.org, userId: U.repA, shiftId: 'shift_that_does_not_exist', effectiveFrom: dayOff(-3) },
    });
    await request(server()).patch(`/hrms/shift-assignments/${dangling.id}`).set(as(U.mgr)).send({ effectiveTo: dateOnly(today) }).expect(404);
    await request(server()).delete(`/hrms/shift-assignments/${dangling.id}`).set(as(U.mgr)).expect(404);
    await prisma.shiftAssignment.delete({ where: { id: dangling.id } });

    const s = (await request(server()).post('/hrms/shifts').set(as(U.mgr)).send({ storeId: A.s1, name: 'Old', startTime: '10:00', endTime: '16:00' }).expect(201)).body;
    // A closed, past-only assignment still blocks a plain delete.
    const a = (await request(server()).post('/hrms/shift-assignments').set(as(U.mgr)).send({ userId: U.repA, shiftId: s.id, effectiveFrom: dateOnly(dayOff(-60)) }).expect(201)).body;
    await request(server()).patch(`/hrms/shift-assignments/${a.id}`).set(as(U.mgr)).send({ effectiveTo: dateOnly(dayOff(-50)) }).expect(200);
    await request(server()).delete(`/hrms/shifts/${s.id}`).set(as(U.mgr)).expect(409);
    await request(server()).delete(`/hrms/shifts/${s.id}?force=1`).set(as(U.mgr)).expect(200);
    expect(await prisma.shiftAssignment.count({ where: { shiftId: s.id } })).toBe(0);
  });

  // --- 3. Locks ----------------------------------------------------------------

  it('a locked month refuses edits and is skipped by processing, until reopened', async () => {
    const month = dateOnly(P).slice(0, 7);
    const lock = (await request(server()).post('/hrms/payroll-locks').set(as(U.ho)).send({ month }).expect(201)).body;
    expect(lock).toMatchObject({ month, reopenedAt: null });
    await request(server()).post('/hrms/payroll-locks').set(as(U.ho)).send({ month }).expect(409);
    await request(server()).post('/hrms/payroll-locks').set(as(U.mgr)).send({ month }).expect(403);

    const refused = await request(server())
      .patch(`/hrms/attendance/${recordE}`)
      .set(as(U.ho))
      .send({ checkIn: '09:45', note: 'late correction' })
      .expect(409);
    expect(refused.body.message).toBe(`Payroll for ${month} is locked`);
    await request(server()).delete(`/hrms/attendance/${recordE}`).set(as(U.ho)).send({ reason: 'x' }).expect(409);
    await request(server())
      .post('/hrms/punches')
      .set(as(U.mgr))
      .send({ userId: U.repE, storeId: A.s1, kind: 'out', at: at(P, '19:00').toISOString(), note: 'x' })
      .expect(409);
    await request(server())
      .post('/hrms/shift-assignments')
      .set(as(U.mgr))
      .send({ userId: U.repC, shiftId: shiftG, effectiveFrom: dateOnly(P) })
      .expect(409);
    await request(server())
      .patch(`/hrms/shifts/${shiftG}`)
      .set(as(U.mgr))
      .send({ bufferMins: 20 })
      .expect(409);
    await request(server())
      .patch('/hrms/week-off')
      .set(as(U.ho))
      .send({ storeId: A.s1, weekOffDay: 1 })
      .expect(409);
    await request(server())
      .put('/hrms/payroll/week-offs')
      .set(as(U.mgr))
      .send({ userId: U.repC, storeId: A.s1, days: [2] })
      .expect(409);

    const run = (await request(server()).post('/hrms/processing-runs').set(as(U.ho)).send({ from: dateOnly(P), to: dateOnly(P), storeId: A.s1 }).expect(201)).body;
    expect(run).toMatchObject({ skippedLocked: 1, processed: 0, changed: 0 });

    await request(server()).post(`/hrms/payroll-locks/${month}/reopen`).set(as(U.ho)).send({}).expect(400); // reason required
    const reopened = (await request(server()).post(`/hrms/payroll-locks/${month}/reopen`).set(as(U.ho)).send({ reason: 'late correction approved' }).expect(201)).body;
    expect(reopened.reopenReason).toBe('late correction approved');

    // Re-lock clears the reopen, then reopen again so the month is open.
    const relocked = (await request(server()).post('/hrms/payroll-locks').set(as(U.ho)).send({ month }).expect(201)).body;
    expect(relocked).toMatchObject({ reopenedAt: null, reopenReason: null });
    await request(server()).post(`/hrms/payroll-locks/${month}/reopen`).set(as(U.ho)).send({ reason: 'again' }).expect(201);

    await request(server()).delete(`/hrms/attendance/${recordE}`).set(as(U.ho)).send({ reason: 'duplicate row' }).expect(200);
    // The row is gone; its punches are not.
    expect(await prisma.attendanceRecord.count({ where: { id: recordE } })).toBe(0);
    expect(await prisma.rawPunchEvent.count({ where: { userId: U.repE } })).toBeGreaterThan(0);
    const locks = (await request(server()).get('/hrms/payroll-locks').set(as(U.ho)).expect(200)).body;
    expect(locks[0].lockedBy).toMatchObject({ id: U.ho });
  });
});
