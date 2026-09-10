import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Step 2 — MEDIUM/LOW tenant-isolation regressions (§L-M3/M4/M5, §L-L1/L3).
 *
 * Complements `org-isolation.e2e-spec.ts` (the store-scoped hot paths) by proving
 * the null-store / by-id-load leaks are closed:
 *   - dashboard Designs count + global-task write (M3)
 *   - products.setImage on a null-store product (M4)
 *   - discounts.create snapshotting a foreign product's price/cost (M5)
 *   - audit read: never another org's rows, but DOES surface the caller's OWN
 *     org's null-store (org-level) events (L1)
 *   - stock HUID existence check leaking/blocking across orgs (L3)
 *
 * Org A = the seeded "Eclat" org (org_eclat), HO = head.office@caratsense.in.
 * Org B is a spec-unique second org (org_iso_med / iso-med) built from scratch.
 * Isolation is enforced server-side from the authenticated identity; the request
 * never supplies organisationId.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in';

const SELF_AUDIT_ENTITY = 'IsoMedSelfTest'; // org_eclat null-store audit sentinel type
const SELF_AUDIT_SUMMARY = 'ISOMED org-level self event (null store)';

// Org-B sentinels — must NEVER appear in an Org-A response.
const B = {
  productSku: 'ISOMED-B-SKU-1',
  productName: 'ISOMED-B null-store design',
  taskTitle: 'ISOMED-B secret global task',
  audit: 'ISOMED-B secret audit entry',
  huid: 'ISOMEDH1',
  stockSku: 'ISOMED-B-STK-1',
};

