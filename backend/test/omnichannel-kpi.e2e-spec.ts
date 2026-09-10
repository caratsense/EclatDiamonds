import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The omnichannel headline numbers.
 *
 * The properties that matter here are the ones a chart makes easy to get wrong:
 *
 *   - every count is its own aggregate, so it stays right past the first page;
 *   - a branch manager's totals never include another branch, and no tenant's
 *     figures ever include another tenant's;
 *   - "not assessed" is null, not a donut of zeroes;
 *   - the intent labels are the TENANT's, not a hardcoded set.
 *
 * The pipe is configured exactly as `main.ts` configures it — including
 * `enableImplicitConversion` — because that option changes how a query string
 * is parsed, and a suite that omits it tests a server the tenant never runs.
 *
 * Seeded MANUFACTURING, so nothing here can quietly rely on the jewellery pack.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_kpi_a',
  slug: 'kpi-a',
  store: 'store_kpi_a',
  store2: 'store_kpi_a2',
  ho: 'ho.kpi@kpi-a.local',
  mgr: 'mgr.kpi@kpi-a.local',
};
const B = { org: 'org_kpi_b', slug: 'kpi-b', store: 'store_kpi_b', ho: 'ho.kpi@kpi-b.local' };

/** Above any plausible page size — a chart that pages its own source is the bug. */
const BULK_LEADS = 130;

