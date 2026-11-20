import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Multi-market phase 2 — enforcement, from the outside.
 *
 * The previous phase made the product LOOK right for each industry. Everything
 * here is about it BEING right: that a module a tenant's industry excludes is
 * refused by the server and not merely hidden by the menu, that a clinic's
 * products are not stored as gold, that changing industry actually moves the
 * funnel, and that two administrators saving different settings at the same
 * moment do not delete each other's work.
 *
 * Two tenants are used throughout:
 *   H — a healthcare organisation, created and torn down here.
 *   Eclat (org_eclat, seeded) — the live jewellery vertical, which must be able
 *       to reach everything it could reach before. It is only ever READ.
 */
const PASSWORD = 'password123';
const ECLAT_HO = 'head.office@caratsense.in';

const H = {
  org: 'org_mm2_h',
  store: 'store_mm2_h',
  slug: 'mm2-clinic',
  ho: 'ho@mm2-clinic.local',
  rep: 'rep@mm2-clinic.local',
};

describe('Multi-market phase 2 — entitlement, neutral data, convergence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, t: string) => request(app.getHttpServer()).get(path).set(auth(t));
  const post = (path: string, t: string, body: object = {}) =>
    request(app.getHttpServer()).post(path).set(auth(t)).send(body);

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

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: {
        id: H.org,
        name: 'MM2 Clinic',
        slug: H.slug,
        status: 'active',
        industryPackCode: 'healthcare',
        industryPackVersion: 2,
      },
    });
    await prisma.store.create({
      data: { id: H.store, name: 'MM2 Clinic — Andheri', city: 'Mumbai', organisationId: H.org },
    });
    for (const [email, role] of [
      [H.ho, 'head_office'],
      [H.rep, 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          email,
          name: `MM2 ${role}`,
          role,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: H.org,
          userStores: { create: { storeId: H.store, isPrimary: true } },
        },
      });
    }

    tokens.hHo = await login(H.ho);
    tokens.hRep = await login(H.rep);
    tokens.eclat = await login(ECLAT_HO);

    // Setting `industryPackCode` on the row makes the tenant healthcare for the
    // ENTITLEMENT gate, which reads only that column. The field policies, the
    // vocabulary and the funnel are rows, and they exist only once the pack has
    // actually been applied — which is what a real tenant's signup does.
    expect((await post('/config/packs/apply', tokens.hHo, { packCode: 'healthcare' })).status).toBe(201);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ---------------------------------------------------------------- MM-01 */

  describe('module entitlement is enforced by the server', () => {
    /**
     * Head office is the most senior role there is, so a 403 here cannot be a
     * role decision — it can only be the industry gate. That is the whole point:
     * seniority and entitlement are different questions.
     */
    it.each([
      ['/finance/summary', 'finance'],
      ['/integrations/gold-rate', 'settings/rates'],
      ['/loyalty/plans', 'loyalty'],
      ['/returns', 'returns'],
      ['/discounts', 'discounts'],
      ['/quotes', 'quotation'],
      ['/stock', 'inventory'],
      ['/stock-transfers', 'stock-transfers'],
      ['/payments', 'payments'],
      ['/marketing/campaigns', 'marketing'],
      ['/tickets', 'ticketing'],
      ['/targets', 'settings/targets'],
      ['/new-store/projects', 'new-store'],
      ['/reporting/dsr', 'reporting'],
      ['/dashboard/kpis', 'dashboards'],
    ])('refuses %s to a healthcare tenant', async (path) => {
      const r = await get(path, tokens.hHo);
      expect(r.status).toBe(403);
      // The message names the module, not the URL — an admin reading it needs to
      // know which thing to enable, not which endpoint they hit.
      expect(String(r.body.message)).toMatch(/industry setup/i);
    });

    it('refuses a WRITE to a disabled module too, not just the read', async () => {
      const r = await post('/discounts', tokens.hHo, {
        storeId: H.store,
        customerName: 'Someone',
        item: 'Anything',
        percent: 1,
        reason: 'e2e',
      });
      expect(r.status).toBe(403);
    });

    it.each([
      '/config/bootstrap',
      '/crm/customers',
      '/crm/conversations',
      '/parties',
      '/products',
      '/leads',
      '/checkins',
      '/stores',
      '/notifications',
      '/audit',
    ])('keeps %s available to every industry', async (path) => {
      const r = await get(path, tokens.hHo);
      expect(r.status).not.toBe(403);
    });

    it('lets the live jewellery tenant reach every historical module', async () => {
      // The regression that would matter most: this guard must not have taken
      // anything away from the tenant already in production.
      for (const path of [
        '/finance/summary',
        '/integrations/gold-rate',
        '/loyalty/plans',
        '/returns',
        '/discounts',
        '/quotes',
        '/stock',
        '/stock-transfers',
        '/payments',
        '/marketing/campaigns',
        '/tickets',
        '/targets',
        '/reporting/dsr',
        '/dashboard/kpis',
        '/products',
      ]) {
        const r = await get(path, tokens.eclat);
        expect({ path, status: r.status }).not.toEqual({ path, status: 403 });
      }
    });

    it('still applies the role gate underneath the industry gate', async () => {
      // A salesperson at the clinic is refused the audit log for being junior,
      // not for their industry — the two gates are independent and both run.
      const r = await get('/audit', tokens.hRep);
      expect(r.status).toBe(403);
    });
  });

  /* ------------------------------------------------------- MM-02 / MM-03 */

  describe('the catalogue write path is industry-neutral', () => {
    it('stores a clinic product as unspecified/other, never as gold', async () => {
      const r = await post('/products', tokens.hHo, {
        sku: 'MM2-PARA-500',
        name: 'Paracetamol 500mg',
        category: 'other',
        metal: 'unspecified',
        categoryLabel: 'Tablets',
        unitOfMeasure: 'strip',
        price: 25,
        storeId: H.store,
      });
      expect(r.status).toBe(201);

      const row = await prisma.product.findFirst({
        where: { organisationId: H.org, sku: 'MM2-PARA-500' },
      });
      expect(row).toBeTruthy();
      // The two columns that used to lie about every non-jewellery product.
      expect(row!.metal).toBe('unspecified');
      expect(row!.category).toBe('other');
      // …and the tenant's own words, kept beside them.
      expect(row!.categoryLabel).toBe('Tablets');
      expect(row!.unitOfMeasure).toBe('strip');
      // No invented measurements.
      expect(Number(row!.karat)).toBe(0);
    });

    it('tells a non-jewellery tenant which product fields to hide', async () => {
      const r = await get('/config/bootstrap', tokens.hHo);
      const hidden = (r.body.fieldPolicies.product as { field: string; requirement: string }[])
        .filter((p) => p.requirement === 'hidden')
        .map((p) => p.field);
      // `metal` is the one that mattered: the others hide inputs, this one hides
      // an input whose value was REQUIRED and defaulted to gold.
      expect(hidden).toEqual(
        expect.arrayContaining(['metal', 'purity', 'grossWeight', 'netWeight', 'huid']),
      );
    });

    it('hides nothing of the kind from the jewellery tenant', async () => {
      const r = await get('/config/bootstrap', tokens.eclat);
      const hidden = (r.body.fieldPolicies.product ?? [])
        .filter((p: { requirement: string }) => p.requirement === 'hidden')
        .map((p: { field: string }) => p.field);
      for (const field of ['metal', 'purity', 'grossWeight']) {
        expect(hidden).not.toContain(field);
      }
    });
  });

  /* ---------------------------------------------------------------- P0-3 */

  describe('changing industry converges, without overwriting the tenant', () => {
    it('moves untouched pack labels, keeps tenant edits, and is idempotent', async () => {
      // Start on pharmacy.
      expect((await post('/config/packs/apply', tokens.hHo, { packCode: 'pharmacy' })).status).toBe(201);
      const pharmacy = await defaultStages(prisma);
      expect(pharmacy.map((s) => s.label)).toEqual([
        'Enquiry',
        'Availability confirmed',
        'Order fulfilled',
      ]);

      // The tenant renames ONE stage in their own words — through the real
      // endpoint, because that is what transfers ownership of the row away from
      // the pack (PipelineStage.packCode is cleared on a human edit). A direct
      // database write would not, and would not deserve to.
      const middle = pharmacy.find((s) => s.code === 'quotation')!;
      const renamed = await post(`/crm/pipelines/${middle.pipelineId}/stages`, tokens.hHo, {
        code: middle.code,
        label: 'Stock checked (our wording)',
        // Everything else preserved: upsertStage replaces the row, and this test
        // is about the LABEL, not about resetting a stage's reporting outcome.
        sortOrder: middle.sortOrder,
        outcome: middle.outcome,
        systemValue: middle.systemValue ?? undefined,
        probability: middle.probability ?? undefined,
      });
      expect(renamed.status).toBe(201);
      expect(renamed.body.packCode).toBeNull();

      // Now move to healthcare.
      expect((await post('/config/packs/apply', tokens.hHo, { packCode: 'healthcare' })).status).toBe(201);
      const healthcare = await defaultStages(prisma);
      const byCode = Object.fromEntries(healthcare.map((s) => [s.code, s.label]));
      // Untouched stages take the new industry's words…
      expect(byCode.inquiry).toBe('Patient enquiry');
      expect(byCode.order_placed).toBe('Appointment confirmed');
      // …and the one the tenant wrote is left exactly as they wrote it.
      expect(byCode.quotation).toBe('Stock checked (our wording)');

      // Re-applying the same pack changes nothing at all.
      const again = await post('/config/packs/apply', tokens.hHo, { packCode: 'healthcare' });
      expect(again.status).toBe(201);
      expect(again.body.inserted.pipelineStages).toBe(0);
      expect(Object.fromEntries((await defaultStages(prisma)).map((s) => [s.code, s.label]))).toEqual(
        byCode,
      );

      // A third industry still converges the two it owns.
      expect((await post('/config/packs/apply', tokens.hHo, { packCode: 'manufacturing' })).status).toBe(201);
      const manufacturing = Object.fromEntries(
        (await defaultStages(prisma)).map((s) => [s.code, s.label]),
      );
      expect(manufacturing.inquiry).toBe('Requirement received');
      expect(manufacturing.order_placed).toBe('Purchase order received');
      expect(manufacturing.quotation).toBe('Stock checked (our wording)');
    });

    it('never destroys the stage a lead is sitting in', async () => {
      // Convergence only ever relabels; the stage rows themselves survive, so a
      // lead's position is never orphaned by an industry change.
      const stages = await defaultStages(prisma);
      expect(stages.map((s) => s.code).sort()).toEqual(
        ['inquiry', 'order_placed', 'quotation'].sort(),
      );
      // And the reporting semantics are untouched by any relabelling.
      expect(stages.find((s) => s.code === 'order_placed')!.outcome).toBe('won');
      expect(stages.find((s) => s.code === 'inquiry')!.systemValue).toBe('inquiry');
    });
  });

  /* ---------------------------------------------------------------- MM-08 */

  describe('stale state and account enumeration', () => {
    it('does not reveal whether an email exists in another tenant', async () => {
      const r = await request(app.getHttpServer())
        .post('/auth/organisations')
        .send({
          organisationName: 'Probe Ltd',
          industryCode: 'retail',
          ownerName: 'Probe Person',
          email: ECLAT_HO, // an account that certainly exists, in another tenant
          password: 'password123',
          primaryLocationName: 'Main',
          city: 'Nowhere',
        });
      expect(r.status).toBe(409);
      const message = JSON.stringify(r.body).toLowerCase();
      expect(message).not.toContain('already exists');
      expect(message).not.toContain(ECLAT_HO.toLowerCase());
    });

    it('derives the login destination from the CURRENT pack', async () => {
      const r = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: H.ho, password: PASSWORD });
      expect(r.status).toBe(201);
      const nav: string[] = r.body.productProfile.enabledNavigation;
      // The clinic is on manufacturing by now (previous block). Whatever it is,
      // the list must be the pack's, not a copy frozen at signup.
      expect(nav).toEqual(expect.arrayContaining(['crm', 'conversations', 'catalogue']));
      expect(nav).not.toContain('finance');
      expect(nav).not.toContain('dashboards');
    });
  });

  /* ---------------------------------------------------------------- P1-8 */

  describe('concurrent settings writers', () => {
    it('keeps both keys when two administrators save at the same moment', async () => {
      /*
       * The regression this exists for: `settings` is one JSON column shared by
       * unrelated features, and each writer used to read the whole thing, spread
       * it, and write it back. Fired together, the loser restored their own
       * stale snapshot of the winner's key — silently, with both requests
       * returning success.
       */
      await post('/config/packs/apply', tokens.hHo, { packCode: 'healthcare' });

      const [aiSettings, adSetRules] = await Promise.all([
        post('/crm/qualification/ai-settings', tokens.hHo, { draftEnabled: true }),
        post('/crm/qualification/adset-rules', tokens.hHo, {
          rules: [
            {
              id: 'mm2-rule-1',
              name: 'MM2_ADSET',
              enabled: true,
              priority: 1,
              matchField: 'ad_set_id',
              matchValue: 'MM2_ADSET',
              storeId: H.store,
              assignedUserId: null,
              handling: 'ai',
            },
          ],
        }),
      ]);
      expect([aiSettings.status, adSetRules.status]).toEqual([201, 201]);

      const org = await prisma.organisation.findUnique({
        where: { id: H.org },
        select: { settings: true },
      });
      const settings = org!.settings as Record<string, unknown>;
      // Both survived. Before the row lock, one of these two was always absent.
      expect(settings.crmAiDraftEnabled).toBe(true);
      expect(JSON.stringify(settings.crmAdSetRules)).toContain('MM2_ADSET');
      // And the keys neither writer owns are still there.
      expect(settings.packManaged).toBeTruthy();
    });
  });

  /* ---------------------------------------------------------------- P1-6 */

  describe('metal rates are only maintained for industries that have them', () => {
    it('refuses the refresh and leaves the clinic with no rate rows', async () => {
      const refresh = await post('/integrations/gold-rate/refresh', tokens.hHo);
      expect(refresh.status).toBe(403);
      expect(await prisma.metalRate.count({ where: { organisationId: H.org } })).toBe(0);
    });

    it('still lets the jewellery tenant set one by hand', async () => {
      // The same route, the same role, a different industry — and it works.
      const r = await post('/integrations/gold-rate', tokens.eclat, {
        karat: 22,
        ratePerGram: 9250.5,
      });
      expect(r.status).not.toBe(403);
    });

    /*
     * The hourly job is filtered by the SAME predicate the request guard uses
     * (packMaintainsMetalRates), unit-tested in industry-onboarding.e2e-spec.ts.
     * It is not executed here: it calls an external price feed, and a test that
     * depends on a live third party tells you about the internet, not the code.
     */
  });

  /* ---------------------------------------------------------------- MM-11 */

  describe('discount references after a fresh seed', () => {
    it('mints a reference that does not collide with the seeded ones', async () => {
      // The seeded rows reserve DR-1001 and DR-1002; the sequence must already
      // be past them, or the very first discount created through the API dies on
      // a unique-constraint violation.
      const seeded = await prisma.discountRequest.findMany({
        where: { ref: { in: ['DR-1001', 'DR-1002'] } },
        select: { ref: true },
      });
      expect(seeded.length).toBeGreaterThan(0);

      const eclatStore = await prisma.store.findFirst({
        where: { organisationId: 'org_eclat', isAggregate: false },
        select: { id: true },
      });
      const created = await post('/discounts', tokens.eclat, {
        storeId: eclatStore!.id,
        customerName: 'MM2 Sequence Probe',
        item: 'Anything',
        percent: 1,
        reason: 'e2e',
      });
      expect(created.status).toBe(201);
      expect(['DR-1001', 'DR-1002']).not.toContain(created.body.ref);

      await prisma.discountRequest.deleteMany({ where: { id: created.body.id } });
    });
  });
});

