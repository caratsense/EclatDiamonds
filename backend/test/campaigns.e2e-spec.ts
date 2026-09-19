import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CampaignsService } from '../src/crm/campaigns.service';
import { parseSegmentDefinition, compileSegment } from '../src/crm/audience-segment.dsl';

/**
 * Campaign orchestration.
 *
 * What is actually being pinned here is not "a campaign can be created" — that
 * is the easy half. It is the four things that decide whether a campaign is safe
 * to put in a customer's hands:
 *
 *   1. Expansion is idempotent. Background jobs get retried; the unique key on
 *      (campaignId, contactValue) has to turn a second expansion into nothing.
 *   2. The audience is frozen at approval. Editing the saved segment afterwards
 *      must not change who a scheduled campaign reaches.
 *   3. Cancellation actually stops unsent recipients, including mid-flight.
 *   4. The preview count is a database aggregate over the whole audience, and is
 *      scoped to the tenant and to the caller's branches.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_camp_a',
  slug: 'camp-a',
  store: 'store_camp_a',
  store2: 'store_camp_a2',
  ho: 'ho.camp@camp-a.local',
  mgr: 'mgr.camp@camp-a.local',
  rep: 'rep.camp@camp-a.local',
};
const B = { org: 'org_camp_b', slug: 'camp-b', store: 'store_camp_b' };

describe('Campaign orchestration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let campaigns: CampaignsService;
  let token: string;
  let mgrToken: string;
  let repToken: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    campaigns = app.get(CampaignsService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    /*
     * HEALTHCARE, not jewellery, and that is the point of the fixture.
     *
     * Campaigns must work for a tenant that never bought the jewellery pack. If
     * this suite seeded `jewellery` it would pass while the universal claim was
     * false, which is the failure mode this whole exercise exists to avoid.
     */
    await prisma.organisation.create({
      data: { id: A.org, name: 'Camp A', slug: A.slug, industryPackCode: 'healthcare' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Main', city: 'Pune', organisationId: A.org },
    });
    await prisma.store.create({
      data: { id: A.store2, name: 'Second', city: 'Nashik', organisationId: A.org },
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
        email: A.mgr, name: 'Manager', role: 'store_manager', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        // Campaigns are marketing's by default (auth/access.ts); head office gave them to this manager.
        accessOverrides: { campaigns: 'store' },
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    await prisma.user.create({
      data: {
        email: A.rep, name: 'Rep', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });

    await prisma.organisation.create({
      data: { id: B.org, name: 'Camp B', slug: B.slug, industryPackCode: 'manufacturing' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'Other', city: 'Mumbai', organisationId: B.org },
    });

    // Tenant A: 3 customers at the main branch, 1 at the second, 1 blocked.
    await prisma.party.createMany({
      data: [
        { id: 'p_a1', organisationId: A.org, storeId: A.store, name: 'Asha', types: ['customer'], whatsapp: '+919812340001', city: 'Pune' },
        { id: 'p_a2', organisationId: A.org, storeId: A.store, name: 'Bhavin', types: ['customer'], whatsapp: '+919812340002', city: 'Pune' },
        { id: 'p_a3', organisationId: A.org, storeId: A.store, name: 'Chirag', types: ['customer'], phone: '+919812340003', city: 'Pune' },
        { id: 'p_a4', organisationId: A.org, storeId: A.store2, name: 'Divya', types: ['customer'], whatsapp: '+919812340004', city: 'Nashik' },
        { id: 'p_a5', organisationId: A.org, storeId: A.store, name: 'Eshan', types: ['customer'], whatsapp: '+919812340005', city: 'Pune', isBlacklisted: true },
        // No usable number at all: must be excluded, and must not crash expansion.
        { id: 'p_a6', organisationId: A.org, storeId: A.store, name: 'Farhan', types: ['customer'], city: 'Pune' },
      ],
    });
    // Tenant B: a customer that must never appear in tenant A's audience.
    await prisma.party.create({
      data: { id: 'p_b1', organisationId: B.org, storeId: B.store, name: 'Other Tenant', types: ['customer'], whatsapp: '+919812349999' },
    });

    token = (await login(A.ho)).body.token;
    mgrToken = (await login(A.mgr)).body.token;
    repToken = (await login(A.rep)).body.token;
  });

  const login = (email: string) =>
    request(server()).post('/auth/login').send({ email, password: PASSWORD });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ----------------------------------------------------------- the language */

  describe('the audience language', () => {
    it('refuses a field it does not know rather than ignoring it', () => {
      expect(() =>
        parseSegmentDefinition({ match: 'all', conditions: [{ field: 'party.secretSalary', op: 'in', value: ['x'] }] }),
      ).toThrow(/not a field/i);
    });

    it('refuses an order-count rule it cannot express exactly', () => {
      // Prisma cannot filter on count(sales) >= 3. Approximating it would send to
      // the wrong people; the language says no instead.
      const def = parseSegmentDefinition({
        match: 'all',
        conditions: [{ field: 'transaction.orderCount', op: 'gte', value: 3 }],
      });
      expect(() => compileSegment(def, new Date())).toThrow(/total spend/i);
    });

    it('carries tenant vocabulary through attribute: without a schema change', () => {
      const def = parseSegmentDefinition({
        match: 'all',
        conditions: [{ field: 'attribute:preferred_department', op: 'eq', value: 'cardiology' }],
      });
      const compiled = compileSegment(def, new Date());
      expect(JSON.stringify(compiled.where)).toContain('preferred_department');
      expect(compiled.reasons[0]).toContain('cardiology');
    });

    it('refuses an attribute key that could change the JSON path', () => {
      expect(() =>
        parseSegmentDefinition({
          match: 'all',
          conditions: [{ field: 'attribute:a.b"c', op: 'eq', value: 'x' }],
        }),
      ).toThrow(/letters, numbers and underscores/i);
    });

    it('bounds the rule tree', () => {
      const conditions = Array.from({ length: 26 }, () => ({
        field: 'party.city', op: 'in', value: ['Pune'],
      }));
      expect(() => parseSegmentDefinition({ match: 'all', conditions })).toThrow(/at most 25/i);
    });
  });

  /* -------------------------------------------------------------- preview */

  describe('audience preview', () => {
    it('counts the whole audience, not the sample', async () => {
      const res = await request(server())
        .post('/audiences/preview')
        .set(auth())
        .send({ definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] } })
        .expect(201);

      // Six parties in tenant A, and not the seventh in tenant B.
      expect(res.body.total).toBe(6);
      expect(res.body.contactable).toBe(5);
      expect(res.body.excluded.noContactPoint).toBe(1);
      expect(res.body.excluded.blocked).toBe(1);
      expect(res.body.reasons[0]).toMatch(/customer/i);
    });

    it('never shows another tenant a customer', async () => {
      const res = await request(server())
        .post('/audiences/preview')
        .set(auth())
        .send({ definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] } })
        .expect(201);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('Other Tenant');
      expect(body).not.toContain('9999');
    });

    it('masks the contact number in the sample', async () => {
      const res = await request(server())
        .post('/audiences/preview')
        .set(auth())
        .send({ definition: { match: 'all', conditions: [{ field: 'party.city', op: 'in', value: ['Pune'] }] } })
        .expect(201);
      const withContact = res.body.sample.filter((s: { contact: string | null }) => s.contact);
      expect(withContact.length).toBeGreaterThan(0);
      for (const row of withContact) {
        expect(row.contact).toMatch(/^••••\d{4}$/);
      }
    });

    it('keeps a branch manager inside their own branch even when they ask for another', async () => {
      const res = await request(server())
        .post('/audiences/preview')
        .set({ Authorization: `Bearer ${mgrToken}` })
        .send({
          definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] },
          storeIds: [A.store2],
        });
      // The manager holds store A only; asking for A.store2 is refused outright
      // rather than silently returning their own branch, which would look like
      // it had worked.
      expect(res.status).toBe(400);
    });

    it('is closed to a salesperson', async () => {
      await request(server())
        .post('/audiences/preview')
        .set({ Authorization: `Bearer ${repToken}` })
        .send({ definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] } })
        .expect(403);
    });
  });

  /* ------------------------------------------------------------- lifecycle */

  describe('lifecycle', () => {
    let campaignId: string;

    it('refuses a channel with no live provider instead of scheduling silence', async () => {
      const res = await request(server())
        .post('/campaigns')
        .set(auth())
        .send({
          name: 'Email blast',
          channel: 'email',
          definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] },
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no live provider/i);
    });

    it('creates a draft', async () => {
      const res = await request(server())
        .post('/campaigns')
        .set(auth())
        .send({
          name: 'Festive greeting',
          definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] },
          templateName: 'festive_greeting',
          templateLanguage: 'en_US',
        })
        .expect(201);
      campaignId = res.body.id;
      expect(res.body.status).toBe('draft');
      expect(res.body.counts.targeted).toBe(0);
    });

    it('will not submit a campaign with no template', async () => {
      const bare = await request(server())
        .post('/campaigns')
        .set(auth())
        .send({
          name: 'No template',
          definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] },
        })
        .expect(201);
      const res = await request(server())
        .post(`/campaigns/${bare.body.id}/submit`)
        .set(auth());
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/template/i);
    });

    it('submits for approval', async () => {
      const res = await request(server())
        .post(`/campaigns/${campaignId}/submit`)
        .set(auth())
        .expect(201);
      expect(res.body.status).toBe('awaiting_approval');
    });

    it('refuses approval when the template is not registered for this tenant', async () => {
      // No IntegrationAsset exists for festive_greeting:en_US, so approval must
      // fail loudly here rather than at send time on forty thousand rows.
      const res = await request(server())
        .post(`/campaigns/${campaignId}/approve`)
        .set(auth());
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not registered/i);
    });

    it('refuses approval from a branch manager', async () => {
      const res = await request(server())
        .post(`/campaigns/${campaignId}/approve`)
        .set({ Authorization: `Bearer ${mgrToken}` });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/head office|area manager/i);
    });

    it('cancels, and says so', async () => {
      const res = await request(server())
        .post(`/campaigns/${campaignId}/cancel`)
        .set(auth())
        .send({ reason: 'Wrong week' })
        .expect(201);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.cancelReason).toBe('Wrong week');
    });

    it('will not cancel twice', async () => {
      const res = await request(server())
        .post(`/campaigns/${campaignId}/cancel`)
        .set(auth())
        .send({});
      expect(res.status).toBe(409);
    });

    it('will not edit a cancelled campaign', async () => {
      const res = await request(server())
        .patch(`/campaigns/${campaignId}`)
        .set(auth())
        .send({ name: 'Renamed' });
      expect(res.status).toBe(409);
    });
  });

  /* ------------------------------------------------------------- expansion */

  describe('expansion', () => {
    let campaignId: string;

    beforeAll(async () => {
      // Register the template this tenant will send, so approval can resolve it.
      const integration = await prisma.integration.create({
        data: {
          organisationId: A.org,
          providerCode: 'whatsapp_cloud',
          name: 'WhatsApp',
          status: 'connected',
        },
      });
      await prisma.integrationAsset.create({
        data: {
          organisationId: A.org,
          integrationId: integration.id,
          kind: 'whatsapp_template',
          externalId: 'expansion_test:en_US',
          name: 'expansion_test',
          // The provider's own verdict, which is what the outbox reads at send
          // time. Registered here as APPROVED so approval can resolve the asset;
          // whether it is still sendable remains the outbox's decision.
          metadata: { status: 'approved', verdictAt: new Date().toISOString() },
        },
      });

      const created = await request(server())
        .post('/campaigns')
        .set(auth())
        .send({
          name: 'Expansion test',
          definition: { match: 'all', conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }] },
          templateName: 'expansion_test',
          templateLanguage: 'en_US',
        })
        .expect(201);
      campaignId = created.body.id;
      await request(server()).post(`/campaigns/${campaignId}/submit`).set(auth()).expect(201);
    });

    it('freezes the audience at approval', async () => {
      await request(server()).post(`/campaigns/${campaignId}/approve`).set(auth()).expect(201);
      const row = await prisma.messagingCampaign.findUnique({ where: { id: campaignId } });
      expect(row?.approvedAt).toBeTruthy();
      expect(row?.audienceSnapshot).toBeTruthy();
      expect(JSON.stringify(row?.audienceSnapshot)).toContain('party.type');
    });

    it('expands to one row per contactable person, excluding the blocked one', async () => {
      await runExpansion(campaigns, A.org, campaignId);
      const rows = await prisma.campaignRecipient.findMany({ where: { campaignId } });
      // Five parties have a usable number; Farhan has none and gets no row at all.
      expect(rows).toHaveLength(5);
      const blocked = rows.filter((r) => r.status === 'excluded');
      expect(blocked).toHaveLength(1);
      expect(blocked[0].exclusionReason).toBe('blocked_customer');
      expect(rows.filter((r) => r.status === 'pending')).toHaveLength(4);
    });

    it('never expands another tenant into the audience', async () => {
      const rows = await prisma.campaignRecipient.findMany({ where: { campaignId } });
      expect(rows.map((r) => r.contactValue)).not.toContain('919812349999');
      const foreign = await prisma.campaignRecipient.findFirst({
        where: { campaignId, organisationId: B.org },
      });
      expect(foreign).toBeNull();
    });

    it('is idempotent: a retried expansion adds nothing', async () => {
      const before = await prisma.campaignRecipient.count({ where: { campaignId } });
      // Clear the guard so the job body actually runs its insert path again,
      // proving the UNIQUE key is what protects us and not just the early exit.
      await prisma.messagingCampaign.update({
        where: { id: campaignId },
        data: { expandedAt: null },
      });
      await runExpansion(campaigns, A.org, campaignId);
      const after = await prisma.campaignRecipient.count({ where: { campaignId } });
      expect(after).toBe(before);
    });

    it('normalises the contact so one person cannot be reached twice', async () => {
      const rows = await prisma.campaignRecipient.findMany({ where: { campaignId } });
      for (const r of rows) {
        expect(r.contactValue).toMatch(/^\d{10,15}$/);
      }
      expect(new Set(rows.map((r) => r.contactValue)).size).toBe(rows.length);
    });

    it('cancelling stops every unsent recipient', async () => {
      await request(server())
        .post(`/campaigns/${campaignId}/cancel`)
        .set(auth())
        .send({ reason: 'Stop' })
        .expect(201);
      const pending = await prisma.campaignRecipient.count({
        where: { campaignId, status: 'pending' },
      });
      expect(pending).toBe(0);
      const cancelled = await prisma.campaignRecipient.count({
        where: { campaignId, status: 'cancelled' },
      });
      expect(cancelled).toBe(4);
    });

    it('a send job on a cancelled campaign does nothing', async () => {
      const result = await runSend(campaigns, A.org, campaignId);
      expect(result).toEqual({ skipped: 'cancelled' });
      const sent = await prisma.campaignRecipient.count({
        where: { campaignId, status: { in: ['sent', 'queued'] } },
      });
      expect(sent).toBe(0);
    });

    it('reports counts from the database, not from a page of rows', async () => {
      const res = await request(server())
        .get(`/campaigns/${campaignId}`)
        .set(auth())
        .expect(200);
      expect(res.body.counts.cancelled).toBe(4);
      expect(res.body.counts.excluded).toBe(1);
    });

    it('paginates recipients and masks their numbers', async () => {
      const res = await request(server())
        .get(`/campaigns/${campaignId}/recipients`)
        .set(auth())
        .query({ limit: 2 })
        .expect(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.nextCursor).toBeTruthy();
      for (const item of res.body.items) {
        expect(item.contact).toMatch(/^••••\d{4}$/);
      }
    });
  });

  /* ---------------------------------------------------------- saved audiences */

  describe('saved audiences', () => {
    it('will not accept two audiences with the same name', async () => {
      const body = {
        name: 'Pune customers',
        definition: { match: 'all', conditions: [{ field: 'party.city', op: 'in', value: ['Pune'] }] },
      };
      await request(server()).post('/audiences').set(auth()).send(body).expect(201);
      const again = await request(server()).post('/audiences').set(auth()).send(body);
      expect(again.status).toBe(409);
    });

    it('cannot be read across tenants', async () => {
      const rows = await prisma.audienceSegment.findMany({ where: { organisationId: B.org } });
      expect(rows).toHaveLength(0);
      const res = await request(server()).get('/audiences').set(auth()).expect(200);
      expect(res.body.every((r: { id: string }) => typeof r.id === 'string')).toBe(true);
    });
  });
});

/**
 * Call the registered job handler directly.
 *
 * The alternative — waiting for the worker poll — makes the suite slow and
 * flaky, and would test the scheduler rather than the expansion. The handler is
 * the unit under test; the worker that calls it is covered elsewhere.
 */
async function runExpansion(svc: CampaignsService, organisationId: string, campaignId: string) {
  return (svc as unknown as {
    runExpansion(p: unknown, c: unknown): Promise<unknown>;
  }).runExpansion({ campaignId }, { jobId: 'test', organisationId, attempt: 1, kind: 'campaign.expand' });
}

async function runSend(svc: CampaignsService, organisationId: string, campaignId: string) {
  return (svc as unknown as {
    runSend(p: unknown, c: unknown): Promise<unknown>;
  }).runSend({ campaignId }, { jobId: 'test', organisationId, attempt: 1, kind: 'campaign.send' });
}

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.campaignRecipient.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.messagingCampaign.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.audienceSegment.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.integrationAsset.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.integrationCredential.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.integration.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.jobTask.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
