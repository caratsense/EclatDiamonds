import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Recurring targets (client, 9 Oct item 14): a store's target holds every month
 * until it is changed.
 *
 * Carry-forward is resolved at READ time (src/targets/effective-targets.ts) —
 * nothing copies rows: a month with no typed SalesTarget row inherits the most
 * recent EARLIER month's row for that store, flagged `carriedFrom` so the UI can
 * say no typed row exists. Typing a row for a later month overrides from that
 * month on, per store, and earlier months never inherit from later ones.
 */

const PASSWORD = 'password123';
const A = {
  org: 'org_tcf',
  slug: 'tcf',
  storeA: 'store_tcf_a',
  storeB: 'store_tcf_b',
  ho: 'ho@tcf.local',
};

async function teardown(prisma: PrismaService) {
  await prisma.salesTarget.deleteMany({ where: { store: { organisationId: A.org } } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('Sales target carry-forward (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hoT: string;
  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const setTarget = (storeId: string, period: string, amount: number) =>
    request(server()).post('/targets').set(auth(hoT)).send({ storeId, period, amount }).expect(201);
  const achievementFor = async (storeId: string, period: string) => {
    const res = await request(server()).get(`/targets/achievement?period=${period}`).set(auth(hoT)).expect(200);
    return res.body.items.find((i: { storeId: string }) => i.storeId === storeId);
  };
  const listFor = async (storeId: string, period: string) => {
    const res = await request(server()).get(`/targets?period=${period}`).set(auth(hoT)).expect(200);
    return res.body.items.find((i: { storeId: string }) => i.storeId === storeId);
  };

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'TCF', slug: A.slug, industryPackCode: 'jewellery' } });
    await prisma.store.create({ data: { id: A.storeA, name: 'Colaba', city: 'Mumbai', organisationId: A.org } });
    await prisma.store.create({ data: { id: A.storeB, name: 'Juhu', city: 'Mumbai', organisationId: A.org } });
    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({
      data: {
        id: 'u_tcf_ho', email: A.ho, name: 'u_tcf_ho', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.storeA, isPrimary: true } },
      },
    });
    hoT = (await request(server()).post('/auth/login').send({ email: A.ho, password: PASSWORD }).expect(201)).body.token;
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('a target set for 2026-09 only is the effective October target, flagged as carried', async () => {
    await setTarget(A.storeA, '2026-09', 500_000);

    // September itself: the typed row, not a carry.
    expect(await achievementFor(A.storeA, '2026-09')).toMatchObject({ target: 500_000, carriedFrom: null });

    // October has no row — September's holds, and says where it came from.
    expect(await achievementFor(A.storeA, '2026-10')).toMatchObject({ target: 500_000, carriedFrom: '2026-09' });

    // The list view agrees, and a carried row has NO id — there is nothing for
    // this month to patch or delete; the UI must create an October row instead.
    expect(await listFor(A.storeA, '2026-10')).toMatchObject({
      id: null, amount: 500_000, period: '2026-10', carriedFrom: '2026-09',
    });

    // Months before the first typed row inherit nothing.
    expect(await achievementFor(A.storeA, '2026-08')).toMatchObject({ target: 0, carriedFrom: null });
    expect(await listFor(A.storeA, '2026-08')).toBeUndefined();
  });

  it('typing an October row wins from October on; September stays what it was', async () => {
    await setTarget(A.storeA, '2026-10', 700_000);

    expect(await achievementFor(A.storeA, '2026-10')).toMatchObject({ target: 700_000, carriedFrom: null });
    expect(await achievementFor(A.storeA, '2026-09')).toMatchObject({ target: 500_000, carriedFrom: null });

    // Later months now carry the LATEST earlier row — October's, not September's.
    expect(await achievementFor(A.storeA, '2026-12')).toMatchObject({ target: 700_000, carriedFrom: '2026-10' });
  });

  it('carry-forward is per store — one store’s rows never leak into another’s months', async () => {
    expect(await achievementFor(A.storeB, '2026-10')).toMatchObject({ target: 0, carriedFrom: null });

    await setTarget(A.storeB, '2026-10', 300_000);
    expect(await achievementFor(A.storeB, '2026-11')).toMatchObject({ target: 300_000, carriedFrom: '2026-10' });
    // Store A's November still comes from its own October row.
    expect(await achievementFor(A.storeA, '2026-11')).toMatchObject({ target: 700_000, carriedFrom: '2026-10' });
  });
});
