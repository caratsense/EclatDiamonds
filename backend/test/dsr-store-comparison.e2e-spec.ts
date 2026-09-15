import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

/**
 * The multi-store DSR: branch against branch, today.
 *
 *  1. EVERY COLUMN IS A DATABASE FIGURE for that branch: revenue, cancellations,
 *     returns, walk-ins, enquiries, quotations and visit-to-sale conversion.
 *  2. RETURNS AND CANCELLATIONS ARE BESIDE REVENUE, never silently netted off it.
 *  3. A CONVERSION CARRIES ITS NUMERATOR AND DENOMINATOR.
 *  4. THE BASIS IS STATED: the business date, the clock that decided it, the
 *     tenant's one currency, and what each column means.
 *  5. SCOPE: head office compares its branches; a branch manager sees only
 *     theirs; a salesperson cannot open it; another tenant sees none of it.
 */

const PASSWORD = 'password123';
const A = {
  org: 'org_dsrc_a', slug: 'dsrc-a', s1: 'store_dsrc_1', s2: 'store_dsrc_2',
  ho: 'ho@dsrc-a.local', mgr: 'mgr@dsrc-a.local', rep: 'rep@dsrc-a.local',
};
const B = { org: 'org_dsrc_b', slug: 'dsrc-b', store: 'store_dsrc_b', ho: 'ho@dsrc-b.local' };

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.quote.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.lead.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.checkIn.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.sale.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.party.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}

