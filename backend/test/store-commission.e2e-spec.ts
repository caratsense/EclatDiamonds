import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * STORE-level sales commission (client 9 Oct item 13), end to end:
 *
 *  1. Head office configures a Bandra-like plan (₹15,00,000 at 1%) — PUT
 *     /commissions/plans, upsert per store.
 *  2. A month with ₹18,00,000 qualifying sales pays ₹3,000 — 1% of the ₹3,00,000
 *     EXCESS over the threshold, not of the whole figure. Qualifying = billed
 *     'sale' docs net of billed 'sale_return' docs, cancelled bills excluded,
 *     month bounded at the STORE's timezone (an IST sale at 00:00 on the 1st —
 *     18:30 UTC the previous evening — belongs to the new month).
 *  3. A month under the threshold pays 0.
 *  4. A store manager reads the summary; a salesperson gets 403 everywhere; a
 *     manager cannot write configuration (HO only).
 *  5. Another store is unaffected: no plan → no commission, and its sales never
 *     bleed into the first store's figure.
 */

const PASSWORD = 'password123';
const ORG = 'org_commission_e2e';
const S1 = 'store_comm_bandra';
const S2 = 'store_comm_kg';

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.commissionPlan.deleteMany({ where: { organisationId: ORG } });
  await prisma.sale.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}

