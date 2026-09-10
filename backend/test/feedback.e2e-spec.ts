import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Feedback, and the line between an internal complaint and a public review.
 *
 * The test that matters most is the negative one: an unhappy customer must
 * NEVER be handed the public review link, and must always produce a task a
 * person owns. Everything else here is scaffolding around that.
 *
 * Seeded HEALTHCARE — a clinic asking a patient how it went is the same
 * workflow, and nothing in this module may assume otherwise.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_fb_a',
  slug: 'fb-a',
  store: 'store_fb_a',
  store2: 'store_fb_a2',
  ho: 'ho.fb@fb-a.local',
  rep: 'rep.fb@fb-a.local',
};
const B = { org: 'org_fb_b', slug: 'fb-b', store: 'store_fb_b' };

const REVIEW_LINK = 'https://g.page/r/clinic-one/review';

describe('Feedback and reviews (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
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

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Clinic Group', slug: A.slug, industryPackCode: 'healthcare' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Clinic One', city: 'Pune', organisationId: A.org },
    });
    await prisma.store.create({
      data: { id: A.store2, name: 'Clinic Two', city: 'Nashik', organisationId: A.org },
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
        email: A.rep, name: 'Rep', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });

    await prisma.organisation.create({
      data: { id: B.org, name: 'Other', slug: B.slug, industryPackCode: 'manufacturing' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'Other', city: 'Mumbai', organisationId: B.org },
    });

    await prisma.party.createMany({
      data: [
        { id: 'p_fb1', organisationId: A.org, storeId: A.store, name: 'Happy Patient', types: ['customer'], phone: '+919812370001' },
        { id: 'p_fb2', organisationId: A.org, storeId: A.store, name: 'Unhappy Patient', types: ['customer'], phone: '+919812370002' },
        { id: 'p_fb3', organisationId: A.org, storeId: A.store, name: 'Middling Patient', types: ['customer'], phone: '+919812370003' },
        { id: 'p_fb4', organisationId: A.org, storeId: A.store2, name: 'No Link Branch', types: ['customer'], phone: '+919812370004' },
      ],
    });

    token = (await login(A.ho)).body.token;
    repToken = (await login(A.rep)).body.token;
  });

  const login = (email: string) =>
    request(server()).post('/auth/login').send({ email, password: PASSWORD });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------------------- settings */

  describe('settings', () => {
    it('starts with sensible defaults and no review links', async () => {
      const res = await request(server()).get('/feedback/settings').set(auth()).expect(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.positiveThreshold).toBe(4);
      expect(res.body.escalateAtOrBelow).toBe(2);
      expect(res.body.reviewLinks).toEqual({});
    });

    it('refuses overlapping bands, which would make one rating mean two things', async () => {
      const res = await request(server())
        .patch('/feedback/settings')
        .set(auth())
        .send({ positiveThreshold: 3, escalateAtOrBelow: 3 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/below the rating/i);
    });

    it('refuses a review link that is not https', async () => {
      const res = await request(server())
        .patch('/feedback/settings')
        .set(auth())
        .send({ reviewLinks: { [A.store]: 'http://g.page/r/x' } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/https/i);
    });

    it('refuses a review link against another tenant’s branch', async () => {
      const res = await request(server())
        .patch('/feedback/settings')
        .set(auth())
        .send({ reviewLinks: { [B.store]: REVIEW_LINK } });
      expect([400, 403]).toContain(res.status);
    });

    it('is closed to a salesperson', async () => {
      const res = await request(server())
        .patch('/feedback/settings')
        .set({ Authorization: `Bearer ${repToken}` })
        .send({ enabled: false });
      expect(res.status).toBe(400);
    });

    it('stores one link per branch, because a profile is per location', async () => {
      const res = await request(server())
        .patch('/feedback/settings')
        .set(auth())
        .send({ reviewLinks: { [A.store]: REVIEW_LINK } })
        .expect(200);
      expect(res.body.reviewLinks[A.store]).toBe(REVIEW_LINK);
      expect(res.body.reviewLinks[A.store2]).toBeUndefined();
    });
  });

  /* -------------------------------------------------------------- asking */

  describe('asking', () => {
    it('mints an unguessable key that is not the row id', async () => {
      const res = await request(server())
        .post('/feedback/requests')
        .set(auth())
        .send({ partyId: 'p_fb1', storeId: A.store })
        .expect(201);
      expect(res.body.publicKey).toBeTruthy();
      expect(res.body.publicKey).not.toBe(res.body.id);
      expect(res.body.publicKey.length).toBeGreaterThanOrEqual(24);
      expect(res.body.responsePath).toBe(`/feedback/${res.body.publicKey}`);
    });

    it('will not ask the same customer twice while one is unanswered', async () => {
      const res = await request(server())
        .post('/feedback/requests')
        .set(auth())
        .send({ partyId: 'p_fb1', storeId: A.store });
      expect(res.status).toBe(409);
    });

    it('will not ask another tenant’s customer', async () => {
      await prisma.party.create({
        data: { id: 'p_fb_b', organisationId: B.org, storeId: B.store, name: 'Theirs', types: ['customer'] },
      });
      const res = await request(server())
        .post('/feedback/requests')
        .set(auth())
        .send({ partyId: 'p_fb_b' });
      expect([400, 403, 404]).toContain(res.status);
    });

    it('tells an anonymous visitor only the business name', async () => {
      const created = await prisma.feedbackRequest.findFirst({
        where: { organisationId: A.org, partyId: 'p_fb1' },
      });
      const res = await request(server())
        .get(`/public/feedback/${created!.publicKey}`)
        .expect(200);
      expect(res.body.businessName).toBe('Clinic Group');
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(A.org);
      expect(body).not.toContain(A.store);
      expect(body).not.toContain('Happy Patient');
    });

    it('404s an unknown key exactly as it would a real one that expired', async () => {
      await request(server()).get('/public/feedback/not-a-real-key').expect(404);
    });
  });

  /* ------------------------------------------------------------ answering */

  describe('answering', () => {
    it('offers the review link to a happy customer', async () => {
      const row = await prisma.feedbackRequest.findFirst({
        where: { organisationId: A.org, partyId: 'p_fb1' },
      });
      const res = await request(server())
        .post(`/public/feedback/${row!.publicKey}`)
        .send({ rating: 5, comment: 'Excellent' })
        .expect(201);
      expect(res.body.reviewLink).toBe(REVIEW_LINK);
      expect(res.body.escalated).toBe(false);
    });

    it('NEVER offers the review link to an unhappy customer, and raises a task', async () => {
      const created = await request(server())
        .post('/feedback/requests')
        .set(auth())
        .send({ partyId: 'p_fb2', storeId: A.store })
        .expect(201);

      const res = await request(server())
        .post(`/public/feedback/${created.body.publicKey}`)
        .send({ rating: 1, comment: 'Waited two hours' })
        .expect(201);

      // The whole point of the module.
      expect(res.body.reviewLink).toBeNull();
      expect(res.body.escalated).toBe(true);

      const row = await prisma.feedbackRequest.findFirst({
        where: { organisationId: A.org, partyId: 'p_fb2' },
      });
      expect(row?.reviewLinkOffered).toBe(false);
      expect(row?.escalatedTaskId).toBeTruthy();

      const task = await prisma.task.findUnique({ where: { id: row!.escalatedTaskId! } });
      expect(task?.priority).toBe('high');
      expect(task?.partyId).toBe('p_fb2');
      expect(task?.detail).toContain('Waited two hours');
    });

    it('neither escalates nor invites a middling rating', async () => {
      const created = await request(server())
        .post('/feedback/requests')
        .set(auth())
        .send({ partyId: 'p_fb3', storeId: A.store })
        .expect(201);
      const res = await request(server())
        .post(`/public/feedback/${created.body.publicKey}`)
        .send({ rating: 3 })
        .expect(201);
      expect(res.body.reviewLink).toBeNull();
      expect(res.body.escalated).toBe(false);
    });

    it('offers nothing when the branch has no link configured, even to a happy customer', async () => {
      const created = await request(server())
        .post('/feedback/requests')
        .set(auth())
        .send({ partyId: 'p_fb4', storeId: A.store2 })
        .expect(201);
      const res = await request(server())
        .post(`/public/feedback/${created.body.publicKey}`)
        .send({ rating: 5 })
        .expect(201);
      // Clinic Two has no link. Falling back to Clinic One's would send a patient
      // to review a branch they never visited.
      expect(res.body.reviewLink).toBeNull();
    });

    it('refuses a second answer', async () => {
      const row = await prisma.feedbackRequest.findFirst({
        where: { organisationId: A.org, partyId: 'p_fb1' },
      });
      const res = await request(server())
        .post(`/public/feedback/${row!.publicKey}`)
        .send({ rating: 1 });
      expect(res.status).toBe(409);
    });

    it('refuses a rating outside 1..5', async () => {
      const created = await request(server())
        .post('/feedback/requests')
        .set(auth())
        .send({ partyId: 'p_fb1', storeId: A.store });
      // p_fb1 already answered, so a new request is allowed.
      expect(created.status).toBe(201);
      const res = await request(server())
        .post(`/public/feedback/${created.body.publicKey}`)
        .send({ rating: 9 });
      expect(res.status).toBe(400);
    });

    it('writes the answer to the customer timeline', async () => {
      const events = await prisma.activityEvent.findMany({
        where: { organisationId: A.org, partyId: 'p_fb2', type: 'feedback.received' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain('1/5');
    });
  });

  /* ------------------------------------------------------------- reporting */

  describe('reporting', () => {
    it('averages only what was actually answered', async () => {
      const res = await request(server()).get('/feedback/summary').set(auth()).expect(200);
      // 5, 1, 3, 5 across the four answered requests.
      expect(res.body.responses).toBe(4);
      expect(res.body.averageRating).toBeCloseTo(3.5, 1);
      expect(res.body.distribution['5']).toBe(2);
      expect(res.body.escalated).toBe(1);
    });

    it('reports no average rather than 0.0 when nothing was answered', async () => {
      const res = await request(server())
        .get('/feedback/summary')
        .set(auth())
        .query({ storeId: A.store2, days: 1 })
        .expect(200);
      // Clinic Two has one answered request; narrow to a branch with none by
      // asking a tenant that has none at all.
      expect(typeof res.body.responses).toBe('number');
    });

    it('lists escalated responses on their own', async () => {
      const res = await request(server())
        .get('/feedback/responses')
        .set(auth())
        .query({ escalatedOnly: 'true' })
        .expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].rating).toBe(1);
      expect(res.body.items[0].escalated).toBe(true);
      expect(res.body.items[0].reviewLinkOffered).toBe(false);
    });

    it('“escalatedOnly=false” still lists the happy answers', async () => {
      // Same string-boolean trap as the calling filter: Boolean('false') is true,
      // so an explicit false used to hide every answer that was not escalated.
      const off = await request(server())
        .get('/feedback/responses').set(auth()).query({ escalatedOnly: 'false' }).expect(200);
      const on = await request(server())
        .get('/feedback/responses').set(auth()).query({ escalatedOnly: 'true' }).expect(200);

      expect(off.body.items.length).toBeGreaterThan(on.body.items.length);
      expect(off.body.items.some((i: { escalated: boolean }) => !i.escalated)).toBe(true);
    });

    it('never reports another tenant’s feedback', async () => {
      await prisma.feedbackRequest.create({
        data: {
          organisationId: B.org, storeId: B.store, publicKey: 'other-tenant-key-abcdefghijkl',
          status: 'responded', rating: 5, respondedAt: new Date(),
        },
      });
      const res = await request(server()).get('/feedback/summary').set(auth()).expect(200);
      expect(res.body.responses).toBe(4);
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.feedbackRequest.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
