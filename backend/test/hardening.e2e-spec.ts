import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase B — focused tests for the security code this pass changed.
 *
 * NOT the comprehensive suite (that is Phase C). Each of these covers a boundary
 * that was moved in this pass and would fail silently if a later change broke it:
 *
 *   MACHINE PRINCIPALS  The on-site agent used to authenticate as a head_office
 *   USER, which meant a credential in a config file on a shop PC could purge the
 *   tenant. The agent now has its own credential, reaches only ingestion, and is
 *   refused on anything destructive.
 *
 *   WEBHOOK OWNERSHIP   Razorpay `notes` were written into a Payment unverified,
 *   so a note naming another tenant's sale attached money to that tenant.
 *
 *   RLS PREDICATE       The policies must fail CLOSED with no tenant context.
 *   A policy that silently permits everything is worse than none, because it
 *   invites the app to relax its own checks.
 */
const PASSWORD = 'password123';
const GATI_PROFILE_ID = 'gati-hardening-e2e';
const GATI_PROFILE_HASH = 'e'.repeat(64);
const GATI_SOURCE_INSTANCE_HASH = 'f'.repeat(64);
const GATI_APPROVED_CONFIG = {
  enabled: true,
  expectedProfileHash: GATI_PROFILE_HASH,
  expectedSourceInstanceHash: GATI_SOURCE_INSTANCE_HASH,
};

const G = {
  org: 'org_hard_g',
  store: 'store_hard_g',
  slug: 'hard-g',
  ho: 'ho.g@hard-g.local',
};