describe('Store commission plan + monthly summary (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: ORG, name: 'Commission E2E', slug: 'commission-e2e', industryPackCode: 'jewellery', country: 'IN' },
    });
    await prisma.store.createMany({
      data: [
        { id: S1, name: 'Bandra', city: 'Mumbai', organisationId: ORG, timezone: 'Asia/Kolkata' },
        { id: S2, name: 'Kala Ghoda', city: 'Mumbai', organisationId: ORG, timezone: 'Asia/Kolkata' },
      ],
    });
    for (const [uid, role, store] of [
      ['u_comm_ho', 'head_office', S1],
      ['u_comm_mgr', 'store_manager', S1],
      ['u_comm_rep', 'salesperson', S1],
    ] as const) {
      await prisma.user.create({
        data: {
          id: uid, email: `${uid}@comm.local`, name: `${uid} Person`, role: role as never, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: ORG,
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }

    // Bandra, September 2026 (IST): 10L + 7L billed mid-month, 2L billed at
    // 2026-09-01 00:00 IST (= 2026-08-31T18:30Z — the store-timezone boundary),
    // a 5L CANCELLED bill (excluded), and a 1L sale return (netted off).
    // Qualifying = 19L − 1L = 18L.
    const sale = (docNo: string, docDate: string, totalAmount: number, extra: object = {}) => ({
      organisationId: ORG, storeId: S1, docNo, docType: 'sale' as const,
      docDate: new Date(docDate), totalAmount, ...extra,
    });
    await prisma.sale.createMany({
      data: [
        sale('CM-S1', '2026-09-10T10:00:00.000Z', 1_000_000),
        sale('CM-S2', '2026-09-15T10:00:00.000Z', 700_000),
        sale('CM-S3', '2026-08-31T18:30:00.000Z', 200_000), // 1 Sep 00:00 IST → September
        sale('CM-S4', '2026-09-12T10:00:00.000Z', 500_000, { isCancelled: true }),
        { organisationId: ORG, storeId: S1, docNo: 'CM-R1', docType: 'sale_return' as const,
          docDate: new Date('2026-09-20T10:00:00.000Z'), totalAmount: 100_000 },
        // Bandra, August 2026: 5L + 1L at 31 Aug 23:30 IST (18:00Z) → under threshold.
        sale('CM-S5', '2026-08-10T10:00:00.000Z', 500_000),
        sale('CM-S6', '2026-08-31T18:00:00.000Z', 100_000),
        // Kala Ghoda, September: sales exist but NO plan is configured there.
        { organisationId: ORG, storeId: S2, docNo: 'CM-S7', docType: 'sale' as const,
          docDate: new Date('2026-09-05T10:00:00.000Z'), totalAmount: 2_000_000 },
      ],
    });

    for (const who of ['u_comm_ho', 'u_comm_mgr', 'u_comm_rep']) {
      t[who] = (
        await request(server()).post('/auth/login').send({ email: `${who}@comm.local`, password: PASSWORD }).expect(201)
      ).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    await teardown(prisma);
    await app.close();
  });

  it('head office sets a Bandra-like plan: ₹15,00,000 threshold at 1%', async () => {
    const res = await request(server())
      .put('/commissions/plans')
      .set(as('u_comm_ho'))
      .send({ storeId: S1, threshold: 1_500_000, ratePercent: 1 })
      .expect(200);
    expect(res.body).toMatchObject({ storeId: S1, threshold: 1_500_000, ratePercent: 1, isActive: true });

    const plans = await request(server()).get('/commissions/plans').set(as('u_comm_ho')).expect(200);
    expect(plans.body.items).toHaveLength(1);
    expect(plans.body.items[0]).toMatchObject({ storeId: S1, storeName: 'Bandra', threshold: 1_500_000 });
  });

  it('18L qualifying month pays ₹3,000 — 1% of the 3L excess, net of returns, tz-bounded', async () => {
    const res = await request(server())
      .get('/commissions/summary')
      .query({ month: '2026-09', storeId: S1 })
      .set(as('u_comm_mgr'))
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      storeId: S1,
      month: '2026-09',
      sales: 1_900_000, // 10L + 7L + 2L (boundary) — cancelled 5L excluded
      returns: 100_000,
      qualifyingSales: 1_800_000,
      excess: 300_000,
      commission: 3_000,
    });
    expect(res.body.items[0].plan).toMatchObject({ threshold: 1_500_000, ratePercent: 1 });
  });

  it('a month under the threshold pays 0', async () => {
    const res = await request(server())
      .get('/commissions/summary')
      .query({ month: '2026-08', storeId: S1 })
      .set(as('u_comm_mgr'))
      .expect(200);
    expect(res.body.items[0]).toMatchObject({
      sales: 600_000, // 5L + the 31 Aug 23:30 IST sale; the 00:00 IST one moved to September
      qualifyingSales: 600_000,
      excess: 0,
      commission: 0,
    });
  });

  it('another store is unaffected: no plan → no commission, no cross-store bleed', async () => {
    const res = await request(server())
      .get('/commissions/summary')
      .query({ month: '2026-09' })
      .set(as('u_comm_ho'))
      .expect(200);
    const byStore = Object.fromEntries(res.body.items.map((i: { storeId: string }) => [i.storeId, i]));
    expect(byStore[S2]).toMatchObject({ sales: 2_000_000, plan: null, excess: null, commission: null });
    expect(byStore[S1].sales).toBe(1_900_000); // Kala Ghoda's 20L never leaks in
  });

  it('a salesperson is refused everywhere; a manager cannot write configuration', async () => {
    await request(server()).get('/commissions/plans').set(as('u_comm_rep')).expect(403);
    await request(server())
      .put('/commissions/plans').set(as('u_comm_rep'))
      .send({ storeId: S1, threshold: 1, ratePercent: 1 }).expect(403);
    await request(server()).get('/commissions/summary').set(as('u_comm_rep')).expect(403);
    // Config is HO-only — like other HO-set numbers (discount limits, week-off).
    await request(server())
      .put('/commissions/plans').set(as('u_comm_mgr'))
      .send({ storeId: S1, threshold: 1, ratePercent: 1 }).expect(403);
    await request(server()).get('/commissions/plans').set(as('u_comm_mgr')).expect(403);
  });

  it('rejects a bad month and a store outside the caller’s scope', async () => {
    await request(server())
      .get('/commissions/summary').query({ month: 'Sept-26' })
      .set(as('u_comm_mgr')).expect(400);
    // The manager is assigned only to Bandra — Kala Ghoda is out of scope.
    await request(server())
      .get('/commissions/summary').query({ month: '2026-09', storeId: S2 })
      .set(as('u_comm_mgr')).expect(403);
  });

  it('deactivating the plan keeps the configuration but stops the commission', async () => {
    await request(server())
      .put('/commissions/plans').set(as('u_comm_ho'))
      .send({ storeId: S1, threshold: 1_500_000, ratePercent: 1, isActive: false })
      .expect(200);
    const res = await request(server())
      .get('/commissions/summary').query({ month: '2026-09', storeId: S1 })
      .set(as('u_comm_mgr')).expect(200);
    expect(res.body.items[0]).toMatchObject({ qualifyingSales: 1_800_000, excess: null, commission: null });
    expect(res.body.items[0].plan).toMatchObject({ isActive: false, threshold: 1_500_000 });
  });
});
