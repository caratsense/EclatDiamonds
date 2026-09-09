import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoginDto } from '../src/auth/dto/login.dto';
import { GATED_CAPABILITIES } from '../src/config/entitlements';
import {
  PLATFORM_HANDLE_DOMAIN,
  handleBase,
  handleDomain,
  uniqueEmailHandle,
} from '../src/users/users.util';

/**
 * Multi-market phase 3 — the leaks that survive a rename.
 *
 * Phase 2 stopped a clinic SEEING a jeweller's product. Three things still tied
 * every tenant to one customer, and none of them go away when copy changes:
 *
 *   MM2-01  every staff login was minted at `@eclatdiamonds.in`, and a login
 *           handle is a stored credential, not a label;
 *   MM2-03/04  the CRM funnel had no ownership, so whichever of `ensure-default`
 *           and the industry pack ran first won permanently;
 *   item 5  the entitlement map listed what to block, so a vertical controller
 *           nobody classified was open to every industry.
 *
 * Two tenants throughout: a clinic created here, and the seeded Eclat
 * organisation, which must be able to do everything it could do before.
 */
const PASSWORD = 'password123';
const ECLAT_HO = 'head.office@caratsense.in';

const C = {
  org: 'org_mm3_clinic',
  store: 'store_mm3_clinic',
  slug: 'mm3-clinic',
  ho: 'ho@mm3-clinic.local',
};

/** A tenant that has never had a pack applied — a half-finished onboarding. */
const N = {
  org: 'org_mm3_nopack',
  store: 'store_mm3_nopack',
  slug: 'mm3-nopack',
  ho: 'ho@mm3-nopack.local',
};

/* ═══════════════════════════════ MM2-01 ═══════════════════════════════════ */

describe('login handles are tenant-scoped (MM2-01)', () => {
  /*
   * Pure, and deliberately so. A handle's shape is decided by one function; a
   * database is not needed to prove what it produces, and these run in
   * milliseconds so nobody is tempted to skip them.
   */

  it("keeps Eclat's own handles byte-for-byte", async () => {
    expect(handleDomain('eclat')).toBe('eclatdiamonds.in');
    const handle = await uniqueEmailHandle(
      'Shreyansh Kashyap',
      'MUMBAI BANDRA',
      'eclat',
      async () => false,
    );
    // Exactly the string this product has been minting since before it had a
    // second tenant. Anything else logs real people out on a Monday morning.
    expect(handle).toBe('shreyansh.mumbaibandra@eclatdiamonds.in');
  });

  it('never puts another tenant on that domain', async () => {
    const handle = await uniqueEmailHandle('Priya Nair', 'Andheri', 'sunrise-clinic', async () => false);
    expect(handle).toBe(`priya.andheri@sunrise-clinic.${PLATFORM_HANDLE_DOMAIN}`);
    expect(handle).not.toContain('eclatdiamonds');
  });

  it('uses a domain that can never receive mail, because a handle is not a mailbox', () => {
    // RFC 2606 reserves .invalid precisely so nothing resolves. If this ever
    // becomes a deliverable domain, someone has decided handles are addresses —
    // and the contact email, which IS an address, would have a rival.
    expect(PLATFORM_HANDLE_DOMAIN.endsWith('.invalid')).toBe(true);
  });

  it('gives two tenants different handles for the same person at the same branch', async () => {
    const one = await uniqueEmailHandle('Priya', 'Andheri', 'sunrise-clinic', async () => false);
    const two = await uniqueEmailHandle('Priya', 'Andheri', 'moonlight-clinic', async () => false);
    expect(one).not.toBe(two);
    // …and neither needed a collision suffix to get there. Tenant scoping makes
    // the clash structurally impossible rather than merely resolved.
    expect(one.startsWith('priya.andheri@')).toBe(true);
    expect(two.startsWith('priya.andheri@')).toBe(true);
  });

  it('still suffixes a genuine collision INSIDE one tenant', async () => {
    const taken = new Set([`priya.andheri@sunrise-clinic.${PLATFORM_HANDLE_DOMAIN}`]);
    const second = await uniqueEmailHandle('Priya', 'Andheri', 'sunrise-clinic', async (e) =>
      taken.has(e),
    );
    expect(second).toBe(`priya.andheri2@sunrise-clinic.${PLATFORM_HANDLE_DOMAIN}`);
  });

  it('keeps the branch in the local part, so one tenant’s branches stay distinct', () => {
    expect(handleBase('Priya', 'Andheri')).not.toBe(handleBase('Priya', 'Bandra'));
  });

  it('produces something the login form will actually accept', async () => {
    for (const slug of ['eclat', 'sunrise-clinic', 'a-very-long-tenant-name-indeed']) {
      const email = await uniqueEmailHandle('Priya', 'Andheri', slug, async () => false);
      const errors = await validate(plainToInstance(LoginDto, { email, password: PASSWORD }));
      // A handle no validator accepts is a handle nobody can sign in with, which
      // is the one failure mode that would not show up until a real Monday.
      expect(errors).toEqual([]);
    }
  });

  it('falls back to the bare platform root rather than minting an empty label', () => {
    expect(handleDomain(null)).toBe(PLATFORM_HANDLE_DOMAIN);
    expect(handleDomain('')).toBe(PLATFORM_HANDLE_DOMAIN);
    expect(handleDomain('   ')).toBe(PLATFORM_HANDLE_DOMAIN);
  });
});