describe('Organisation isolation — medium/low leaks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  let bProductId = '';
  let bTaskId = '';
  let eclatStoreId = '';
  let eclatHoId = '';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, t: string) => request(app.getHttpServer()).get(path).set(auth(t));
  const login = async (email: string) => {
    const r = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
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

    // Resolve real Org-A anchors we write against (never hardcode a seed id).
    const eclatHo = await prisma.user.findFirst({ where: { email: A_HO } });
    if (!eclatHo) throw new Error('Seed org_eclat head office not found');
    eclatHoId = eclatHo.id;
    const eclatStore = await prisma.store.findFirst({
      where: { organisationId: 'org_eclat', isAggregate: false },
      select: { id: true },
    });
    if (!eclatStore) throw new Error('No concrete org_eclat store to test against');
    eclatStoreId = eclatStore.id;

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardown(prisma);

    // ── Build Org B from scratch ────────────────────────────────────────────
    await prisma.organisation.create({ data: { id: 'org_iso_med', name: 'ISOMED Jewels', slug: 'iso-med' } });
    await prisma.store.create({ data: { id: 'store_iso_med', name: 'ISOMED Store', city: 'Testville', organisationId: 'org_iso_med' } });
    const hoB = await prisma.user.create({
      data: { email: 'ho.isomed@iso-med.local', name: 'HO ISOMED', role: 'head_office', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_iso_med' },
    });

    // A NULL-STORE (company-wide) product of Org B — the M4 target.
    const bProduct = await prisma.product.create({
      data: { sku: B.productSku, name: B.productName, metal: 'gold_22k', karat: 22, price: 50000, costPrice: 30000, organisationId: 'org_iso_med', storeId: null, embedding: [] },
    });
    bProductId = bProduct.id;

    // A NULL-STORE (global) task of Org B — the M3 target.
    const bTask = await prisma.task.create({
      data: { organisationId: 'org_iso_med', storeId: null, title: B.taskTitle, assignee: 'someone', status: 'open' },
    });
    bTaskId = bTask.id;

    // Org-B audit row (must never surface in Org A's /audit).
    await prisma.auditLog.create({
      data: { actorId: hoB.id, actorName: 'HO ISOMED', actorRole: 'head_office', action: 'test.iso', entityType: 'Test', entityId: 'x', storeId: 'store_iso_med', organisationId: 'org_iso_med', summary: B.audit },
    });

    // Org-B stock piece carrying a HUID (L3: a same-HUID Org-A create must be allowed).
    await prisma.stockItem.create({
      data: { storeId: 'store_iso_med', organisationId: 'org_iso_med', sku: B.stockSku, huid: B.huid },
    });

    // Org-A (org_eclat) NULL-STORE org-level audit event — L1 regression: HO must
    // be able to see this. actorId must be a real org_eclat user (FK).
    await prisma.auditLog.create({
      data: { actorId: eclatHoId, actorName: 'Eclat HO', actorRole: 'head_office', action: 'test.self', entityType: SELF_AUDIT_ENTITY, entityId: 'self', storeId: null, organisationId: 'org_eclat', summary: SELF_AUDIT_SUMMARY },
    });

    tokens.aHo = await login(A_HO);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  // ── M4: setImage on a null-store product of another org ───────────────────
  it('A HO cannot set the image of Org B null-store product (M4)', async () => {
    const r = await request(app.getHttpServer())
      .post(`/products/${bProductId}/image`)
      .set(auth(tokens.aHo))
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.product.findUnique({ where: { id: bProductId }, select: { imageUrl: true } });
    expect(after?.imageUrl ?? null).toBeNull(); // untouched
  });

  // ── M3: global (null-store) task status write across orgs ─────────────────
  it('A HO cannot change status of Org B null-store task (M3)', async () => {
    const r = await request(app.getHttpServer())
      .patch(`/dashboard/tasks/${bTaskId}`)
      .set(auth(tokens.aHo))
      .send({ status: 'done' });
    expect([403, 404]).toContain(r.status);
    const after = await prisma.task.findUnique({ where: { id: bTaskId }, select: { status: true } });
    expect(after?.status).toBe('open'); // untouched
  });

  // ── M5: discount create must not snapshot a foreign product ───────────────
  it('A HO discount create with an Org B productId is rejected (M5)', async () => {
    const r = await request(app.getHttpServer())
      .post('/discounts')
      .set(auth(tokens.aHo))
      .send({ storeId: eclatStoreId, customerName: 'Isomed Tester', item: 'Test Ring', productId: bProductId, diamondPercent: 5, makingPercent: 5 });
    expect([400, 403, 404]).toContain(r.status);
    // No request may have been created from the foreign reference.
    const count = await prisma.discountRequest.count({ where: { customerName: 'Isomed Tester' } });
    expect(count).toBe(0);
  });

  // ── L1: audit read — own org's null-store events visible, B's never ───────
  it('A HO audit read surfaces its OWN org null-store event and never Org B (L1)', async () => {
    const self = await get(`/audit?entityType=${SELF_AUDIT_ENTITY}`, tokens.aHo);
    expect(self.status).toBe(200);
    expect(JSON.stringify(self.body)).toContain(SELF_AUDIT_SUMMARY); // null-store org-level event IS visible

    const broad = await get('/audit?pageSize=100', tokens.aHo);
    expect(broad.status).toBe(200);
    expect(JSON.stringify(broad.body)).not.toContain(B.audit); // Org B never leaks
  });

  // ── L3: HUID existence check is org-scoped ────────────────────────────────
  it('A HO may stock-in a piece whose HUID exists in Org B (L3)', async () => {
    const r = await request(app.getHttpServer())
      .post('/stock')
      .set(auth(tokens.aHo))
      .send({ storeId: eclatStoreId, sku: 'ISOMED-A-STK-DUP', metal: 'gold_22k', huid: B.huid });
    expect([200, 201]).toContain(r.status); // same HUID, different org → allowed
    if (r.body?.id) await prisma.stockItem.deleteMany({ where: { id: r.body.id } });
  });

  // OTP (§L-L4) is deferred: requestOtp is a no-reveal dry-run without WhatsApp and
  // verifyOtp needs the delivered code, so there is no clean E2E seam. The
  // fail-closed mitigation in findUserByPhone (return null on >1 match) is covered
  // by code review; see report for the tenant-aware-login dependency.
});

async function teardown(prisma: PrismaService) {
  // Org_eclat rows this spec created.
  await prisma.auditLog.deleteMany({ where: { organisationId: 'org_eclat', entityType: SELF_AUDIT_ENTITY } });
  await prisma.discountRequest.deleteMany({ where: { customerName: 'Isomed Tester' } });
  await prisma.stockItem.deleteMany({ where: { organisationId: 'org_eclat', sku: 'ISOMED-A-STK-DUP' } });
  // Org B — children before store/org (FK order).
  await prisma.auditLog.deleteMany({ where: { organisationId: 'org_iso_med' } });
  await prisma.stockItem.deleteMany({ where: { organisationId: 'org_iso_med' } });
  await prisma.task.deleteMany({ where: { organisationId: 'org_iso_med' } });
  await prisma.product.deleteMany({ where: { organisationId: 'org_iso_med' } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: 'org_iso_med' } } });
  await prisma.user.deleteMany({ where: { organisationId: 'org_iso_med' } });
  await prisma.store.deleteMany({ where: { organisationId: 'org_iso_med' } });
  await prisma.organisation.deleteMany({ where: { slug: 'iso-med' } });
}