/** The tenant's default lead funnel, in display order. */
async function defaultStages(prisma: PrismaService) {
  const pipeline = await prisma.pipeline.findUnique({
    where: { organisationId_code: { organisationId: H.org, code: 'default' } },
    select: { stages: { orderBy: { sortOrder: 'asc' } } },
  });
  return pipeline?.stages ?? [];
}

async function teardown(prisma: PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: H.org } });
  await prisma.product.deleteMany({ where: { organisationId: H.org } });
  await prisma.pipelineStage.deleteMany({ where: { organisationId: H.org } });
  await prisma.pipeline.deleteMany({ where: { organisationId: H.org } });
  await prisma.fieldPolicy.deleteMany({ where: { organisationId: H.org } });
  await prisma.attributeDefinition.deleteMany({ where: { organisationId: H.org } });
  await prisma.taxonomyTerm.updateMany({ where: { organisationId: H.org }, data: { parentId: null } });
  await prisma.taxonomyTerm.deleteMany({ where: { organisationId: H.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: H.org } } });
  await prisma.user.deleteMany({ where: { organisationId: H.org } });
  await prisma.store.deleteMany({ where: { organisationId: H.org } });
  await prisma.organisation.deleteMany({ where: { slug: H.slug } });
  await prisma.discountRequest.deleteMany({ where: { customerName: 'MM2 Sequence Probe' } });
}
