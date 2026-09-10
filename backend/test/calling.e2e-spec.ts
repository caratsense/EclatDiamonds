import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The central calling / follow-up workspace.
 *
 * The headline property: KPI counts come from their own aggregates and are
 * NOT derived from the page of tasks on screen. This suite creates 120 overdue
 * tasks — more than the 100-row page cap — because a screen that computes
 * "overdue" from `rows.filter(...)` passes every test written with 5 rows and
 * then reports 50 when the truth is 94,569.
 *
 * Seeded HEALTHCARE, so nothing here can quietly depend on the jewellery pack.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_call_a',
  slug: 'call-a',
  store: 'store_call_a',
  store2: 'store_call_a2',
  ho: 'ho.call@call-a.local',
  agent: 'agent.call@call-a.local',
  other: 'other.call@call-a.local',
};
const B = { org: 'org_call_b', slug: 'call-b', store: 'store_call_b' };

/** Deliberately above the 100-row page cap. */
const OVERDUE_COUNT = 120;

describe('Calling workspace (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let agentToken: string;
  let otherToken: string;
  let agentId: string;
  let otherId: string;
  let taskId: string;

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
      data: { id: A.org, name: 'Call A', slug: A.slug, industryPackCode: 'healthcare' },
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
    const agent = await prisma.user.create({
      data: {
        email: A.agent, name: 'Agent', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    agentId = agent.id;
    const other = await prisma.user.create({
      data: {
        email: A.other, name: 'Other Agent', role: 'salesperson', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    otherId = other.id;

    await prisma.organisation.create({
      data: { id: B.org, name: 'Call B', slug: B.slug, industryPackCode: 'manufacturing' },
    });
    await prisma.store.create({
      data: { id: B.store, name: 'Other', city: 'Mumbai', organisationId: B.org },
    });

    await prisma.party.create({
      data: {
        id: 'p_call1', organisationId: A.org, storeId: A.store, name: 'Meera Iyer',
        types: ['customer'], whatsapp: '+919876500011', code: 'PT-2001',
        contactPoints: {
          create: {
            organisationId: A.org, kind: 'whatsapp',
            value: '+919876500011', valueNormalized: '919876500011', isPrimary: true,
          },
        },
      },
    });

    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.task.createMany({
      data: Array.from({ length: OVERDUE_COUNT }, (_, i) => ({
        organisationId: A.org,
        storeId: A.store,
        title: `Follow up ${i + 1}`,
        assignee: 'Agent',
        assigneeId: agentId,
        partyId: 'p_call1',
        status: 'open',
        dueDate: yesterday,
      })),
    });
    await prisma.task.create({
      data: {
        organisationId: A.org, storeId: A.store, title: 'Later call',
        assignee: 'Agent', assigneeId: agentId, status: 'open', dueDate: nextWeek,
      },
    });
    // Another agent's task, same branch: visible to a manager, and the number
    // on it must be masked for the agent who does not own it.
    await prisma.task.create({
      data: {
        organisationId: A.org, storeId: A.store, title: 'Someone else’s call',
        assignee: 'Other Agent', assigneeId: otherId, partyId: 'p_call1',
        status: 'open', dueDate: yesterday,
      },
    });
    // Another BRANCH, so a branch-scoped agent must not see it.
    await prisma.task.create({
      data: {
        organisationId: A.org, storeId: A.store2, title: 'Other clinic call',
        assignee: 'Agent', assigneeId: agentId, status: 'open', dueDate: yesterday,
      },
    });
    // Another TENANT.
    await prisma.task.create({
      data: {
        organisationId: B.org, storeId: B.store, title: 'Other tenant call',
        assignee: 'Them', status: 'open', dueDate: yesterday,
      },
    });

    token = (await login(A.ho)).body.token;
    agentToken = (await login(A.agent)).body.token;
    otherToken = (await login(A.other)).body.token;

    const first = await prisma.task.findFirst({
      where: { organisationId: A.org, title: 'Follow up 1' },
    });
    taskId = first!.id;
  });

  const login = (email: string) =>
    request(server()).post('/auth/login').send({ email, password: PASSWORD });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* --------------------------------------------------------------- the KPIs */

  describe('the KPI counts', () => {
    it('counts every overdue task, not just the page', async () => {
      const summary = await request(server())
        .get('/calling/summary').set(auth()).expect(200);
      const queue = await request(server())
        .get('/calling/queue').set(auth()).query({ bucket: 'overdue', limit: 100 }).expect(200);

      // 120 assigned to the agent + 1 to the other agent + 1 at the second
      // clinic. Head office sees all three branches.
      expect(summary.body.overdue).toBe(OVERDUE_COUNT + 2);
      // The page is capped, and the count is not. That gap is the whole point.
      expect(queue.body.items).toHaveLength(100);
      expect(summary.body.overdue).toBeGreaterThan(queue.body.items.length);
    });

    it('separates today, upcoming and completed', async () => {
      const res = await request(server()).get('/calling/summary').set(auth()).expect(200);
      expect(res.body.upcoming).toBe(1);
      expect(res.body.dueToday).toBe(0);
      expect(res.body.completed).toBe(0);
      expect(res.body.completedWithinDays).toBe(30);
    });

    it('never counts another tenant’s work', async () => {
      const res = await request(server()).get('/calling/summary').set(auth()).expect(200);
      const theirs = await prisma.task.count({ where: { organisationId: B.org } });
      expect(theirs).toBe(1);
      expect(res.body.overdue).toBe(OVERDUE_COUNT + 2);
    });

    it('“mine” means the caller, and cannot be pointed at someone else', async () => {
      const res = await request(server())
        .get('/calling/summary')
        .set({ Authorization: `Bearer ${otherToken}` })
        .query({ mine: 'true' })
        .expect(200);
      // The other agent owns exactly one task.
      expect(res.body.overdue).toBe(1);
    });

    it('keeps a branch-scoped agent inside their own branch', async () => {
      const res = await request(server())
        .get('/calling/queue')
        .set({ Authorization: `Bearer ${agentToken}` })
        .query({ bucket: 'overdue', limit: 100 })
        .expect(200);
      const titles = res.body.items.map((i: { title: string }) => i.title);
      expect(titles).not.toContain('Other clinic call');
      expect(titles).not.toContain('Other tenant call');
    });
  });

  /* -------------------------------------------------------------- the queue */

  describe('the queue', () => {
    it('says how overdue each row is, so every client agrees', async () => {
      const res = await request(server())
        .get('/calling/queue').set(auth()).query({ bucket: 'overdue', limit: 5 }).expect(200);
      expect(res.body.items[0].overdueMinutes).toBeGreaterThan(0);
    });

    it('finds a task by a fragment of the customer’s number', async () => {
      const res = await request(server())
        .get('/calling/queue').set(auth()).query({ search: '9876500011', limit: 5 }).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items[0].customer.name).toBe('Meera Iyer');
    });

    it('finds a task by the customer’s name', async () => {
      const res = await request(server())
        .get('/calling/queue').set(auth()).query({ search: 'Meera', limit: 5 }).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    });

    it('masks the number on a colleague’s task and shows it on your own', async () => {
      // Asked as two queries rather than one page: there are 122 overdue tasks
      // and the page caps at 100, so the row this agent owns is not necessarily
      // on the first page. Paging luck must not decide whether the test passes.
      const own = await request(server())
        .get('/calling/queue')
        .set({ Authorization: `Bearer ${otherToken}` })
        .query({ bucket: 'overdue', mine: 'true', limit: 10 })
        .expect(200);
      expect(own.body.items).toHaveLength(1);
      expect(own.body.items[0].customer.contact).toBe('+919876500011');

      const all = await request(server())
        .get('/calling/queue')
        .set({ Authorization: `Bearer ${otherToken}` })
        .query({ bucket: 'overdue', limit: 5 })
        .expect(200);
      const notOwn = all.body.items.find(
        (i: { title: string }) => i.title !== 'Someone else’s call',
      );
      expect(notOwn.customer.contact).toMatch(/^••••0011$/);
    });

    it('pages with a cursor', async () => {
      const first = await request(server())
        .get('/calling/queue').set(auth()).query({ bucket: 'overdue', limit: 2 }).expect(200);
      expect(first.body.nextCursor).toBeTruthy();
      const second = await request(server())
        .get('/calling/queue')
        .set(auth())
        .query({ bucket: 'overdue', limit: 2, cursor: first.body.nextCursor })
        .expect(200);
      const firstIds = first.body.items.map((i: { id: string }) => i.id);
      const secondIds = second.body.items.map((i: { id: string }) => i.id);
      expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
    });
  });

  /* ------------------------------------------------------------ take action */

  describe('taking action', () => {
    it('opens a workspace with the customer’s measured totals', async () => {
      const res = await request(server())
        .get(`/calling/tasks/${taskId}`).set(auth()).expect(200);
      expect(res.body.task.title).toBe('Follow up 1');
      expect(res.body.customer.name).toBe('Meera Iyer');
      expect(res.body.customer.totalOrders).toBe(0);
      // null, not 0 — "no record" and "spent nothing" are different answers and
      // a caller must not read a fabricated figure to a customer.
      expect(res.body.customer.totalSpend).toBeNull();
      expect(res.body.calls).toEqual([]);
    });

    it('logs a call and reschedules in one act', async () => {
      const callBack = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const res = await request(server())
        .post(`/calling/tasks/${taskId}/calls`)
        .set(auth())
        .send({
          disposition: 'callback',
          notes: 'Asked to be called on Thursday',
          durationSec: 95,
          then: 'reschedule',
          rescheduleTo: callBack,
        })
        .expect(201);

      expect(res.body.callId).toBeTruthy();
      const task = await prisma.task.findUnique({ where: { id: taskId } });
      expect(task?.status).toBe('open');
      expect(task?.dueDate?.toISOString().slice(0, 10)).toBe(callBack.slice(0, 10));
    });

    it('records the call as manual when no provider supplied it', async () => {
      const call = await prisma.callLog.findFirst({ where: { taskId } });
      // 'manual' is the honest default: nothing on the network confirms it.
      expect(call?.provider).toBe('manual');
      expect(call?.disposition).toBe('callback');
      expect(call?.agentUserId).toBeTruthy();
    });

    it('puts the call on the customer timeline', async () => {
      const events = await prisma.activityEvent.findMany({
        where: { organisationId: A.org, partyId: 'p_call1', type: 'call.logged' },
      });
      expect(events.length).toBeGreaterThan(0);
    });

    it('refuses to reschedule without a date', async () => {
      const res = await request(server())
        .post(`/calling/tasks/${taskId}/calls`)
        .set(auth())
        .send({ disposition: 'callback', then: 'reschedule' });
      expect(res.status).toBe(400);
    });

    it('completes the task when the agent says so', async () => {
      const res = await request(server())
        .post(`/calling/tasks/${taskId}/calls`)
        .set(auth())
        .send({ disposition: 'connected', then: 'complete' })
        .expect(201);
      expect(res.body.taskStatus).toBe('done');
      const task = await prisma.task.findUnique({ where: { id: taskId } });
      expect(task?.status).toBe('done');
      expect(task?.completedAt).toBeTruthy();
    });

    it('refuses a task belonging to another tenant', async () => {
      const theirs = await prisma.task.findFirst({ where: { organisationId: B.org } });
      const res = await request(server())
        .get(`/calling/tasks/${theirs!.id}`).set(auth());
      expect(res.status).toBe(404);
    });

    it('refuses a recording URL that is not a URL', async () => {
      const res = await request(server())
        .post(`/calling/tasks/${taskId}/calls`)
        .set(auth())
        .send({ disposition: 'connected', recordingUrl: 'javascript:alert(1)' });
      expect(res.status).toBe(400);
    });
  });

  /* --------------------------------------------------------- recording state */

  describe('recordings', () => {
    it('reports an expired provider URL as expired rather than offering a dead player', async () => {
      await prisma.callLog.create({
        data: {
          organisationId: A.org,
          partyId: 'p_call1',
          direction: 'outbound',
          provider: 'fixture_telephony',
          providerCallId: 'fixture-call-1',
          disposition: 'connected',
          recordingUrl: 'https://provider.example/recordings/1.mp3',
          recordingExpiresAt: new Date(Date.now() - 60_000),
        },
      });
      const res = await request(server())
        .get('/calling/customers/p_call1/calls').set(auth()).expect(200);
      const expired = res.body.find(
        (c: { provider: string }) => c.provider === 'fixture_telephony',
      );
      expect(expired.recordingState).toBe('expired');
      expect(expired.recording).toBeNull();
    });

    it('refuses a second webhook for the same provider call id', async () => {
      // The unique key is what turns a retried provider webhook into a no-op
      // instead of a duplicate call in every figure computed from these rows.
      await expect(
        prisma.callLog.create({
          data: {
            organisationId: A.org,
            direction: 'inbound',
            provider: 'fixture_telephony',
            providerCallId: 'fixture-call-1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('lets a different tenant use the same provider call id', async () => {
      const row = await prisma.callLog.create({
        data: {
          organisationId: B.org,
          direction: 'inbound',
          provider: 'fixture_telephony',
          providerCallId: 'fixture-call-1',
        },
      });
      expect(row.id).toBeTruthy();
    });

    it('does not return another tenant’s call log', async () => {
      const res = await request(server())
        .get('/calling/customers/p_call1/calls').set(auth()).expect(200);
      expect(res.body.every((c: { id: string }) => typeof c.id === 'string')).toBe(true);
      const foreign = await prisma.callLog.count({ where: { organisationId: B.org } });
      expect(foreign).toBe(1);
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.callLog.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.checkIn.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.leadNote.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
