import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import { businessDate, dateOnly, instantFromLocalTime } from '../src/common/tz.util';

/**
 * Attendance integrity under races and deletes (docs/modules/06-attendance.md):
 *
 *  1. Two check-ins fired together leave ONE live check-in and one register row.
 *     The store has no fence, so the punch is allowed but never "within fence".
 *  2. Two reviewers deciding one regularisation at once: exactly one decision.
 *  3. A deleted register row is not brought back by a processing run.
 */

const PASSWORD = 'password123';
const TZ = 'Asia/Kolkata';
const O = { org: 'org_att_integrity', slug: 'att-integrity', store: 'store_att_integrity' };
const U = {
  ho: 'u_attint_ho',
  mgr: 'u_attint_mgr',
  mgr2: 'u_attint_mgr2',
  racer: 'u_attint_racer',
  fixer: 'u_attint_fixer',
  gone: 'u_attint_gone',
};

const DAY = 86_400_000;
const today = businessDate(new Date(), TZ);
const dayOff = (n: number) => new Date(today.getTime() + n * DAY);
const at = (d: Date, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return instantFromLocalTime(d, h * 60 + m, TZ);
};

async function teardown(prisma: PrismaService) {
  await prisma.rawPunchEvent.deleteMany({ where: { organisationId: O.org } });
  await prisma.attendanceProcessingRun.deleteMany({ where: { organisationId: O.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: O.org } });
  await prisma.notification.deleteMany({ where: { userId: { in: Object.values(U) } } });
  await prisma.attendanceRecord.deleteMany({ where: { organisationId: O.org } });
  await prisma.attendanceRegularization.deleteMany({ where: { organisationId: O.org } });
  await prisma.shift.deleteMany({ where: { organisationId: O.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: O.org } } });
  await prisma.user.deleteMany({ where: { organisationId: O.org } });
  await prisma.store.deleteMany({ where: { organisationId: O.org } });
  await prisma.organisation.deleteMany({ where: { id: O.org } });
}

describe('Attendance integrity under races and deletes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

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
    await teardown(prisma);

    await prisma.organisation.create({
      data: { id: O.org, name: 'Integrity', slug: O.slug, industryPackCode: 'jewellery' },
    });
    // No coordinates: there is no fence to verify against.
    await prisma.store.create({
      data: { id: O.store, name: 'No Fence', city: 'Mumbai', organisationId: O.org, timezone: TZ },
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mk = (id: string, role: string) =>
      prisma.user.create({
        data: {
          id,
          email: `${id}@att-integrity.local`,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: O.org,
          userStores: { create: { storeId: O.store, isPrimary: true } },
        },
      });
    await mk(U.ho, 'head_office');
    await mk(U.mgr, 'store_manager');
    await mk(U.mgr2, 'store_manager');
    for (const id of [U.racer, U.fixer, U.gone]) await mk(id, 'salesperson');
    for (const who of [U.ho, U.mgr, U.mgr2, U.racer, U.fixer]) {
      t[who] = (
        await request(server())
          .post('/auth/login')
          .send({ email: `${who}@att-integrity.local`, password: PASSWORD })
          .expect(201)
      ).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('two simultaneous check-ins leave one live check-in; no fence is never "within fence"', async () => {
    const [a, b] = await Promise.all([
      request(server()).post('/hrms/attendance/check-in').set(as(U.racer)).send({}),
      request(server()).post('/hrms/attendance/check-in').set(as(U.racer)).send({}),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    // The loser is refused (a 4xx) or handed the same row — never a second check-in.
    expect(statuses[1] === 201 || (statuses[1] >= 400 && statuses[1] < 500)).toBe(true);
    for (const res of [a, b].filter((r) => r.status === 201)) {
      expect(res.body.withinFence).not.toBe(true);
    }

    expect(await prisma.attendanceRecord.count({ where: { staffId: U.racer } })).toBe(1);
    const live = await prisma.rawPunchEvent.count({
      where: { userId: U.racer, kind: 'in', voidedAt: null },
    });
    expect(live).toBe(1);
    const row = await prisma.attendanceRecord.findFirstOrThrow({ where: { staffId: U.racer } });
    expect(row.geoVerified).toBe(false);
  });

  it('two reviewers deciding one regularisation at once produce exactly one decision', async () => {
    const d = dayOff(-3);
    const reg = (
      await request(server())
        .post('/hrms/regularize')
        .set(as(U.fixer))
        .send({
          date: dateOnly(d),
          requestedCheckIn: at(d, '10:02').toISOString(),
          requestedCheckOut: at(d, '19:05').toISOString(),
          reason: 'forgot to punch',
        })
        .expect(201)
    ).body;

    const [approve, reject] = await Promise.all([
      request(server()).patch(`/hrms/regularize/${reg.id}`).set(as(U.mgr)).send({ status: 'approved' }),
      request(server())
        .patch(`/hrms/regularize/${reg.id}`)
        .set(as(U.mgr2))
        .send({ status: 'rejected', note: 'not verified' }),
    ]);
    const wins = [approve, reject].filter((r) => r.status === 200);
    expect(wins).toHaveLength(1);
    const loser = [approve, reject].find((r) => r.status !== 200)!;
    expect(loser.status).toBeGreaterThanOrEqual(400);

    const saved = await prisma.attendanceRegularization.findUniqueOrThrow({ where: { id: reg.id } });
    const winner = wins[0] === approve ? { status: 'approved', by: U.mgr } : { status: 'rejected', by: U.mgr2 };
    expect(saved.status).toBe(winner.status);
    expect(saved.decidedById).toBe(winner.by);
    const regPunches = await prisma.rawPunchEvent.count({
      where: { userId: U.fixer, source: 'regularization', voidedAt: null },
    });
    expect(regPunches).toBe(winner.status === 'approved' ? 2 : 0);
  });

  it('a deleted register row is not resurrected by a processing run', async () => {
    const d = dayOff(-4);
    for (const [kind, hhmm] of [['in', '10:00'], ['out', '19:00']] as const) {
      await request(server())
        .post('/hrms/punches')
        .set(as(U.mgr))
        .send({ userId: U.gone, storeId: O.store, kind, at: at(d, hhmm).toISOString(), note: 'register' })
        .expect(201);
    }
    const row = await prisma.attendanceRecord.findFirstOrThrow({ where: { staffId: U.gone, date: d } });

    await request(server())
      .delete(`/hrms/attendance/${row.id}`)
      .set(as(U.ho))
      .send({ reason: 'entered for the wrong person' })
      .expect(200);
    expect(await prisma.attendanceRecord.count({ where: { staffId: U.gone, date: d } })).toBe(0);
    // Evidence stays, but nothing live is left to rebuild the day from.
    expect(await prisma.rawPunchEvent.count({ where: { userId: U.gone } })).toBeGreaterThan(0);
    expect(await prisma.rawPunchEvent.count({ where: { userId: U.gone, voidedAt: null } })).toBe(0);

    await request(server())
      .post('/hrms/processing-runs')
      .set(as(U.ho))
      .send({ from: dateOnly(d), to: dateOnly(d), storeId: O.store })
      .expect(201);
    const after = await prisma.attendanceRecord.findMany({ where: { staffId: U.gone, date: d } });
    // A run may record the day as absent; it must never bring the attendance back.
    expect(after.every((r) => r.status !== 'present' && r.checkInAt == null)).toBe(true);
  });
});
