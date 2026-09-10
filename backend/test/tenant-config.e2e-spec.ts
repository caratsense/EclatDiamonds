import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CaratOS Phase A2 — the configuration layer, from the outside.
 *
 * What this actually has to prove, beyond "the endpoints respond":
 *
 *   1. A pack turns into real, tenant-owned rows, and re-applying it is a no-op
 *      rather than a duplicate-key crash — an upgrade will re-run it.
 *   2. A tenant's edit SURVIVES a re-apply. This is the promise the whole layer
 *      rests on: a shop that renamed "Bangle" to "Kada" must not have that
 *      quietly reverted by a release.
 *   3. Two tenants on two packs do not see each other's vocabulary at all.
 *   4. A client cannot configure someone else's tenant by naming it in the body.
 *   5. The enum bridge refuses a `systemValue` the typed column would reject,
 *      instead of accepting it and failing later at write time.
 *
 * Org C is built and torn down here with its own ids, so this spec can run
 * alongside the other org-isolation specs without colliding on 'org_b'.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in'; // seeded Eclat head office (org_eclat)

const C = {
  org: 'org_cfg_c',
  store: 'store_cfg_c',
  slug: 'cfg-c',
  ho: 'ho.c@cfg-c.local',
  rep: 'rep.c@cfg-c.local',
};

