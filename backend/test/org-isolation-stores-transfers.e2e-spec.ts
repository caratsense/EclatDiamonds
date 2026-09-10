import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Step 2 — ORGANISATION ISOLATION for stores, regions & stock transfers.
 *
 * Org A = the seeded "Eclat" organisation (org_eclat). We stand up a separate Org
 * B (its own two stores, HO/manager, a stock item, a submitted stock transfer, and
 * a region) and prove server-side that Org A's head office can neither read nor act
 * on any of it — the flagged HIGH/MEDIUM leaks in §L-H1/§L-H2/§L-M1/§L-M2. Head
 * office is org-wide, NOT global: `allStores` must mean "all stores in THIS org".
 *
 * Sentinel: every Org-B record carries the "ISO-ST" marker so a substring check on
 * any response body is a robust "did B leak into A?" assertion.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in'; // seeded Eclat head office (org_eclat)

const B = {
  org: 'org_iso_st',
  slug: 'iso-st',
  storeFrom: 'store_iso_st',
  storeTo: 'store_iso_st_2',
  storeName: 'ISO-ST Flagship Store',
  stock: 'stock_iso_st',
  transfer: 'transfer_iso_st',
  ref: 'ISO-ST-ST-001',
  region: 'region_iso_st',
  regionName: 'ISO-ST North Region',
  hoEmail: 'ho.iso-st@iso-st.local',
  mgrEmail: 'mgr.iso-st@iso-st.local',
};