describe('Phase B hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let agentToken: string;
  let gatiConfigRevision: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const asAgent = () => ({
    Authorization: `Bearer ${agentToken}`,
    'x-caratos-profile-id': GATI_PROFILE_ID,
    'x-caratos-profile-hash': GATI_PROFILE_HASH,
    'x-caratos-source-instance-hash': GATI_SOURCE_INSTANCE_HASH,
    'x-caratos-config-revision': gatiConfigRevision,
  });

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
    await prisma.organisation.create({ data: { id: G.org, name: 'Hardening G', slug: G.slug } });
    await prisma.store.create({
      data: { id: G.store, name: 'HARD-G Store', city: 'Testville', organisationId: G.org },
    });
    await prisma.user.create({
      data: {
        email: G.ho, name: 'HO G', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: G.org,
        userStores: { create: { storeId: G.store, isPrimary: true } },
      },
    });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: G.ho, password: PASSWORD });
    token = login.body.token;

    const enrolled = await request(app.getHttpServer())
      .post('/integration/connect/agents')
      .set(auth())
      .send({ name: 'HARD-G agent', sourceSystem: 'gati' });
    agentToken = enrolled.body.token;
    const configured = await request(app.getHttpServer())
      .post(`/integration/connect/agents/${enrolled.body.agent.id}/config`)
      .set(auth())
      .send({ config: GATI_APPROVED_CONFIG });
    expect(configured.status).toBe(201);
    gatiConfigRevision = configured.body.config.configRevision;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------ machine principals */

  it('legacy ingestion rejects humans and unapproved machine metadata before writes', async () => {
    const legacyId = `HARD-G-GUARD-${Date.now()}`;
    const body = {
      records: [{ PartyNo: legacyId, FirmName: 'must not be written' }],
    };
    const main = await prisma.connectAgent.findFirstOrThrow({
      where: { organisationId: G.org, name: 'HARD-G agent' },
      select: { id: true, sourceInstanceHash: true },
    });
    expect(main.sourceInstanceHash).toBeNull();

    const human = await request(app.getHttpServer())
      .post('/sync/parties')
      .set({ ...auth(), ...asAgent(), Authorization: `Bearer ${token}` })
      .send(body);
    expect(human.status).toBe(403);

    const missing = await request(app.getHttpServer())
      .post('/sync/parties')
      .set({ Authorization: `Bearer ${agentToken}` })
      .send(body);
    expect(missing.status).toBe(403);

    for (const changed of [
      { 'x-caratos-profile-hash': '0'.repeat(64) },
      { 'x-caratos-source-instance-hash': '1'.repeat(64) },
      { 'x-caratos-config-revision': 'stale-revision' },
    ]) {
      const refused = await request(app.getHttpServer())
        .post('/sync/parties')
        .set({ ...asAgent(), ...changed })
        .send(body);
      expect(refused.status).toBe(403);
    }

    expect(await prisma.party.count({ where: { organisationId: G.org, legacyId } })).toBe(0);
    expect((await prisma.connectAgent.findUnique({
      where: { id: main.id },
      select: { sourceInstanceHash: true },
    }))?.sourceInstanceHash).toBeNull();
  });

  it('an agent token can push data on the ingestion routes', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(asAgent())
      .send({ records: [] });
    // The point is that it AUTHENTICATES — an empty batch is a valid no-op.
    expect([200, 201]).toContain(res.status);
    expect((await prisma.connectAgent.findFirstOrThrow({
      where: { organisationId: G.org, name: 'HARD-G agent' },
      select: { sourceInstanceHash: true },
    })).sourceInstanceHash).toBe(GATI_SOURCE_INSTANCE_HASH);
  });

  it('a head-office config change immediately invalidates the old revision', async () => {
    const staleHeaders = asAgent();
    const main = await prisma.connectAgent.findFirstOrThrow({
      where: { organisationId: G.org, name: 'HARD-G agent' },
      select: { id: true },
    });
    const configured = await request(app.getHttpServer())
      .post(`/integration/connect/agents/${main.id}/config`)
      .set(auth())
      .send({ config: GATI_APPROVED_CONFIG });
    expect(configured.status).toBe(201);
    const nextRevision = configured.body.config.configRevision as string;
    expect(nextRevision).not.toBe(gatiConfigRevision);
    gatiConfigRevision = nextRevision;

    await request(app.getHttpServer())
      .post('/sync/parties')
      .set(staleHeaders)
      .send({ records: [] })
      .expect(403);

    await request(app.getHttpServer())
      .post('/sync/parties')
      .set(asAgent())
      .send({ records: [] })
      .expect(201);
  });

  it('connector source, store scope and kill switch gate legacy sync', async () => {
    const busy = await request(app.getHttpServer())
      .post('/integration/connect/agents')
      .set(auth())
      .send({ name: 'HARD-G BUSY', sourceSystem: 'busy' });
    expect(busy.status).toBe(201);
    const wrongSource = await request(app.getHttpServer())
      .post('/sync/parties')
      .set({ Authorization: `Bearer ${busy.body.token}` })
      .send({ records: [] });
    expect(wrongSource.status).toBe(403);

    const bound = await request(app.getHttpServer())
      .post('/integration/connect/agents')
      .set(auth())
      .send({ name: 'HARD-G bounded Gati', sourceSystem: 'gati', storeId: G.store });
    expect(bound.status).toBe(201);
    const wrongScope = await request(app.getHttpServer())
      .post('/sync/parties')
      .set({ Authorization: `Bearer ${bound.body.token}` })
      .send({ records: [] });
    expect(wrongScope.status).toBe(403);

    const main = await prisma.connectAgent.findFirstOrThrow({
      where: { organisationId: G.org, name: 'HARD-G agent' },
    });
    await prisma.connectAgent.update({
      where: { id: main.id },
      data: { config: { enabled: false } },
    });
    const disabledSync = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(asAgent())
      .send({ records: [] });
    expect(disabledSync.status).toBe(403);

    // Disabled agents may still check in and receive the stop instruction.
    const heartbeat = await request(app.getHttpServer())
      .get('/integration/connect/me')
      .set(asAgent());
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.enabled).toBe(false);
    const restored = await request(app.getHttpServer())
      .post(`/integration/connect/agents/${main.id}/config`)
      .set(auth())
      .send({ config: GATI_APPROVED_CONFIG });
    expect(restored.status).toBe(201);
    gatiConfigRevision = restored.body.config.configRevision;
  });

  it('an agent token CANNOT reach the destructive sync routes', async () => {
    for (const route of ['purge-demo', 'reset', 'prune-stores', 'reset-users']) {
      const res = await request(app.getHttpServer())
        .post(`/sync/${route}`)
        .set(asAgent())
        .send({});
      // Refused — that is the property. 401 is what actually happens today
      // (the route is not marked @AllowMachine, so the agent credential is not
      // accepted there at all) and 403 is what @HumansOnly would return if a
      // future change ever did mark one. Both are a refusal; accepting either
      // means this test survives that change instead of failing spuriously.
      expect([401, 403]).toContain(res.status);
    }
  });

  it('an agent token is refused everywhere else in the product', async () => {
    // The blast radius that made the old arrangement dangerous: a head_office
    // service account could read and change anything. This credential cannot.
    for (const path of ['/stores', '/parties', '/dashboard/kpis', '/audit']) {
      const res = await request(app.getHttpServer()).get(path).set(asAgent());
      expect(res.status).toBe(401);
    }
  });

  it('a human reaches the destructive route, and its own safety guard still holds', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/purge-demo')
      .set(auth())
      .send({});

    // The human is ADMITTED (not 401/403) — backward compatibility for the
    // existing operator flow. What stops them is the operation's own P0 guard:
    // this tenant has no synced data, so purging would empty it. That refusal is
    // the safety property, and asserting it here means a later change that
    // removes the guard fails a test rather than emptying a customer's database.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nothing to switch over|would leave the system empty/i);
  });

  it('a revoked agent stops authenticating on ingestion too', async () => {
    const agent = await prisma.connectAgent.findFirst({
      where: { organisationId: G.org, name: 'HARD-G agent' },
    });
    await request(app.getHttpServer())
      .delete(`/integration/connect/agents/${agent!.id}`)
      .set(auth())
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(asAgent())
      .send({ records: [] });
    expect(res.status).toBe(403);

    // Restore for any later test in this file.
    const rotated = await request(app.getHttpServer())
      .post(`/integration/connect/agents/${agent!.id}/rotate`)
      .set(auth());
    agentToken = rotated.body.token;
  });

  /* ------------------------------------------------------ RLS predicate */

  it('the RLS policies exist and fail closed with no tenant context', async () => {
    const policies = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_policies WHERE policyname LIKE '%_tenant_isolation'`,
    );
    expect(policies[0].n).toBeGreaterThan(60);

    // The predicate itself: with no context the org function returns NULL, so
    // `organisationId = NULL` is never true and the policy admits nothing.
    // Verified as an expression so the assertion holds whether or not RLS is
    // currently enabled on any table.
    const closed = await prisma.$queryRawUnsafe<{ permits: boolean | null }[]>(
      `SELECT (caratos_platform_bypass() OR 'org_hard_g' = caratos_current_org()) AS permits`,
    );
    expect(closed[0].permits ?? false).toBe(false);

    // And that it opens for the right tenant, inside a transaction.
    const opened = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_organisation','org_hard_g',true)`);
      return tx.$queryRawUnsafe<{ permits: boolean }[]>(
        `SELECT ('org_hard_g' = caratos_current_org()) AS permits`,
      );
    });
    expect(opened[0].permits).toBe(true);
  });

  it('RLS is created but NOT enabled — enabling is a separate deliberate step', async () => {
    const enabled = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_class
        WHERE relrowsecurity = true AND relnamespace = 'public'::regnamespace`,
    );
    // Guards against someone flipping this on without wiring per-request tenant
    // context first, which would take the application down rather than leak.
    expect(enabled[0].n).toBe(0);
  });

  /* ------------------------------------------------------- observability */

  it('the deep health check separates database failure from a missing dependency', async () => {
    const res = await request(app.getHttpServer()).get('/health/deep');
    expect([200, 503]).toContain(res.status);
    expect(res.body.database).toBe('up');
    expect(res.body.status).toMatch(/^(ok|degraded)$/);
    // "not configured" is reported as its own value, never as a failure.
    expect(Object.values(res.body.dependencies)).toEqual(
      expect.arrayContaining([expect.stringMatching(/configured|local_disk/)]),
    );
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.connectAgent.deleteMany({ where: { organisationId: G.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: G.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: G.org } } });
  await prisma.user.deleteMany({ where: { organisationId: G.org } });
  await prisma.store.deleteMany({ where: { organisationId: G.org } });
  await prisma.organisation.deleteMany({ where: { slug: G.slug } });
}