/* ═══════════════════════════════ end-to-end ═══════════════════════════════ */

describe('Multi-market phase 3 — identity, funnel ownership, entitlement (e2e)', () => {
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

  let eclatStoreId: string;

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

    for (const t of [C, N]) {
      await prisma.organisation.create({
        data: {
          id: t.org,
          name: t === C ? 'MM3 Clinic' : 'MM3 Unconfigured',
          slug: t.slug,
          status: 'active',
          // N deliberately has NO industryPackCode: that is what "half-finished
          // onboarding" looks like in the database.
          ...(t === C ? { industryPackCode: 'healthcare', industryPackVersion: 2 } : {}),
        },
      });
      await prisma.store.create({
        data: { id: t.store, name: 'Andheri', city: 'Mumbai', organisationId: t.org },
      });
      await prisma.user.create({
        data: {
          email: t.ho,
          name: 'MM3 Head Office',
          role: 'head_office',
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: t.org,
          userStores: { create: { storeId: t.store, isPrimary: true } },
        },
      });
    }

    tokens.clinic = await login(C.ho);
    tokens.nopack = await login(N.ho);
    tokens.eclat = await login(ECLAT_HO);

    const eclatStore = await prisma.store.findFirst({
      where: { organisation: { slug: 'eclat' }, isAggregate: false },
      select: { id: true },
    });
    expect(eclatStore).toBeTruthy();
    eclatStoreId = eclatStore!.id;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------------------- MM2-01 */

  describe('a tenant’s staff are given that tenant’s handles', () => {
    it('mints a neutral handle for a clinic, and it can sign in with it', async () => {
      const created = await post('/users', tokens.clinic, {
        name: 'Priya Nair',
        phone: '9876543210',
        email: 'priya.personal@gmail.com',
        storeId: C.store,
      });
      expect(created.status).toBe(201);

      const handle: string = created.body.email;
      expect(handle).toBe(`priya.andheri@${C.slug}.${PLATFORM_HANDLE_DOMAIN}`);
      expect(handle).not.toContain('eclatdiamonds');

      // The personal address is kept, and kept SEPARATE — it is not the login,
      // and the login has not quietly become an address.
      const row = await prisma.user.findUnique({ where: { email: handle } });
      expect(row!.contactEmail).toBe('priya.personal@gmail.com');
      expect(row!.email).not.toBe(row!.contactEmail);

      // And the handle genuinely works as a credential. (A manager-added account
      // gets a random password; the person would use an OTP or a reset. Setting
      // one here is the only way to test the sign-in path itself.)
      await prisma.user.update({
        where: { id: row!.id },
        data: { passwordHash: await bcrypt.hash(PASSWORD, 10) },
      });
      const session = await login(handle);
      expect(session).toBeTruthy();
    });

    it('still mints @eclatdiamonds.in inside Eclat’s own organisation', async () => {
      const created = await post('/users', tokens.eclat, {
        name: 'Mm3probe Verify',
        phone: '9876500011',
        email: 'mm3probe@example.com',
        storeId: eclatStoreId,
      });
      expect(created.status).toBe(201);
      expect(created.body.email).toMatch(/^mm3probe\.[a-z0-9]+@eclatdiamonds\.in$/);
    });

    it('re-issues a neutral handle when an approver moves a signup to another branch', async () => {
      // A second clinic branch, and a pending self-signup pointed at the first.
      const second = await prisma.store.create({
        data: { name: 'Bandra', city: 'Mumbai', organisationId: C.org },
      });
      const pending = await prisma.user.create({
        data: {
          email: `arjun.andheri@${C.slug}.${PLATFORM_HANDLE_DOMAIN}`,
          name: 'Arjun Mehta',
          role: 'salesperson',
          passwordHash: await bcrypt.hash(PASSWORD, 10),
          isActive: false,
          approvalStatus: 'pending',
          organisationId: C.org,
          requestedRole: 'salesperson',
          requestedStoreId: C.store,
        },
      });

      const approved = await post(`/users/${pending.id}/approve`, tokens.clinic, {
        storeId: second.id,
      });
      expect(approved.status).toBe(201);
      // The branch moved, so the handle moved with it — and it is still this
      // tenant's domain, not the one the generator used to hardcode.
      expect(approved.body.email).toBe(`arjun.bandra@${C.slug}.${PLATFORM_HANDLE_DOMAIN}`);
    });
  });

  /* --------------------------------------------------------- MM2-03/04 */

  describe('ensureDefault and the industry pack converge, in either order', () => {
    const expected = {
      inquiry: 'Patient enquiry',
      quotation: 'Appointment proposed',
      order_placed: 'Appointment confirmed',
    };

    it('ensure-default FIRST, then the pack', async () => {
      await clearFunnel(prisma, C.org);
      expect((await post('/crm/pipelines/ensure-default', tokens.clinic)).status).toBe(201);
      expect((await post('/config/packs/apply', tokens.clinic, { packCode: 'healthcare' })).status).toBe(201);
      await expectHealthcareFunnel(prisma, expected);
    });

    it('the pack FIRST, then ensure-default', async () => {
      await clearFunnel(prisma, C.org);
      expect((await post('/config/packs/apply', tokens.clinic, { packCode: 'healthcare' })).status).toBe(201);
      const ensured = await post('/crm/pipelines/ensure-default', tokens.clinic);
      expect(ensured.status).toBe(201);
      // Nothing to create: the pack's funnel is already the default.
      expect(ensured.body.created).toBe(false);
      await expectHealthcareFunnel(prisma, expected);
    });

    it('starts an organisation with no industry on a funnel the product owns, not the tenant', async () => {
      await clearFunnel(prisma, N.org);
      expect((await post('/crm/pipelines/ensure-default', tokens.nopack)).status).toBe(201);
      const stages = await funnel(prisma, N.org);
      expect(stages.map((s) => s.label)).toEqual(['Inquiry', 'Quotation', 'Order placed']);
      // `_system`, not NULL. NULL would mean "a human wrote this", and a pack
      // applied tomorrow would then be obliged to leave generic English in place
      // for ever — which is the exact bug MM2-04 reported.
      for (const stage of stages) expect(stage.packCode).toBe('_system');
    });

    it('lets a later pack replace that starter wording, but never a tenant edit', async () => {
      await clearFunnel(prisma, N.org);
      expect((await post('/crm/pipelines/ensure-default', tokens.nopack)).status).toBe(201);

      // The tenant renames one stage before choosing an industry.
      const before = await funnel(prisma, N.org);
      const middle = before.find((s) => s.code === 'quotation')!;
      const renamed = await post(`/crm/pipelines/${middle.pipelineId}/stages`, tokens.nopack, {
        code: middle.code,
        label: 'Our own middle step',
        sortOrder: middle.sortOrder,
        outcome: middle.outcome,
        systemValue: middle.systemValue ?? undefined,
        probability: middle.probability ?? undefined,
      });
      expect(renamed.status).toBe(201);

      expect((await post('/config/packs/apply', tokens.nopack, { packCode: 'healthcare' })).status).toBe(201);
      const after = Object.fromEntries((await funnel(prisma, N.org)).map((s) => [s.code, s.label]));
      expect(after.inquiry).toBe(expected.inquiry);
      expect(after.order_placed).toBe(expected.order_placed);
      expect(after.quotation).toBe('Our own middle step');
    });

    it('never leaves a second default funnel behind', async () => {
      const pipelines = await prisma.pipeline.findMany({
        where: { organisationId: C.org, entity: 'lead' },
      });
      expect(pipelines.filter((p) => p.isDefault)).toHaveLength(1);
      expect(pipelines).toHaveLength(1);
    });

    it('gives Eclat its own funnel, worded exactly as it always was', async () => {
      const eclat = await prisma.organisation.findUnique({
        where: { slug: 'eclat' },
        select: { id: true, industryPackCode: true },
      });
      expect(eclat!.industryPackCode).toBe('jewellery');
      const before = await prisma.pipeline.count({ where: { organisationId: eclat!.id } });

      const ensured = await post('/crm/pipelines/ensure-default', tokens.eclat);
      expect(ensured.status).toBe(201);

      const stages = await funnel(prisma, eclat!.id);
      // The words on Eclat's own board, unchanged. `ensureDefault` used to hand
      // every tenant the same generic "Sales pipeline / Inquiry"; now it asks the
      // organisation's industry, and for the jewellery vertical that is the same
      // funnel it has always shown.
      expect(stages.map((s) => s.label)).toEqual(['Enquiry', 'Quotation', 'Order placed']);
      expect(stages.map((s) => s.systemValue)).toEqual(['inquiry', 'quotation', 'order_placed']);
      expect(stages.map((s) => s.outcome)).toEqual(['open', 'open', 'won']);
      for (const stage of stages) expect(stage.packCode).toBe('jewellery');

      // And exactly one funnel, whether or not it already had one.
      expect(await prisma.pipeline.count({ where: { organisationId: eclat!.id } }))
        .toBe(Math.max(before, 1));

      // Put Eclat back the way this test found it.
      if (before === 0) await clearFunnel(prisma, eclat!.id);
    });
  });

  /* ------------------------------------------------------------- item 5 */

  describe('every vertical family is refused, and the registry says which', () => {
    /**
     * One probe path per gated capability. The assertion below that this table
     * COVERS the registry is the point: adding a vertical module without a probe
     * fails here, so the 403 matrix cannot silently stop covering the product.
     */
    const PROBES: [string, string][] = [
      ['/finance/summary', 'finance'],
      ['/loyalty/plans', 'loyalty'],
      ['/returns', 'returns'],
      ['/discounts', 'discounts'],
      ['/quotes', 'quotation'],
      ['/stock', 'inventory'],
      ['/stock-transfers', 'stock-transfers'],
      ['/payments', 'payments'],
      ['/marketing/campaigns', 'marketing'],
      ['/tickets', 'ticketing'],
      ['/requests', 'requests'],
      ['/reporting/dsr', 'reporting'],
      ['/dashboard/kpis', 'dashboards'],
      ['/targets', 'settings/targets'],
      ['/new-store/projects', 'new-store'],
      ['/integrations/gold-rate', 'settings/rates'],
    ];

    it('probes every capability the registry can demand', () => {
      expect(new Set(PROBES.map(([, c]) => c))).toEqual(new Set(GATED_CAPABILITIES));
    });

    it.each(PROBES)('refuses %s to a clinic', async (path) => {
      const r = await get(path, tokens.clinic);
      expect(r.status).toBe(403);
    });

    it.each(PROBES)('refuses %s to an organisation with no industry at all', async (path) => {
      const r = await get(path, tokens.nopack);
      expect(r.status).toBe(403);
    });

    it.each(PROBES)('still answers %s for Eclat', async (path) => {
      const r = await get(path, tokens.eclat);
      expect(r.status).not.toBe(403);
    });

    it('gates the order timeline with the quotation module it is reached from', async () => {
      expect((await get('/timelines/orders', tokens.clinic)).status).toBe(403);
      expect((await get('/timelines/orders', tokens.eclat)).status).not.toBe(403);
    });

    it('keeps the universal suite open to a tenant with no industry', async () => {
      for (const path of [
        '/config/bootstrap',
        '/products',
        '/checkins',
        '/hrms/attendance',
        '/crm/customers',
        '/parties',
        '/stores',
        '/users',
        '/notifications',
        '/audit',
      ]) {
        const r = await get(path, tokens.nopack);
        // Fail-closed on a vertical module must not become fail-closed on the
        // product. An unconfigured tenant still has everything universal.
        expect(r.status).not.toBe(403);
      }
    });

    it('names the module in the refusal, not the URL', async () => {
      const r = await get('/finance/summary', tokens.clinic);
      expect(r.body.message).toContain('finance');
      expect(r.body.message).toMatch(/industry/i);
    });
  });
});

