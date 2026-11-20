import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Step 2 — CRITICAL USERS ISOLATION (L-C2).
 *
 * Org A = the seeded "Eclat" organisation (org_eclat). We stand up a fully separate
 * Org B (org_iso_users) with its own store, head office, store manager, salesperson,
 * plus a pending signup and an unassigned user, and prove that Org A's head office
 * and store-manager can NEITHER SEE nor MODIFY any Org-B user. `head_office` is the
 * head office of ITS OWN org, never a cross-tenant admin.
 *
 * Spec-unique ids (`*_iso_users`, slug `iso-users`) avoid collision with sibling
 * isolation specs. Sentinel `ISO-USERS` in every Org-B name → substring leak check.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in'; // seeded Eclat head office (org_eclat)

const B_HO_EMAIL = 'ho.iso-users@test.local';
const B_MGR_EMAIL = 'mgr.iso-users@test.local';
const B_REP_EMAIL = 'rep.iso-users@test.local';
const B_PENDING_EMAIL = 'pending.iso-users@test.local';
const B_UNASSIGNED_EMAIL = 'unassigned.iso-users@test.local';

const SENTINEL = 'ISO-USERS';

describe('Organisation isolation — USERS (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
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

    await teardownOrgB(prisma);
    await prisma.organisation.create({ data: { id: 'org_iso_users', name: 'ISO-USERS Jewels', slug: 'iso-users' } });
    await prisma.store.create({ data: { id: 'store_iso_users', name: `${SENTINEL} Store`, city: 'Testville', organisationId: 'org_iso_users' } });

    const hoB = await prisma.user.create({
      data: { email: B_HO_EMAIL, name: `${SENTINEL} HO B`, role: 'head_office', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_iso_users' },
    });
    const mgrB = await prisma.user.create({
      data: { email: B_MGR_EMAIL, name: `${SENTINEL} Mgr B`, role: 'store_manager', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_iso_users', userStores: { create: { storeId: 'store_iso_users', isPrimary: true } } },
    });
    const repB = await prisma.user.create({
      data: { email: B_REP_EMAIL, name: `${SENTINEL} Rep B`, role: 'salesperson', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_iso_users', userStores: { create: { storeId: 'store_iso_users', isPrimary: true } } },
    });
    // A pending self-signup (must never appear in Org A's approval queue).
    const pendingB = await prisma.user.create({
      data: { email: B_PENDING_EMAIL, name: `${SENTINEL} Pending B`, role: 'salesperson', passwordHash: hash, isActive: false, approvalStatus: 'pending', requestedRole: 'salesperson', requestedStoreId: 'store_iso_users', organisationId: 'org_iso_users' },
    });
    // An active user with NO store link (must never appear in Org A's unassigned list).
    const unassignedB = await prisma.user.create({
      data: { email: B_UNASSIGNED_EMAIL, name: `${SENTINEL} Unassigned B`, role: 'salesperson', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_iso_users' },
    });
    ids.hoB = hoB.id;
    ids.mgrB = mgrB.id;
    ids.repB = repB.id;
    ids.pendingB = pendingB.id;
    ids.unassignedB = unassignedB.id;

    tokens.aHo = await login(A_HO);
    tokens.bHo = await login(B_HO_EMAIL);
    // Fetch the seeded Eclat store-manager for the cross-org-modify-from-scoped test.
    const aMgr = await prisma.user.findFirst({
      where: { organisationId: 'org_eclat', role: 'store_manager', isActive: true },
      select: { email: true },
    });
    if (aMgr?.email) {
      try {
        tokens.aMgr = await login(aMgr.email);
      } catch {
        // Seeded manager may use OTP-only login; the HO cross-org checks still cover the rule.
      }
    }
  });

  afterAll(async () => {
    await teardownOrgB(prisma);
    await app?.close();
  });

  // ---- READ isolation: Org A HO must not see any Org-B user --------------------
  it('A head office GET /users does not contain any Org-B user', async () => {
    const r = await get('/users', tokens.aHo);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain(SENTINEL);
    expect(body).not.toContain(B_HO_EMAIL);
    expect(body).not.toContain(B_REP_EMAIL);
  });

  it('A head office GET /users/pending does not contain the Org-B pending signup', async () => {
    const r = await get('/users/pending', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SENTINEL);
    expect(JSON.stringify(r.body)).not.toContain(B_PENDING_EMAIL);
  });

  it('A head office GET /users/unassigned does not contain the Org-B unassigned user', async () => {
    const r = await get('/users/unassigned', tokens.aHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SENTINEL);
    expect(JSON.stringify(r.body)).not.toContain(B_UNASSIGNED_EMAIL);
  });

  // ---- WRITE isolation: Org A HO cannot modify an Org-B user -------------------
  const notFound = (s: number) => expect([403, 404]).toContain(s);

  it('A head office cannot change an Org-B user role', async () => {
    const r = await request(app.getHttpServer())
      .patch(`/users/${ids.repB}/role`)
      .set(auth(tokens.aHo))
      .send({ role: 'store_manager' });
    notFound(r.status);
    const after = await prisma.user.findUnique({ where: { id: ids.repB } });
    expect(after?.role).toBe('salesperson'); // UNCHANGED
  });

  it('A head office cannot deactivate an Org-B user', async () => {
    const r = await request(app.getHttpServer())
      .patch(`/users/${ids.repB}/deactivate`)
      .set(auth(tokens.aHo))
      .send({});
    notFound(r.status);
    const after = await prisma.user.findUnique({ where: { id: ids.repB } });
    expect(after?.isActive).toBe(true); // UNCHANGED
  });

  it("A head office cannot set an Org-B user's password", async () => {
    // Head office skips the store check, so the organisation is the only fence:
    // without it any organisation's head office could sign in as anybody.
    const before = await prisma.user.findUnique({ where: { id: ids.repB } });
    for (const target of [ids.repB, ids.hoB]) {
      const r = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .set(auth(tokens.aHo))
        .send({ userId: target, newPassword: 'taken-over-123' });
      expect(r.status).toBe(404);
    }
    const after = await prisma.user.findUnique({ where: { id: ids.repB } });
    expect(after?.passwordHash).toBe(before?.passwordHash); // UNCHANGED
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: B_REP_EMAIL, password: 'taken-over-123' })
      .expect(401);
  });

  it('B head office CAN set the password of its own user, and it is on record', async () => {
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .set(auth(tokens.bHo))
      .send({ userId: ids.repB, newPassword: 'own-org-reset-123' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: B_REP_EMAIL, password: 'own-org-reset-123' })
      .expect(201);
    const trail = await prisma.auditLog.findFirst({
      where: { action: 'user.password_reset', entityId: ids.repB },
    });
    expect(trail).toBeTruthy();
    expect(JSON.stringify(trail)).not.toContain('own-org-reset-123');
    // Back to the password the rest of this file signs in with.
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .set(auth(tokens.bHo))
      .send({ userId: ids.repB, newPassword: PASSWORD })
      .expect(201);
  });

  it('A head office cannot activate an Org-B (unassigned) user', async () => {
    const r = await request(app.getHttpServer())
      .patch(`/users/${ids.unassignedB}/activate`)
      .set(auth(tokens.aHo))
      .send({});
    notFound(r.status);
  });

  it('A head office cannot set leave allocation on an Org-B user', async () => {
    const r = await request(app.getHttpServer())
      .patch(`/users/${ids.repB}/leave-allocation`)
      .set(auth(tokens.aHo))
      .send({ type: 'casual', year: 2026, allocated: 99 });
    notFound(r.status);
    const bal = await prisma.leaveBalance.findFirst({ where: { userId: ids.repB } });
    expect(bal).toBeNull(); // nothing written cross-org
  });

  it('A store-manager likewise cannot modify an Org-B user', async () => {
    if (!tokens.aMgr) return; // seeded manager is OTP-only; HO checks already cover the rule
    const r = await request(app.getHttpServer())
      .patch(`/users/${ids.repB}/role`)
      .set(auth(tokens.aMgr))
      .send({ role: 'store_manager' });
    notFound(r.status);
    const after = await prisma.user.findUnique({ where: { id: ids.repB } });
    expect(after?.role).toBe('salesperson');
  });

  // ---- Legitimate same-org op still works -------------------------------------
  it('B head office CAN list its own users', async () => {
    const r = await get('/users', tokens.bHo);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).toContain(`${SENTINEL} Rep B`);
    expect(body).toContain(`${SENTINEL} Mgr B`);
    // And must NOT leak an Org-A user into B's own list.
    expect(body).not.toContain(A_HO);
  });

  it('B head office CAN see its own pending signup', async () => {
    const r = await get('/users/pending', tokens.bHo);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain(`${SENTINEL} Pending B`);
  });
});

async function teardownOrgB(prisma: PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: 'org_iso_users' } });
  await prisma.leaveBalance.deleteMany({ where: { user: { organisationId: 'org_iso_users' } } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: 'org_iso_users' } } });
  await prisma.user.deleteMany({ where: { organisationId: 'org_iso_users' } });
  await prisma.store.deleteMany({ where: { organisationId: 'org_iso_users' } });
  await prisma.organisation.deleteMany({ where: { slug: 'iso-users' } });
}