describe('Org isolation — stores / regions / stock transfers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, t: string) =>
    request(app.getHttpServer()).get(path).set(auth(t));
  const login = async (email: string) => {
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    const hash = await bcrypt.hash(PASSWORD, 10);

    await teardown(prisma);

    // Stock transfers are a jewellery-pack module; the entitlement guard
    // refuses them to a tenant with no industry.
    await prisma.organisation.create({
      data: { id: B.org, name: 'ISO-ST Jewels', slug: B.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({ data: { id: B.storeFrom, name: B.storeName, city: 'Testville', organisationId: B.org, isActive: true, status: 'active' } });
    await prisma.store.create({ data: { id: B.storeTo, name: 'ISO-ST Depot', city: 'Testville', organisationId: B.org, isActive: true, status: 'active' } });
    await prisma.region.create({ data: { id: B.region, name: B.regionName, code: 'ISOSTN', organisationId: B.org } });

    const hoB = await prisma.user.create({
      data: { email: B.hoEmail, name: 'HO ISO-ST', role: 'head_office', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org },
    });
    const mgrB = await prisma.user.create({
      data: { email: B.mgrEmail, name: 'Mgr ISO-ST', role: 'store_manager', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: B.org, userStores: { create: { storeId: B.storeFrom, isPrimary: true } } },
    });

    await prisma.stockItem.create({ data: { id: B.stock, storeId: B.storeFrom, organisationId: B.org, sku: 'ISO-ST-SKU-1', status: 'in_stock' } });
    // A submitted transfer (awaiting HO approval) — the state approve/reject act on.
    await prisma.stockTransfer.create({
      data: {
        id: B.transfer,
        organisationId: B.org,
        ref: B.ref,
        status: 'submitted',
        fromStoreId: B.storeFrom,
        toStoreId: B.storeTo,
        requestedById: mgrB.id,
        submittedAt: new Date(),
        items: { create: { stockItemId: B.stock, sku: 'ISO-ST-SKU-1', name: 'ISO-ST Ring' } },
      },
    });
    void hoB;

    tokens.aHo = await login(A_HO);
    tokens.bHo = await login(B.hoEmail);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  const statusOf = async () =>
    (await prisma.stockTransfer.findUnique({ where: { id: B.transfer }, select: { status: true } }))?.status;

  // ---- Stock transfers ---------------------------------------------------------
  it('A HO stock-transfer list excludes the Org-B transfer', async () => {
    const r = await get('/stock-transfers', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('ISO-ST');
  });

  it('A HO cannot read the Org-B transfer detail', async () => {
    const r = await get(`/stock-transfers/${B.transfer}`, tokens.aHo);
    expect([403, 404]).toContain(r.status);
  });

  it('A HO cannot approve the Org-B transfer (status unchanged)', async () => {
    const r = await request(app.getHttpServer())
      .post(`/stock-transfers/${B.transfer}/approve`)
      .set(auth(tokens.aHo));
    expect([403, 404]).toContain(r.status);
    expect(await statusOf()).toBe('submitted');
    // The reservation path must NOT have fired cross-org.
    const stock = await prisma.stockItem.findUnique({ where: { id: B.stock }, select: { status: true } });
    expect(stock?.status).toBe('in_stock');
  });

  it('A HO cannot reject the Org-B transfer (status unchanged)', async () => {
    const r = await request(app.getHttpServer())
      .post(`/stock-transfers/${B.transfer}/reject`)
      .set(auth(tokens.aHo))
      .send({ reason: 'nope' });
    expect([403, 404]).toContain(r.status);
    expect(await statusOf()).toBe('submitted');
  });

  // ---- Stores ------------------------------------------------------------------
  it('A HO store list excludes the Org-B store', async () => {
    const r = await get('/stores', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('ISO-ST');
    expect(JSON.stringify(r.body)).not.toContain(B.storeFrom);
  });

  it('A HO cannot edit the Org-B store (unchanged)', async () => {
    const r = await request(app.getHttpServer())
      .patch(`/stores/${B.storeFrom}`)
      .set(auth(tokens.aHo))
      .send({ name: 'HIJACKED' });
    expect([403, 404]).toContain(r.status);
    const store = await prisma.store.findUnique({ where: { id: B.storeFrom }, select: { name: true } });
    expect(store?.name).toBe(B.storeName);
  });

  it('A HO cannot close the Org-B store (unchanged)', async () => {
    const r = await request(app.getHttpServer())
      .patch(`/stores/${B.storeFrom}/close`)
      .set(auth(tokens.aHo));
    expect([403, 404]).toContain(r.status);
    const store = await prisma.store.findUnique({ where: { id: B.storeFrom }, select: { isActive: true, status: true } });
    expect(store?.isActive).toBe(true);
    expect(store?.status).toBe('active');
  });

  it('A HO cannot provision a manager into the Org-B store', async () => {
    const before = await prisma.userStore.count({ where: { storeId: B.storeFrom } });
    const r = await request(app.getHttpServer())
      .post(`/stores/${B.storeFrom}/manager`)
      .set(auth(tokens.aHo))
      .send({ name: 'Intruder', email: 'intruder.iso-st@iso-st.local', password: 'password123' });
    expect([403, 404]).toContain(r.status);
    expect(await prisma.userStore.count({ where: { storeId: B.storeFrom } })).toBe(before);
    expect(await prisma.user.findUnique({ where: { email: 'intruder.iso-st@iso-st.local' } })).toBeNull();
  });

  // ---- Regions -----------------------------------------------------------------
  it('A HO region list excludes the Org-B region', async () => {
    const r = await get('/regions', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('ISO-ST');
  });

  // ---- Public directory --------------------------------------------------------
  it('public /stores/directory without ?org does not leak Org-B stores', async () => {
    const r = await request(app.getHttpServer()).get('/stores/directory');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('public /stores/directory?org=<other> returns only that org, not Org-B', async () => {
    const r = await request(app.getHttpServer()).get('/stores/directory?org=org_eclat');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('ISO-ST');
  });

  // ---- Legitimate same-org access ---------------------------------------------
  it('B HO can read its own transfer, stores and region', async () => {
    const t = await get(`/stock-transfers/${B.transfer}`, tokens.bHo);
    expect(t.status).toBe(200);
    expect(JSON.stringify(t.body)).toContain(B.ref);

    const s = await get('/stores', tokens.bHo);
    expect(s.status).toBe(200);
    expect(JSON.stringify(s.body)).toContain(B.storeName);

    const rg = await get('/regions', tokens.bHo);
    expect(rg.status).toBe(200);
    expect(JSON.stringify(rg.body)).toContain(B.regionName);
  });

  it('B HO can approve its own transfer', async () => {
    const r = await request(app.getHttpServer())
      .post(`/stock-transfers/${B.transfer}/approve`)
      .set(auth(tokens.bHo));
    expect([200, 201]).toContain(r.status);
    expect(await statusOf()).toBe('ho_approved');
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.stockTransferItem.deleteMany({ where: { transfer: { organisationId: B.org } } });
  await prisma.stockMovement.deleteMany({ where: { organisationId: B.org } });
  await prisma.stockTransfer.deleteMany({ where: { organisationId: B.org } });
  await prisma.stockItem.deleteMany({ where: { organisationId: B.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: B.org } } });
  // AuditLog.actorId -> User is onDelete: RESTRICT, so org-B audit rows (created by
  // the spec's own Org-B HO actions) must go before the users they reference.
  await prisma.auditLog.deleteMany({ where: { organisationId: B.org } });
  await prisma.user.deleteMany({ where: { organisationId: B.org } });
  await prisma.region.deleteMany({ where: { organisationId: B.org } });
  await prisma.store.deleteMany({ where: { organisationId: B.org } });
  await prisma.organisation.deleteMany({ where: { id: B.org } });
}