/** The organisation's default lead funnel, in display order. */
async function funnel(prisma: PrismaService, organisationId: string) {
  const pipeline = await prisma.pipeline.findFirst({
    where: { organisationId, entity: 'lead', isDefault: true },
    select: { stages: { orderBy: { sortOrder: 'asc' } } },
  });
  return pipeline?.stages ?? [];
}

async function expectHealthcareFunnel(prisma: PrismaService, expected: Record<string, string>) {
  const stages = await funnel(prisma, C.org);
  expect(Object.fromEntries(stages.map((s) => [s.code, s.label]))).toEqual(expected);
  // Owned by the pack, so a later industry change can still move them.
  for (const stage of stages) expect(stage.packCode).toBe('healthcare');
}

async function clearFunnel(prisma: PrismaService, organisationId: string) {
  await prisma.pipelineStage.deleteMany({ where: { organisationId } });
  await prisma.pipeline.deleteMany({ where: { organisationId } });
}

async function teardown(prisma: PrismaService) {
  const orgs = [C.org, N.org];
  await prisma.auditLog.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.pipelineStage.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.pipeline.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.fieldPolicy.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.attributeDefinition.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.taxonomyTerm.updateMany({
    where: { organisationId: { in: orgs } },
    data: { parentId: null },
  });
  await prisma.taxonomyTerm.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: { in: orgs } } } });
  await prisma.user.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.store.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { slug: { in: [C.slug, N.slug] } } });

  // The probe added to Eclat's own organisation, and nothing else of theirs.
  const probes = await prisma.user.findMany({
    where: { email: { startsWith: 'mm3probe.' } },
    select: { id: true },
  });
  if (probes.length) {
    const ids = probes.map((p) => p.id);
    await prisma.userStore.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}