describe('DSR branch comparison (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  const tokens: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
    for (const [org, slug] of [[A.org, A.slug], [B.org, B.slug]]) {
      await prisma.organisation.create({ data: { id: org, name: slug, slug, industryPackCode: 'jewellery' } });
    }
    await prisma.store.createMany({
      data: [
        { id: A.s1, name: 'First', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: A.s2, name: 'Second', city: 'Pune', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: B.store, name: 'Elsewhere', city: 'Delhi', organisationId: B.org, timezone: 'Asia/Kolkata' },
      ],
    });
    const users: [string, string, string, string, string][] = [
      ['u_dsrc_ho', A.ho, 'head_office', A.org, A.s1],
      ['u_dsrc_mgr', A.mgr, 'store_manager', A.org, A.s1],
      ['u_dsrc_rep', A.rep, 'salesperson', A.org, A.s1],
      ['u_dsrc_b_ho', B.ho, 'head_office', B.org, B.store],
    ];
    for (const [id, email, role, org, storeId] of users) {
      await prisma.user.create({
        data: {
          id, email, name: id, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: org,
          userStores: { create: { storeId, isPrimary: true } },
        },
      });
    }

    const now = new Date();
    const buyer = await prisma.party.create({ data: { organisationId: A.org, storeId: A.s1, name: 'Buyer', phone: '9822200001' } });
    const browser = await prisma.party.create({ data: { organisationId: A.org, storeId: A.s1, name: 'Browser', phone: '9822200002' } });
    const archived = await prisma.party.create({
      data: { organisationId: A.org, storeId: A.s1, name: 'Gone', phone: '9822200003', archivedAt: now, archiveReason: 'Asked to stop' },
    });

    const sale = (storeId: string, docNo: string, amount: number, extra: Record<string, unknown> = {}) => ({
      organisationId: extra.organisationId as string ?? A.org,
      storeId, docNo, docDate: now, totalAmount: amount, docType: 'sale' as never, ...extra,
    });
    await prisma.sale.createMany({
      data: [
        sale(A.s1, 'S1-1', 1000, { partyId: buyer.id }),
        sale(A.s1, 'S1-2', 2000),
        sale(A.s1, 'S1-3', 500, { isCancelled: true }),
        sale(A.s1, 'S1-R1', 300, { docType: 'sale_return' }),
        sale(A.s2, 'S2-1', 700),
        sale(B.store, 'B-1', 99999, { organisationId: B.org }),
      ],
    });
    await prisma.checkIn.createMany({
      data: [
        { organisationId: A.org, storeId: A.s1, customerName: 'Buyer', partyId: buyer.id, timeIn: now },
        { organisationId: A.org, storeId: A.s1, customerName: 'Browser', partyId: browser.id, timeIn: now },
        { organisationId: A.org, storeId: A.s1, customerName: 'Anonymous', timeIn: now },
        { organisationId: A.org, storeId: A.s2, customerName: 'Someone', timeIn: now },
      ],
    });
    await prisma.lead.createMany({
      data: [
        { organisationId: A.org, storeId: A.s1, ref: 'DSRC-L1', customerName: 'Buyer', source: 'walk_in' as never },
        { organisationId: A.org, storeId: A.s1, ref: 'DSRC-L2', customerName: 'Browser', source: 'walk_in' as never },
        { organisationId: A.org, storeId: A.s1, ref: 'DSRC-L3', customerName: 'Gone', partyId: archived.id, source: 'walk_in' as never },
      ],
    });
    await prisma.quote.create({ data: { organisationId: A.org, storeId: A.s1, ref: 'DSRC-Q1', customerName: 'Buyer' } });

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    tokens.ho = await login(A.ho);
    tokens.mgr = await login(A.mgr);
    tokens.rep = await login(A.rep);
    tokens.hoB = await login(B.ho);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  const row = (body: { storeRevenue: { storeId: string }[] }, id: string) =>
    body.storeRevenue.find((r) => r.storeId === id) as Record<string, unknown> | undefined;

  it('compares every branch head office can see, column by column', async () => {
    const res = await request(server()).get('/reporting/dsr').set(auth(tokens.ho)).expect(200);
    expect(res.body.storeRevenue).toHaveLength(2);

    expect(row(res.body, A.s1)).toMatchObject({
      store: 'First',
      revenue: 3000,
      bills: 2,
      // Beside revenue, not taken out of it.
      cancelled: { count: 1, amount: 500 },
      returns: { count: 1, amount: 300 },
      walkins: 3,
      // The archived customer's enquiry is not a live prospect.
      leads: 2,
      quotes: 1,
      visitToSale: { numerator: 1, denominator: 3, value: 33.3 },
    });
    expect(row(res.body, A.s2)).toMatchObject({
      revenue: 700, bills: 1, walkins: 1, leads: 0, quotes: 0,
      cancelled: { count: 0, amount: 0 }, returns: { count: 0, amount: 0 },
      visitToSale: { numerator: 0, denominator: 1, value: 0 },
    });
  });

  it('states the date, the clock, the currency and what each column means', async () => {
    const res = await request(server()).get('/reporting/dsr').set(auth(tokens.ho)).expect(200);
    expect(res.body.basis.timezone).toBe('Asia/Kolkata');
    expect(res.body.basis.zonesInScope).toEqual(['Asia/Kolkata']);
    expect(res.body.basis.currency).toBe('INR');
    expect(res.body.basis.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(res.body.basis.definitions)).toEqual(
      expect.arrayContaining(['revenue', 'cancelled', 'returns', 'walkins', 'leads', 'quotes', 'visitToSale']),
    );
  });

  it('a conversion with nothing to convert says so, not 0%', async () => {
    await prisma.checkIn.deleteMany({ where: { storeId: A.s2 } });
    const res = await request(server()).get('/reporting/dsr').set(auth(tokens.ho)).expect(200);
    expect(row(res.body, A.s2)?.visitToSale).toEqual({ numerator: 0, denominator: 0, value: null });
  });

  it('a branch manager sees only their branch', async () => {
    const res = await request(server()).get('/reporting/dsr').set(auth(tokens.mgr)).expect(200);
    expect(res.body.storeRevenue.map((r: { storeId: string }) => r.storeId)).toEqual([A.s1]);
    await request(server()).get('/reporting/dsr').set({ ...auth(tokens.mgr), 'X-Store-Id': A.s2 }).expect(403);
  });

  it('a salesperson cannot open the DSR, the movers or the period roll-up', async () => {
    for (const path of ['/reporting/dsr', '/reporting/movers', '/reporting/summary']) {
      await request(server()).get(path).set(auth(tokens.rep)).expect(403);
    }
  });

  it('another tenant sees none of it', async () => {
    const res = await request(server()).get('/reporting/dsr').set(auth(tokens.hoB)).expect(200);
    expect(res.body.storeRevenue.map((r: { storeId: string }) => r.storeId)).toEqual([B.store]);
    expect(row(res.body, B.store)).toMatchObject({ revenue: 99999, leads: 0 });
  });
});