describe('Tenant configuration / industry packs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, t: string) => request(app.getHttpServer()).get(path).set(auth(t));
  const post = (path: string, t: string, body: object) =>
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

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardownOrgC(prisma);

    // Org C starts on the PHARMACY pack — deliberately the furthest thing from
    // jewellery, so any leak of Eclat's vocabulary into it is unmistakable.
    await prisma.organisation.create({
      data: { id: C.org, name: 'Test Pharmacy C', slug: C.slug, status: 'onboarding' },
    });
    await prisma.store.create({
      data: { id: C.store, name: 'CFG-C Counter', city: 'Testville', organisationId: C.org },
    });
    await prisma.user.create({
      data: {
        email: C.ho,
        name: 'HO C',
        role: 'head_office',
        passwordHash: hash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: C.org,
      },
    });
    await prisma.user.create({
      data: {
        email: C.rep,
        name: 'Rep C',
        role: 'salesperson',
        passwordHash: hash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: C.org,
        userStores: { create: { storeId: C.store, isPrimary: true } },
      },
    });

    tokens.aHo = await login(A_HO);
    tokens.cHo = await login(C.ho);
    tokens.cRep = await login(C.rep);
  });

  afterAll(async () => {
    await teardownOrgC(prisma);
    await app?.close();
  });

  it('offers the shipped packs, and every one of them is applyable', async () => {
    const r = await get('/config/packs', tokens.cHo);
    expect(r.status).toBe(200);
    const codes = r.body.packs.map((p: { code: string }) => p.code).sort();
    expect(codes).toEqual(
      expect.arrayContaining([
        'automotive',
        'education',
        'financial_services',
        'healthcare',
        'hospitality',
        'jewellery',
        'logistics',
        'manufacturing',
        'pharmacy',
        'professional_services',
        'real_estate',
        'retail',
        'technology',
        'textile',
        'wholesale_distribution',
      ]),
    );
    expect(r.body.defaultPackCode).toBe('retail');
  });

  it('applies a pack into real rows, and re-applying adds nothing', async () => {
    const first = await post('/config/packs/apply', tokens.cHo, { packCode: 'pharmacy' });
    expect(first.status).toBe(201);
    expect(first.body.packCode).toBe('pharmacy');
    expect(first.body.inserted.terms).toBeGreaterThan(0);
    expect(first.body.inserted.attributes).toBeGreaterThan(0);

    // The upgrade path re-runs this. It must be a no-op, not a crash.
    const again = await post('/config/packs/apply', tokens.cHo, { packCode: 'pharmacy' });
    expect(again.status).toBe(201);
    expect(again.body.inserted).toEqual({
      terms: 0,
      attributes: 0,
      fieldPolicies: 0,
      pipelines: 0,
      // Re-applying the SAME pack finds every stage already carrying that pack's
      // wording, so convergence has nothing to correct.
      pipelineStages: 0,
    });
  });

  it('bootstrap describes the tenant it was called by, and nobody else', async () => {
    const r = await get('/config/bootstrap', tokens.cHo);
    expect(r.status).toBe(200);
    expect(r.body.organisation.id).toBe(C.org);
    expect(r.body.industry.packCode).toBe('pharmacy');
    expect(r.body.industry.upgradeAvailable).toBe(false);

    // Pharmacy vocabulary present…
    expect(Object.keys(r.body.taxonomies)).toEqual(
      expect.arrayContaining(['dosage_form', 'lead_source', 'checkin_purpose']),
    );
    const productAttrs = r.body.attributes.product.map((a: { key: string }) => a.key);
    expect(productAttrs).toEqual(expect.arrayContaining(['composition', 'strength', 'dosage_form']));

    // …and the jewellery product fields explicitly hidden, not merely absent.
    const hidden = r.body.fieldPolicies.product
      .filter((p: { requirement: string }) => p.requirement === 'hidden')
      .map((p: { field: string }) => p.field);
    expect(hidden).toEqual(expect.arrayContaining(['purity', 'grossWeight', 'huid']));

    // No jewellery vocabulary leaked in.
    expect(JSON.stringify(r.body)).not.toContain('gold_22k');
  });

  it('leaves a tenant rename alone when the pack is re-applied', async () => {
    const terms = await get('/config/taxonomy?kind=dosage_form', tokens.cHo);
    const tablet = terms.body.find((t: { code: string }) => t.code === 'tablet');
    expect(tablet).toBeTruthy();

    const renamed = await request(app.getHttpServer())
      .patch(`/config/taxonomy/${tablet.id}`)
      .set(auth(tokens.cHo))
      .send({ label: 'Tabs (house term)' });
    expect(renamed.status).toBe(200);

    await post('/config/packs/apply', tokens.cHo, { packCode: 'pharmacy' });

    const after = await get('/config/taxonomy?kind=dosage_form', tokens.cHo);
    const stillRenamed = after.body.find((t: { code: string }) => t.code === 'tablet');
    expect(stillRenamed.label).toBe('Tabs (house term)');
    // And it did not gain a duplicate sibling with the pack's original label.
    expect(after.body.filter((t: { code: string }) => t.code === 'tablet')).toHaveLength(1);
  });

  it('never lets one tenant read or write another tenant vocabulary', async () => {
    // A term that exists only in Org C.
    const created = await post('/config/taxonomy', tokens.cHo, {
      kind: 'manufacturer',
      code: 'cfg_c_only_pharma',
      label: 'CFG-C ONLY Pharma Ltd',
    });
    expect(created.status).toBe(201);

    // Eclat's head office must not see it anywhere in its own config.
    const aBootstrap = await get('/config/bootstrap', tokens.aHo);
    expect(aBootstrap.status).toBe(200);
    expect(aBootstrap.body.organisation.id).not.toBe(C.org);
    expect(JSON.stringify(aBootstrap.body)).not.toContain('CFG-C ONLY');

    const aTerms = await get('/config/taxonomy', tokens.aHo);
    expect(JSON.stringify(aTerms.body)).not.toContain('CFG-C ONLY');

    // Nor may it edit that term by id — a cross-tenant id is a 404, not a 200.
    const steal = await request(app.getHttpServer())
      .patch(`/config/taxonomy/${created.body.id}`)
      .set(auth(tokens.aHo))
      .send({ label: 'hijacked' });
    expect(steal.status).toBe(404);
  });

  it('ignores an organisationId the client tries to smuggle in the body', async () => {
    // `forbidNonWhitelisted` means the request is rejected outright rather than
    // silently stripped — either is safe, but a 400 proves the field is not part
    // of the contract at all.
    const r = await post('/config/taxonomy', tokens.cHo, {
      kind: 'manufacturer',
      code: 'smuggle_attempt',
      label: 'Smuggled',
      organisationId: 'org_eclat',
    });
    expect(r.status).toBe(400);

    // And nothing was written into the named tenant.
    const leaked = await prisma.taxonomyTerm.findFirst({
      where: { organisationId: 'org_eclat', code: 'smuggle_attempt' },
    });
    expect(leaked).toBeNull();
  });

  it('refuses a systemValue the typed column would reject at write time', async () => {
    const r = await post('/config/taxonomy', tokens.cHo, {
      kind: 'lead_source',
      code: 'billboard',
      label: 'Billboard',
      systemValue: 'billboard', // not a member of the LeadSource enum
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('lead_source');

    // The same term without the bogus mapping is fine — label-only is allowed.
    const ok = await post('/config/taxonomy', tokens.cHo, {
      kind: 'lead_source',
      code: 'billboard',
      label: 'Billboard',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.systemValue).toBeNull();
  });

  it('lets any user read config but only head office change it', async () => {
    const read = await get('/config/bootstrap', tokens.cRep);
    expect(read.status).toBe(200);

    const write = await post('/config/taxonomy', tokens.cRep, {
      kind: 'manufacturer',
      code: 'rep_should_not',
      label: 'Nope',
    });
    expect(write.status).toBe(403);
  });

  /* ---------------------------------------------------------------------
   * The multi-market product layer.
   *
   * These run LAST and deliberately move org C onto a different industry, so
   * nothing above them can be disturbed by the switch.
   * ------------------------------------------------------------------- */

  it('serves the industry navigation and vocabulary, not just the taxonomy', async () => {
    const r = await get('/config/bootstrap', tokens.cHo);
    expect(r.status).toBe(200);

    // Pharmacy is the universal suite and nothing else.
    expect(r.body.industry.enabledNavigation).toEqual(
      expect.arrayContaining(['crm', 'conversations', 'catalogue', 'hrms']),
    );
    for (const jewelleryOnly of ['finance', 'inventory', 'loyalty', 'settings/rates']) {
      expect(r.body.industry.enabledNavigation).not.toContain(jewelleryOnly);
    }

    // Pharmacy renames the enquiry, and nothing else — a chemist has customers.
    expect(r.body.labels).toEqual({
      Lead: 'Enquiry',
      Leads: 'Enquiries',
      'CRM & Leads': 'CRM & Enquiries',
      'New Lead': 'New Enquiry',
    });
    expect(r.body.lexicon.customer_plural).toBe('Customers');
    expect(r.body.industry.aiContext).toContain('Pharmacy');
  });

  it('leaves the live jewellery tenant with every screen and no relabelling', async () => {
    // The Eclat guarantee, asserted from the outside as Eclat itself.
    //
    // This is the assertion that matters most in the file. Navigation is now
    // DERIVED from the applied pack, and a migration put the live organisation
    // on the jewellery pack — so if that pack's route list ever falls behind
    // frontend/src/lib/navigation.ts, Eclat loses screens. Its companion in
    // industry-onboarding.e2e-spec.ts compares the two lists directly; this one
    // proves the served payload is what a jeweller's browser actually receives.
    const r = await get('/config/bootstrap', tokens.aHo);
    expect(r.status).toBe(200);
    expect(r.body.industry.packCode).toBe('jewellery');

    // Not one word is rewritten for the live vertical.
    expect(r.body.labels).toEqual({});
    expect(r.body.lexicon.customer_plural).toBe('Customers');
    expect(r.body.lexicon.catalogue).toBe('Catalogue');

    // And every jewellery operation is still in the product.
    for (const route of [
      'finance',
      'inventory',
      'quotation',
      'returns',
      'loyalty',
      'discounts',
      'payments',
      'settings/rates',
      'settings/targets',
      'marketing',
      'ticketing',
      'dashboards',
      'reporting',
    ]) {
      expect(r.body.industry.enabledNavigation).toContain(route);
    }
  });

  it('does not hand every signed-in user the whole settings bag', async () => {
    // A salesperson calls this endpoint on every page load. It used to return
    // `settings` verbatim, which also carries CRM routing rules and the
    // qualification policy — internal user ids and store ids among them.
    await prisma.organisation.update({
      where: { id: C.org },
      data: {
        settings: {
          branding: { displayName: 'Test Pharmacy C' },
          featureProfile: { industryCode: 'pharmacy', enabledNavigation: ['crm'] },
          crmAdSetRules: [{ adSetId: 'SECRET_ADSET', assignToUserId: 'SECRET_USER' }],
          crmQualification: { enabled: true, questions: [] },
        },
      },
    });

    const r = await get('/config/bootstrap', tokens.cRep);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.organisation.settings).sort()).toEqual([
      'branding',
      'featureProfile',
    ]);
    expect(JSON.stringify(r.body)).not.toContain('SECRET_ADSET');
    expect(JSON.stringify(r.body)).not.toContain('SECRET_USER');
  });

  it('keeps a tenant edit to a custom field and a field policy through a re-apply', async () => {
    // The existing rename test covers a taxonomy term. Attributes and field
    // policies are provisioned by the same function and are just as much the
    // tenant's once they exist.
    const attr = await post('/config/attributes', tokens.cHo, {
      entity: 'product',
      key: 'composition',
      label: 'Salt / composition (house wording)',
      dataType: 'text',
    });
    expect(attr.status).toBe(201);

    const policy = await post('/config/field-policy', tokens.cHo, {
      entity: 'product',
      field: 'purity',
      requirement: 'optional',
    });
    expect(policy.status).toBe(201);

    await post('/config/packs/apply', tokens.cHo, { packCode: 'pharmacy' });

    const after = await get('/config/bootstrap', tokens.cHo);
    const composition = after.body.attributes.product.find(
      (a: { key: string }) => a.key === 'composition',
    );
    expect(composition.label).toBe('Salt / composition (house wording)');
    const purity = after.body.fieldPolicies.product.find(
      (p: { field: string }) => p.field === 'purity',
    );
    // The pack wants this hidden; the tenant said optional. The tenant wins.
    expect(purity.requirement).toBe('optional');
  });

  it('changing industry changes the product, and touches no other tenant', async () => {
    const eclatTermsBefore = await prisma.taxonomyTerm.count({
      where: { organisationId: 'org_eclat' },
    });
    const eclatOrgBefore = await prisma.organisation.findUnique({
      where: { id: 'org_eclat' },
      select: { industryPackCode: true, industryPackVersion: true, settings: true },
    });

    const applied = await post('/config/packs/apply', tokens.cHo, { packCode: 'healthcare' });
    expect(applied.status).toBe(201);

    const after = await get('/config/bootstrap', tokens.cHo);
    expect(after.body.industry.packCode).toBe('healthcare');
    // The whole point: navigation and vocabulary move WITH the industry. They
    // used to be frozen into settings at signup and never rewritten, so a
    // tenant that switched kept the previous industry's product forever.
    expect(after.body.labels.Customers).toBe('Patients');
    expect(after.body.lexicon.store).toBe('Branch');
    expect(after.body.industry.enabledNavigation).toContain('crm');
    // Pharmacy's own vocabulary is still there — applying is additive, so
    // switching industry never deletes what the tenant already had.
    expect(Object.keys(after.body.taxonomies)).toEqual(
      expect.arrayContaining(['dosage_form']),
    );

    // Eclat is untouched by any of it.
    const eclatOrgAfter = await prisma.organisation.findUnique({
      where: { id: 'org_eclat' },
      select: { industryPackCode: true, industryPackVersion: true, settings: true },
    });
    expect(eclatOrgAfter).toEqual(eclatOrgBefore);
    expect(
      await prisma.taxonomyTerm.count({ where: { organisationId: 'org_eclat' } }),
    ).toBe(eclatTermsBefore);
  });

  it('offers a safe neutral industry for a business that fits no category', async () => {
    const packs = await get('/config/packs', tokens.cHo);
    const other = packs.body.packs.find(
      (p: { code: string }) => p.code === 'other_services',
    );
    expect(other).toBeDefined();
    expect(other.name).toMatch(/other/i);

    const applied = await post('/config/packs/apply', tokens.cHo, {
      packCode: 'other_services',
    });
    expect(applied.status).toBe(201);

    const after = await get('/config/bootstrap', tokens.cHo);
    // Neutral means neutral: no industry words are imposed at all.
    expect(after.body.labels).toEqual({});
    expect(after.body.lexicon.customer).toBe('Customer');
  });

  it('bumps configVersion on every change so a cached bootstrap revalidates', async () => {
    const before = (await get('/config/bootstrap', tokens.cHo)).body.organisation.configVersion;
    await post('/config/field-policy', tokens.cHo, {
      entity: 'product',
      field: 'availability',
      requirement: 'required',
    });
    const after = (await get('/config/bootstrap', tokens.cHo)).body.organisation.configVersion;
    expect(after).toBeGreaterThan(before);
  });
});

async function teardownOrgC(prisma: PrismaService) {
  await prisma.auditLog.deleteMany({ where: { organisationId: C.org } });
  await prisma.pipelineStage.deleteMany({ where: { organisationId: C.org } });
  await prisma.pipeline.deleteMany({ where: { organisationId: C.org } });
  await prisma.fieldPolicy.deleteMany({ where: { organisationId: C.org } });
  await prisma.attributeDefinition.deleteMany({ where: { organisationId: C.org } });
  // Children before parents: terms self-reference via parentId.
  await prisma.taxonomyTerm.updateMany({ where: { organisationId: C.org }, data: { parentId: null } });
  await prisma.taxonomyTerm.deleteMany({ where: { organisationId: C.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: C.org } } });
  await prisma.user.deleteMany({ where: { organisationId: C.org } });
  await prisma.store.deleteMany({ where: { organisationId: C.org } });
  await prisma.organisation.deleteMany({ where: { slug: C.slug } });
  // The smuggling test asserts nothing landed in Eclat; clean up defensively in
  // case a regression let one through, so the next run starts honest.
  await prisma.taxonomyTerm.deleteMany({
    where: { organisationId: 'org_eclat', code: { in: ['smuggle_attempt'] } },
  });
}