describe('Omnichannel KPIs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let mgrToken: string;
  let otherTenantToken: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
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
      data: { id: A.org, name: 'Mill A', slug: A.slug, industryPackCode: 'manufacturing' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Plant One', city: 'Pune', organisationId: A.org },
    });
    await prisma.store.create({
      data: { id: A.store2, name: 'Plant Two', city: 'Nashik', organisationId: A.org },
    });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        email: A.mgr, name: 'Plant One Manager', role: 'store_manager', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });

    // A second tenant with its own everything. Nothing it owns may ever surface.
    await prisma.organisation.create({
      data: { id: B.org, name: 'Mill B', slug: B.slug, industryPackCode: 'manufacturing' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'Rival Plant', city: 'Surat', organisationId: B.org },
    });
    await prisma.user.create({
      data: {
        email: B.ho, name: 'Rival HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: B.org,
        userStores: { create: { storeId: B.store, isPrimary: true } },
      },
    });

    // --- tenant A, branch one -------------------------------------------------
    await prisma.party.create({
      data: {
        id: 'pty_kpi_1', organisationId: A.org, storeId: A.store,
        name: 'Vedant Kothari', phone: '+919820000001', types: ['customer'],
      },
    });
    await prisma.party.create({
      data: {
        id: 'pty_kpi_2', organisationId: A.org, storeId: A.store,
        name: 'Ashwini Rao', phone: '+919820000002', types: ['customer'],
      },
    });

    const SOURCES = ['meta_ads', 'whatsapp', 'instagram', 'website', 'walk_in'] as const;
    await prisma.lead.createMany({
      data: Array.from({ length: BULK_LEADS }, (_, i) => ({
        organisationId: A.org,
        storeId: A.store,
        customerName: `Buyer ${i}`,
        interest: 'Bearings',
        source: SOURCES[i % SOURCES.length],
        stage: 'inquiry' as const,
        ref: `LD-KPI-${i}`,
        outcome: i % 20 === 0 ? 'won' : 'open',
        partyId: i === 0 ? 'pty_kpi_1' : null,
      })),
    });

    // A visit for the person behind lead 0, so "new leads with visits" is 1 and
    // not merely "some lead exists and some visit exists".
    await prisma.checkIn.createMany({
      data: [
        {
          organisationId: A.org, storeId: A.store, partyId: 'pty_kpi_1',
          customerName: 'Vedant Kothari', timeIn: new Date(),
        },
        {
          organisationId: A.org, storeId: A.store, partyId: null,
          customerName: 'Anonymous walk-in', timeIn: new Date(),
        },
      ],
    });

    await prisma.productInteraction.createMany({
      data: [
        { organisationId: A.org, storeId: A.store, partyId: 'pty_kpi_1', kind: 'shown', sku: 'BRG-1' },
        { organisationId: A.org, storeId: A.store, partyId: 'pty_kpi_1', kind: 'tried', sku: 'BRG-2' },
        { organisationId: A.org, storeId: A.store, partyId: 'pty_kpi_2', kind: 'shown', sku: 'BRG-3' },
      ],
    });

    // --- tenant A, branch two (must be invisible to the branch manager) --------
    await prisma.lead.create({
      data: {
        organisationId: A.org, storeId: A.store2, customerName: 'Plant Two Buyer',
        interest: 'Castings', source: 'walk_in', stage: 'inquiry', ref: 'LD-KPI-P2',
      },
    });
    await prisma.checkIn.create({
      data: {
        organisationId: A.org, storeId: A.store2, customerName: 'Plant Two Visitor',
        timeIn: new Date(),
      },
    });

    // --- tenant B -------------------------------------------------------------
    await prisma.lead.create({
      data: {
        organisationId: B.org, storeId: B.store, customerName: 'Rival Buyer',
        interest: 'Rival goods', source: 'meta_ads', stage: 'inquiry', ref: 'LD-KPI-RIVAL',
      },
    });
    await prisma.checkIn.create({
      data: {
        organisationId: B.org, storeId: B.store, customerName: 'Rival Visitor',
        timeIn: new Date(),
      },
    });

    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201))
        .body.token;
    token = await login(A.ho);
    mgrToken = await login(A.mgr);
    otherTenantToken = await login(B.ho);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ------------------------------------------------------------- the totals */

  describe('the totals', () => {
    it('counts every lead, not the first page of them', async () => {
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      // 130 in branch one + 1 in branch two; head office sees both.
      expect(res.body.totals.leads).toBe(BULK_LEADS + 1);
    });

    it('counts visits and enquiries as their own aggregates', async () => {
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      expect(res.body.totals.visits).toBe(3);
      expect(res.body.totals.enquiries).toBe(3);
    });

    it('counts a walk-in with no customer record as a visit', async () => {
      // The anonymous check-in has a null partyId. A join-based count would drop
      // it and under-report footfall for exactly the shops that are busiest.
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      const anonymous = await prisma.checkIn.count({
        where: { organisationId: A.org, partyId: null },
      });
      expect(anonymous).toBe(2);
      expect(res.body.totals.visits).toBeGreaterThanOrEqual(anonymous);
    });

    it('counts a new lead that also walked in, matched through the person', async () => {
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      expect(res.body.totals.newLeadsWithVisits).toBe(1);
    });
  });

  /* ------------------------------------------------------------ the channels */

  describe('the channels', () => {
    it('splits paid social from organic social and from messaging', async () => {
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      const { channels } = res.body;
      // 130 leads over 5 sources, round-robin: 26 each.
      expect(channels.paidSocial).toBe(26);
      expect(channels.organicSocial).toBe(26);
      expect(channels.messaging).toBe(26);
      expect(channels.website).toBe(26);
      // walk_in gets branch one's 26 plus branch two's single lead.
      expect(channels.walkIn).toBe(27);
    });

    it('labels each source where the value is produced', async () => {
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      const meta = res.body.bySource.find((s: { source: string }) => s.source === 'meta_ads');
      expect(meta.label).toBe('Meta Ads');
    });

    it('reports zero for a channel the tenant has never used', async () => {
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      // No referral leads were created. Zero is right here — it is a real count.
      expect(res.body.channels.referral).toBe(0);
    });
  });

  /* -------------------------------------------------------------- the intent */

  describe('the intent breakdown', () => {
    it('is null, not a chart of zeroes, before anything is assessed', async () => {
      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      expect(res.body.intent).toBeNull();
      expect(res.body.intentAssessed).toBe(0);
    });

    it('uses the tenant’s own band labels once there is something to show', async () => {
      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, storeId: A.store },
      });
      await prisma.leadQualification.create({
        data: {
          organisationId: A.org, leadId: lead!.id, method: 'rules', score: 72, band: 'hot',
        },
      });

      const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      expect(res.body.intentAssessed).toBe(1);
      const hot = res.body.intent.find((b: { key: string }) => b.key === 'hot');
      expect(hot.count).toBe(1);
      // The default policy's label for `hot`. A hardcoded "Highly Convertable"
      // would fail here, which is the point: the words belong to the tenant.
      expect(hot.label).toBe('Ready to talk');
      // Bands with no assessments are present at zero, so the chart keeps its shape.
      const cold = res.body.intent.find((b: { key: string }) => b.key === 'cold');
      expect(cold.count).toBe(0);
    });
  });

  /* ------------------------------------------------------------- the scoping */

  describe('scoping', () => {
    it('keeps a branch manager inside their own branch', async () => {
      const res = await request(server())
        .get('/crm/omnichannel/summary')
        .set({ Authorization: `Bearer ${mgrToken}` })
        .expect(200);
      expect(res.body.totals.leads).toBe(BULK_LEADS); // branch two's lead excluded
      expect(res.body.totals.visits).toBe(2);
      expect(res.body.storeIds).toEqual([A.store]);
    });

    it('never counts another tenant’s leads or visits', async () => {
      const mine = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
      const theirs = await request(server())
        .get('/crm/omnichannel/summary')
        .set({ Authorization: `Bearer ${otherTenantToken}` })
        .expect(200);

      expect(theirs.body.totals.leads).toBe(1);
      expect(theirs.body.totals.visits).toBe(1);
      expect(mine.body.totals.leads).toBe(BULK_LEADS + 1);
      expect(theirs.body.intent).toBeNull();
    });

    it('refuses a branch the caller cannot see, rather than widening', async () => {
      await request(server())
        .get('/crm/omnichannel/summary')
        .set({ Authorization: `Bearer ${mgrToken}` })
        .query({ storeId: A.store2 })
        .expect(403);
    });

    it('refuses another tenant’s branch id outright', async () => {
      await request(server())
        .get('/crm/omnichannel/summary').set(auth()).query({ storeId: B.store }).expect(403);
    });

    it('narrows to one branch when asked', async () => {
      const res = await request(server())
        .get('/crm/omnichannel/summary').set(auth()).query({ storeId: A.store2 }).expect(200);
      expect(res.body.totals.leads).toBe(1);
      expect(res.body.storeIds).toEqual([A.store2]);
    });
  });

  /* -------------------------------------------------------------- the window */

  describe('the reporting window', () => {
    it('accepts a window as a query string, which arrives as text', async () => {
      const res = await request(server())
        .get('/crm/omnichannel/summary').set(auth()).query({ days: '30' }).expect(200);
      expect(res.body.windowDays).toBe(30);
    });

    it('excludes anything older than the window', async () => {
      await prisma.lead.create({
        data: {
          organisationId: A.org, storeId: A.store, customerName: 'Ancient Buyer',
          interest: 'Bearings', source: 'walk_in', stage: 'inquiry', ref: 'LD-KPI-OLD',
          createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        },
      });
      const recent = await request(server())
        .get('/crm/omnichannel/summary').set(auth()).query({ days: 30 }).expect(200);
      const wide = await request(server())
        .get('/crm/omnichannel/summary').set(auth()).query({ days: 730 }).expect(200);
      expect(wide.body.totals.leads).toBe(recent.body.totals.leads + 1);
    });

    it('refuses a window that is not a number', async () => {
      await request(server())
        .get('/crm/omnichannel/summary').set(auth()).query({ days: 'forever' }).expect(400);
    });

    it('refuses an unknown filter instead of ignoring it', async () => {
      await request(server())
        .get('/crm/omnichannel/summary').set(auth()).query({ organisationId: B.org }).expect(400);
    });
  });

  /* --------------------------------------------------------------- the funnel */

  it('reports the funnel in order, each stage its own count', async () => {
    const res = await request(server()).get('/crm/omnichannel/summary').set(auth()).expect(200);
    const keys = res.body.funnel.map((f: { key: string }) => f.key);
    expect(keys).toEqual(['conversations', 'leads', 'enquiries', 'visits', 'converted']);
    const converted = res.body.funnel.find((f: { key: string }) => f.key === 'converted');
    // BULK_LEADS/20 rounded up: indices 0, 20, 40, 60, 80, 100, 120.
    expect(converted.count).toBe(7);
  });

  it('is refused without a token', async () => {
    await request(server()).get('/crm/omnichannel/summary').expect(401);
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.leadQualification.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.productInteraction.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.checkIn.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.leadNote.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.party.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.organisation.deleteMany({ where: { id: org } }).catch(() => undefined);
  }
}
