import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Phase 2 — ORGANISATION ISOLATION.
 *
 * Org A = the seeded "Eclat" organisation (org_eclat). We stand up a second, fully
 * separate Org B (its own store, users, product, customer, stock, sale, audit) and
 * prove that neither organisation can read the other, and that Head Office of one
 * org sees ALL and ONLY its own stores. Isolation is enforced server-side from the
 * authenticated identity — the request never supplies organisationId.
 *
 * Sentinels: every Org-B record carries an "ISO-B" marker string so a substring
 * check on any response body is a robust "did B leak into A?" assertion regardless
 * of response shape.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in'; // seeded Eclat head office (org_eclat)

// Org-B sentinels — must NEVER appear in an Org-A response.
const B = {
  storeName: 'ISO-B Flagship Store',
  sku: 'ISO-B-SKU-001',
  customer: 'ISO-B Secret Customer',
  invoice: 'ISO-B-INV-001',
  audit: 'ISO-B secret audit entry',
};

describe('Organisation isolation (e2e)', () => {
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

    // Clean any prior run, then build Org B from scratch.
    await teardownOrgB(prisma);
    await prisma.organisation.create({ data: { id: 'org_b', name: 'Test Jewels B', slug: 'test-b' } });
    await prisma.store.create({ data: { id: 'store_b', name: B.storeName, city: 'Testville', organisationId: 'org_b' } });

    const hoB = await prisma.user.create({
      data: { email: 'ho.b@test-b.local', name: 'HO B', role: 'head_office', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_b' },
    });
    await prisma.user.create({
      data: { email: 'mgr.b@test-b.local', name: 'Mgr B', role: 'store_manager', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_b', userStores: { create: { storeId: 'store_b', isPrimary: true } } },
    });
    await prisma.user.create({
      data: { email: 'rep.b@test-b.local', name: 'Rep B', role: 'salesperson', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_b', userStores: { create: { storeId: 'store_b', isPrimary: true } } },
    });

    await prisma.product.create({ data: { sku: B.sku, name: 'ISO-B Ring', metal: 'gold_22k', organisationId: 'org_b', storeId: 'store_b', embedding: [] } });
    await prisma.party.create({ data: { id: 'party_b', name: B.customer, phone: '9990001111', organisationId: 'org_b', storeId: 'store_b' } });
    await prisma.stockItem.create({ data: { id: 'stock_b', storeId: 'store_b', organisationId: 'org_b', sku: B.sku } });
    await prisma.sale.create({ data: { id: 'sale_b', storeId: 'store_b', organisationId: 'org_b', docNo: B.invoice, docType: 'sale', docDate: new Date('2026-08-01'), totalAmount: 12345 } });
    await prisma.auditLog.create({ data: { actorId: hoB.id, actorName: 'HO B', actorRole: 'head_office', action: 'test.iso', entityType: 'Test', entityId: 'x', storeId: 'store_b', organisationId: 'org_b', summary: B.audit } });
    // Org-B configuration (must never surface in an Org-A config read).
    await prisma.discountPreset.create({ data: { organisationId: 'org_b', code: 'ISOBPRESET', name: 'ISO-B Secret Preset' } });

    tokens.aHo = await login(A_HO);
    tokens.bHo = await login('ho.b@test-b.local');
    tokens.bMgr = await login('mgr.b@test-b.local');
    tokens.bRep = await login('rep.b@test-b.local');
  });

  afterAll(async () => {
    await teardownOrgB(prisma);
    await app?.close();
  });

  // ---- Head Office scope: ALL and ONLY its own org's stores --------------------
  it('A head office sees its own stores and NOT the Org B store', async () => {
    const r = await get('/stores', tokens.aHo);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain(B.storeName);
    expect(body).not.toContain('store_b');
  });

  it('B head office sees ONLY its own store, never an Org A store', async () => {
    const r = await get('/stores', tokens.bHo);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).toContain(B.storeName); // its own store present
    expect(body).not.toContain('Surat'); // no Org A store leaks in
  });

  // ---- Cross-org read isolation (A must not see any B record) ------------------
  it('A cannot see Org B product', async () => {
    const r = await get('/products', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(B.sku);
  });

  it('A cannot see Org B customer', async () => {
    const r = await get('/parties', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(B.customer);
  });

  it('A cannot see Org B sale', async () => {
    const r = await get('/sales', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(B.invoice);
  });

  it('A cannot see Org B audit entry', async () => {
    const r = await get('/audit', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(B.audit);
  });

  // ---- Reverse direction: B must not see A ------------------------------------
  it('B head office cannot see Org A stores', async () => {
    const r = await get('/stores', tokens.bHo);
    expect(JSON.stringify(r.body)).not.toContain('Surat');
  });

  // ---- Lower-role isolation ----------------------------------------------------
  it('B store-manager is scoped to its own org store only', async () => {
    const r = await get('/stores', tokens.bMgr);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('Surat');
  });

  it('A cannot see Org B configuration (discount preset)', async () => {
    const r = await get('/discounts/presets', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('ISO-B Secret Preset');
    expect(JSON.stringify(r.body)).not.toContain('ISOBPRESET');
  });

  it('SKU is unique per organisation: A may create a product with a SKU that exists in B', async () => {
    // Org B already owns product SKU `ISO-B-SKU-001`. Org A creating the same SKU
    // must SUCCEED (no cross-org collision) — proving the [org, sku] composite.
    const r = await request(app.getHttpServer())
      .post('/products')
      .set(auth(tokens.aHo))
      .send({ sku: B.sku, name: 'A Ring (same SKU, different org)', category: 'ring', metal: 'gold_22k' });
    expect([200, 201]).toContain(r.status);
    // Clean up the Org-A product we just created so Eclat data is untouched.
    if (r.body?.id) await prisma.product.deleteMany({ where: { id: r.body.id } });
  });

  it('a cross-organisation stock transfer is refused', async () => {
    // Org A head office tries to transfer INTO Org B's store — must be rejected by
    // the organisation guard before any piece is touched.
    const r = await request(app.getHttpServer())
      .post('/stock-transfers')
      .set(auth(tokens.aHo))
      .send({ fromStoreId: 'surat-main', toStoreId: 'store_b', stockItemIds: ['stock_b'] });
    expect(r.status).toBe(403);
  });

  it('B salesperson cannot read Org A products', async () => {
    const r = await get('/products', tokens.bRep);
    // Whatever a salesperson can see, it must not include an Org A product.
    // (Cross-org leak would show A's catalogue to B's counter staff.)
    expect([200, 403]).toContain(r.status);
    if (r.status === 200) expect(JSON.stringify(r.body)).not.toContain('org_eclat');
  });
});

async function teardownOrgB(prisma: PrismaService) {
  // Safety-net for the SKU-collision test's Org-A product (in case it created one).
  await prisma.product.deleteMany({ where: { sku: 'ISO-B-SKU-001', organisationId: 'org_eclat' } });
  await prisma.discountPreset.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.auditLog.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.sale.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.stockItem.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.party.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.product.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: 'org_b' } } });
  await prisma.user.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.store.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.organisation.deleteMany({ where: { slug: 'test-b' } });
}
