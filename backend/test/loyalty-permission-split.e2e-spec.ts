import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Module 17 — loyalty permission split (client, 9 Oct 2026, item 11).
 *
 * Scheme PLAN configuration (create / edit / delete) is HEAD OFFICE ONLY —
 * not even a store manager may define or retune a plan, because what a scheme
 * pays is a company decision, not a branch one. Store staff (salesperson and
 * up) keep ENROLMENT: putting a customer onto one of the plans head office has
 * defined.
 */
const PASSWORD = 'password123';

const F = {
  org: 'org_loy_perm',
  slug: 'loy-perm',
  store: 'store_loy_perm',
  ho: 'ho.loy-perm@test.local',
  manager: 'mgr.loy-perm@test.local',
  rep: 'rep.loy-perm@test.local',
};

describe('Loyalty permission split — plans HO-only, enrolment salesperson+ (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  let planId = '';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
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
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardown(prisma);

    // Loyalty is a jewellery-pack module; without the pack the entitlement
    // guard would refuse it before the role gate is even reached.
    await prisma.organisation.create({
      data: { id: F.org, name: 'Loy Perm Org', slug: F.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: F.store, name: 'LOY-PERM Store', city: 'Testville', organisationId: F.org },
    });
    for (const [email, name, role] of [
      [F.ho, 'HO Loy-Perm', 'head_office'],
      [F.manager, 'Manager Loy-Perm', 'store_manager'],
      [F.rep, 'Rep Loy-Perm', 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          email, name, role, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: F.org,
          userStores: { create: { storeId: F.store, isPrimary: true } },
        },
      });
    }

    tokens.ho = await login(F.ho);
    tokens.manager = await login(F.manager);
    tokens.rep = await login(F.rep);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  const PLAN = {
    name: 'Perm Split Scheme',
    tenureMonths: 11,
    bonusMonths: 1,
    defaultInstallment: 5000,
  };

  // ---- Plan configuration is head office only -------------------------------
  it('salesperson cannot CREATE a scheme plan (403)', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/plans')
      .set(auth(tokens.rep))
      .send(PLAN);
    expect(r.status).toBe(403);
  });

  it('store manager cannot CREATE a scheme plan either (403) — not a branch decision', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/plans')
      .set(auth(tokens.manager))
      .send(PLAN);
    expect(r.status).toBe(403);
  });

  it('head office CAN create a scheme plan', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/plans')
      .set(auth(tokens.ho))
      .send(PLAN);
    expect(r.status).toBe(201);
    expect(r.body.name).toBe(PLAN.name);
    planId = r.body.id;
  });

  it('salesperson cannot EDIT a plan (403); head office can', async () => {
    const asRep = await request(app.getHttpServer())
      .patch(`/loyalty/plans/${planId}`)
      .set(auth(tokens.rep))
      .send({ defaultInstallment: 7500 });
    expect(asRep.status).toBe(403);

    const asHo = await request(app.getHttpServer())
      .patch(`/loyalty/plans/${planId}`)
      .set(auth(tokens.ho))
      .send({ defaultInstallment: 7500 });
    expect(asHo.status).toBe(200);
    expect(asHo.body.defaultInstallment).toBe(7500);
  });

  it('salesperson cannot DELETE a plan (403)', async () => {
    const r = await request(app.getHttpServer())
      .delete(`/loyalty/plans/${planId}`)
      .set(auth(tokens.rep));
    expect(r.status).toBe(403);
    // The plan survives the refused delete.
    const still = await prisma.schemePlan.findUnique({ where: { id: planId } });
    expect(still).toBeTruthy();
  });

  // ---- Enrolment stays with store staff --------------------------------------
  it('salesperson CAN enrol a customer onto a head-office plan', async () => {
    const r = await request(app.getHttpServer())
      .post('/loyalty/members')
      .set(auth(tokens.rep))
      .send({
        storeId: F.store,
        customerName: 'Perm Split Customer',
        phone: '9876501234',
        planId,
        installment: 7500,
      });
    expect(r.status).toBe(201);
    expect(r.body.ref).toMatch(/^GSS-/);
    expect(r.body.planId).toBe(planId);
    expect(r.body.installment).toBe(7500);
  });

  it('salesperson can read the active plans to enrol against', async () => {
    const r = await request(app.getHttpServer())
      .get('/loyalty/plans')
      .set(auth(tokens.rep));
    expect(r.status).toBe(200);
    expect(r.body.some((p: { id: string }) => p.id === planId)).toBe(true);
  });
});

async function teardown(prisma: PrismaService) {
  // SchemeInstallment cascades from SchemeMember; AuditLog rows (plan CRUD by
  // this spec's HO) reference users with RESTRICT, so clear them first.
  await prisma.schemeMember.deleteMany({ where: { organisationId: F.org } });
  await prisma.schemePlan.deleteMany({ where: { organisationId: F.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: F.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: F.org } } });
  await prisma.user.deleteMany({ where: { organisationId: F.org } });
  await prisma.store.deleteMany({ where: { organisationId: F.org } });
  await prisma.organisation.deleteMany({ where: { slug: F.slug } });
}
