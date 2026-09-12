import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { ConversationsService } from '../src/crm/conversations.service';
import type { ResponseSlaService } from '../src/crm/response-sla.service';

/**
 * The five-minute promise.
 *
 * From the meeting: a customer who messages must hear back within five minutes.
 * The properties pinned here are the ones that decide whether the feature is a
 * measurement or a decoration.
 *
 *  1. OFF UNTIL SOMEBODY PICKS A NUMBER. No clocks, no alerts, no behaviour
 *     change for an existing tenant. Five is Éclat's number, not the product's.
 *
 *  2. AN ANSWER IS A PERSON, OR AN AI REPLY A PERSON APPROVED. A system
 *     acknowledgement does not stop the clock; nor does a message that failed to
 *     send; nor does a draft nobody has read. Each of those, counted as an
 *     answer, would make the report claim success for a customer still waiting.
 *
 *  3. ONE CLOCK PER THREAD. A customer sending three messages in a row is not
 *     three separate promises, and must not restart the timer.
 *
 *  4. EXACTLY ONCE, ACROSS RESTARTS AND REPLICAS. The breach alert, the calling
 *     queue task and the escalation each happen once however many times the
 *     sweep runs. This is the one that a naive implementation gets wrong on the
 *     second tick, and the customer's assigned rep gets an alert every minute
 *     until they mute the bell.
 *
 *  5. THE BRANCH'S CALENDAR, NOT THE SERVER'S. A breach at a store on the other
 *     side of the dateline files its task on that store's today.
 *
 *  6. A LATE REPLY DOES NOT UN-BREACH. It records how long they actually waited.
 *
 *  7. NOBODY IS DIALLED. The setting can be switched on; with no provider that
 *     can place a call, nothing is called and the reason says so.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_sla_a',
  slug: 'sla-a',
  /** UTC+14. Paired with `west` below so their local dates ALWAYS differ. */
  east: 'store_sla_east',
  /** UTC-11. 25 hours apart from `east`, at every instant of the year. */
  west: 'store_sla_west',
  ho: 'ho.sla@sla-a.local',
  mgr: 'mgr.sla@sla-a.local',
  rep: 'rep.sla@sla-a.local',
};

const MIN = 60_000;

async function teardown(prisma: PrismaService) {
  await prisma.conversationResponseSla.deleteMany({ where: { organisationId: A.org } });
  await prisma.conversationSlaSettings.deleteMany({ where: { organisationId: A.org } });
  await prisma.notification.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.task.deleteMany({ where: { organisationId: A.org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.aiDraftRecord.deleteMany({ where: { organisationId: A.org } });
  await prisma.message.deleteMany({ where: { organisationId: A.org } });
  await prisma.conversation.deleteMany({ where: { organisationId: A.org } });
  await prisma.lead.deleteMany({ where: { organisationId: A.org } });
  await prisma.contactPoint.deleteMany({ where: { party: { organisationId: A.org } } });
  await prisma.party.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

describe('First-response SLA (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let sla: ResponseSlaService;

  let hoT: string;
  let mgrT: string;
  let repT: string;
  let threadSeq = 0;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /**
   * A customer messages, `minutesAgo` minutes ago.
   *
   * Backdating the message rather than sleeping is what makes every deadline in
   * this file exact: the clock is derived from the message's own instant, so a
   * thread that started seven minutes ago is genuinely past a five-minute target
   * without the suite waiting for it.
   */
  async function inbound(opts: {
    minutesAgo: number;
    storeId?: string | null;
    assignTo?: string | null;
    thread?: string;
  }) {
    threadSeq += 1;
    const key = opts.thread ?? `sla-thread-${threadSeq}`;
    const at = new Date(Date.now() - opts.minutesAgo * MIN);
    const res = await conversations.ingestInbound({
      organisationId: A.org,
      channel: 'whatsapp',
      externalThreadId: key,
      externalId: `wamid.sla.${threadSeq}`,
      senderKind: 'whatsapp',
      senderValue: `9198000${String(10000 + threadSeq)}`,
      body: 'Is the pendant still available?',
      storeId: opts.storeId === undefined ? A.east : opts.storeId,
      sentAt: at,
    });
    if (opts.assignTo !== undefined && opts.assignTo !== null) {
      await prisma.conversation.update({
        where: { id: res.conversationId },
        data: { assignedUserId: opts.assignTo },
      });
    }
    return { conversationId: res.conversationId, at };
  }

  /** An outbound message of a given flavour, `minutesAgo` minutes ago. */
  async function reply(
    conversationId: string,
    opts: {
      minutesAgo: number;
      authorType?: string;
      authorUserId?: string | null;
      status?: string;
      aiReview?: string;
    },
  ) {
    const message = await prisma.message.create({
      data: {
        organisationId: A.org,
        conversationId,
        direction: 'outbound',
        authorType: opts.authorType ?? 'agent',
        authorUserId: opts.authorUserId ?? null,
        status: opts.status ?? 'sent',
        body: 'Yes, it is.',
        sentAt: new Date(Date.now() - opts.minutesAgo * MIN),
      },
      select: { id: true },
    });
    if (opts.aiReview) {
      await prisma.aiDraftRecord.create({
        data: {
          organisationId: A.org,
          messageId: message.id,
          conversationId,
          provider: 'test',
          model: 'test',
          confidence: 0.9,
          policyVersion: 'test',
          review: opts.aiReview,
        },
      });
    }
    return message.id;
  }

  const clockFor = (conversationId: string) =>
    prisma.conversationResponseSla.findFirst({ where: { conversationId } });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { ConversationsService: C } = await import('../src/crm/conversations.service');
    const { ResponseSlaService: S } = await import('../src/crm/response-sla.service');

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
    prisma = app.get(P);
    conversations = app.get(C);
    sla = app.get(S);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    // Retail on purpose: answering a customer quickly is not a jewellery
    // feature, and the capability registry classifies /crm as universal.
    await prisma.organisation.create({
      data: { id: A.org, name: 'SLA A', slug: A.slug, industryPackCode: 'retail' },
    });
    await prisma.store.createMany({
      data: [
        {
          id: A.east,
          name: 'Kiritimati Counter',
          city: 'Kiritimati',
          organisationId: A.org,
          timezone: 'Pacific/Kiritimati',
        },
        {
          id: A.west,
          name: 'Niue Counter',
          city: 'Alofi',
          organisationId: A.org,
          timezone: 'Pacific/Niue',
        },
      ],
    });
    for (const [id, email, role, storeId] of [
      ['u_sla_ho', A.ho, 'head_office', A.east],
      ['u_sla_mgr', A.mgr, 'store_manager', A.east],
      ['u_sla_rep', A.rep, 'salesperson', A.east],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: A.org,
          userStores: { create: { storeId, isPrimary: true } },
        },
      });
    }
    // The manager also covers the western branch, so escalation there has a
    // recipient and the two-timezone test is not measuring an empty fan-out.
    await prisma.userStore.create({ data: { userId: 'u_sla_mgr', storeId: A.west } });

    const login = async (email: string) =>
      (
        await request(server())
          .post('/auth/login')
          .send({ email, password: PASSWORD })
          .expect(201)
      ).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    repT = await login(A.rep);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. Off until somebody picks a number
  // ==========================================================================

  it('is off by default — an inbound message opens no clock at all', async () => {
    const view = await request(server()).get('/crm/sla/settings').set(auth(repT)).expect(200);
    expect(view.body.firstResponseMinutes).toBeNull();
    expect(view.body.active).toBe(false);

    const { conversationId } = await inbound({ minutesAgo: 30 });
    expect(await clockFor(conversationId)).toBeNull();

    // And a sweep with nothing to sweep is not an error.
    const res = await sla.sweep(new Date(), { organisationId: A.org });
    expect(res.examined).toBe(0);
  });

  it('only head office sets the promise', async () => {
    await request(server())
      .put('/crm/sla/settings')
      .set(auth(mgrT))
      .send({ firstResponseMinutes: 5 })
      .expect(403);

    const ok = await request(server())
      .put('/crm/sla/settings')
      .set(auth(hoT))
      .send({ firstResponseMinutes: 5, escalateAfterMinutes: 15 })
      .expect(200);
    expect(ok.body.firstResponseMinutes).toBe(5);
    expect(ok.body.active).toBe(true);
  });

  it('escalation cannot be sooner than the target it escalates', async () => {
    // Counted from the customer's message, so 3 would fire before anybody was
    // late — the fastest way to get an escalation channel muted.
    const bad = await request(server())
      .put('/crm/sla/settings')
      .set(auth(hoT))
      .send({ escalateAfterMinutes: 3 })
      .expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/sooner than/i);

    // Unchanged by the rejected write.
    const view = await request(server()).get('/crm/sla/settings').set(auth(hoT)).expect(200);
    expect(view.body.escalateAfterMinutes).toBe(15);
  });

  // ==========================================================================
  // 2. Starting and stopping the clock
  // ==========================================================================

  it('a customer message starts a clock with a deadline five minutes out', async () => {
    const { conversationId, at } = await inbound({ minutesAgo: 0 });
    const clock = await clockFor(conversationId);
    expect(clock).toBeTruthy();
    expect(clock!.status).toBe('waiting');
    expect(clock!.targetMinutes).toBe(5);
    expect(clock!.openConversationId).toBe(conversationId);
    expect(clock!.dueAt.getTime() - at.getTime()).toBe(5 * MIN);
    expect(clock!.escalateAt!.getTime() - at.getTime()).toBe(15 * MIN);
  });

  it('a customer sending three messages in a row is still one promise', async () => {
    const thread = 'sla-impatient';
    const first = await inbound({ minutesAgo: 4, thread });
    await inbound({ minutesAgo: 2, thread });
    await inbound({ minutesAgo: 1, thread });

    const clocks = await prisma.conversationResponseSla.findMany({
      where: { conversationId: first.conversationId },
    });
    expect(clocks).toHaveLength(1);
    // Measured from the FIRST unanswered message. If the later messages had
    // restarted it, a thread nobody answers would never breach at all.
    expect(clocks[0].startedAt.getTime()).toBe(first.at.getTime());
  });

  it('a reply inside the target meets it, and records how long they waited', async () => {
    const { conversationId } = await inbound({ minutesAgo: 6 });
    await reply(conversationId, { minutesAgo: 4, authorUserId: 'u_sla_rep' });

    await sla.sweep(new Date(), { organisationId: A.org });

    const clock = await clockFor(conversationId);
    expect(clock!.status).toBe('met');
    expect(clock!.responderId).toBe('u_sla_rep');
    expect(clock!.responderType).toBe('agent');
    // 6 minutes ago to 4 minutes ago: two minutes, to the second.
    expect(clock!.responseSeconds).toBe(120);
    expect(clock!.breachedAt).toBeNull();
    // The clock is closed, which is what frees the thread to start a new one.
    expect(clock!.openConversationId).toBeNull();

    // Nothing was queued and nobody was chased for a thread that was answered.
    const tasks = await prisma.task.count({ where: { organisationId: A.org, priority: 'urgent' } });
    expect(tasks).toBe(0);
  });

  // ==========================================================================
  // 3. What does NOT count as an answer
  // ==========================================================================

  it('an automatic acknowledgement does not count as answering the customer', async () => {
    const { conversationId } = await inbound({ minutesAgo: 7 });
    await reply(conversationId, { minutesAgo: 6, authorType: 'system' });

    await sla.sweep(new Date(), { organisationId: A.org });

    const clock = await clockFor(conversationId);
    expect(clock!.status).toBe('breached');
    expect(clock!.respondedAt).toBeNull();
  });

  it('a reply that failed to send does not count — the customer never got it', async () => {
    const { conversationId } = await inbound({ minutesAgo: 7 });
    await reply(conversationId, { minutesAgo: 6, status: 'failed', authorUserId: 'u_sla_rep' });

    await sla.sweep(new Date(), { organisationId: A.org });
    expect((await clockFor(conversationId))!.status).toBe('breached');
  });

  it('an AI draft nobody approved does not count; an approved one does', async () => {
    const pending = await inbound({ minutesAgo: 7 });
    await reply(pending.conversationId, {
      minutesAgo: 6,
      authorType: 'ai',
      aiReview: 'pending',
    });
    await sla.sweep(new Date(), { organisationId: A.org });
    expect((await clockFor(pending.conversationId))!.status).toBe('breached');

    const approved = await inbound({ minutesAgo: 4 });
    await reply(approved.conversationId, {
      minutesAgo: 2,
      authorType: 'ai',
      aiReview: 'approved',
    });
    await sla.sweep(new Date(), { organisationId: A.org });
    const clock = await clockFor(approved.conversationId);
    expect(clock!.status).toBe('met');
    // Recorded as the AI's, never as a person's.
    expect(clock!.responderType).toBe('ai');
    expect(clock!.responderId).toBeNull();
  });

  // ==========================================================================
  // 4. The breach: who hears about it, and exactly once
  // ==========================================================================

  it('a breach alerts the assigned employee and lands in the calling queue', async () => {
    const { conversationId } = await inbound({ minutesAgo: 7, assignTo: 'u_sla_rep' });

    const res = await sla.sweep(new Date(), { organisationId: A.org });
    expect(res.breached).toBe(1);

    const clock = await clockFor(conversationId);
    expect(clock!.status).toBe('breached');
    expect(clock!.breachedAt).toBeTruthy();
    expect(clock!.taskId).toBeTruthy();

    const task = await prisma.task.findUnique({ where: { id: clock!.taskId! } });
    expect(task!.priority).toBe('urgent');
    expect(task!.status).toBe('open');
    expect(task!.assigneeId).toBe('u_sla_rep');
    expect(task!.storeId).toBe(A.east);

    const notes = await prisma.notification.findMany({
      where: { userId: 'u_sla_rep', entityId: conversationId },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].priority).toBe('high');
  });

  it('sweeping again changes nothing — one breach, one task, one alert', async () => {
    const { conversationId } = await inbound({ minutesAgo: 9, assignTo: 'u_sla_rep' });
    await sla.sweep(new Date(), { organisationId: A.org });
    const first = await clockFor(conversationId);

    // Four more ticks. A minute-granular sweep runs 1,440 times a day against a
    // thread nobody answers; if any of this were not claimed, the rep would get
    // an alert every minute until they muted the bell.
    for (let i = 0; i < 4; i++) await sla.sweep(new Date(), { organisationId: A.org });

    const after = await clockFor(conversationId);
    expect(after!.breachedAt!.getTime()).toBe(first!.breachedAt!.getTime());
    expect(after!.taskId).toBe(first!.taskId);

    expect(
      await prisma.task.count({ where: { organisationId: A.org, title: { contains: 'Reply overdue' }, id: after!.taskId! } }),
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { userId: 'u_sla_rep', entityId: conversationId } }),
    ).toBe(1);
  });

  it('an unassigned overdue thread goes to the managers, not nobody', async () => {
    const { conversationId } = await inbound({ minutesAgo: 8, assignTo: null });
    await sla.sweep(new Date(), { organisationId: A.org });

    const note = await prisma.notification.findFirst({
      where: { userId: 'u_sla_mgr', entityId: conversationId },
    });
    expect(note).toBeTruthy();
    expect(note!.title).toMatch(/nobody is assigned/i);
  });

  it('a reply after the breach records the wait but does not un-breach it', async () => {
    const { conversationId } = await inbound({ minutesAgo: 20, assignTo: 'u_sla_rep' });
    await sla.sweep(new Date(), { organisationId: A.org });
    expect((await clockFor(conversationId))!.status).toBe('breached');

    await reply(conversationId, { minutesAgo: 8, authorUserId: 'u_sla_rep' });
    await sla.sweep(new Date(), { organisationId: A.org });

    const clock = await clockFor(conversationId);
    // The breach happened. A late reply does not unhappen it.
    expect(clock!.status).toBe('breached');
    expect(clock!.respondedAt).toBeTruthy();
    // 20 minutes ago to 8 minutes ago.
    expect(clock!.responseSeconds).toBe(12 * 60);
  });

  // ==========================================================================
  // 5. Escalation
  // ==========================================================================

  it('escalates to the store manager once, and not to the person already chased', async () => {
    const { conversationId } = await inbound({ minutesAgo: 40, assignTo: 'u_sla_rep' });

    const first = await sla.sweep(new Date(), { organisationId: A.org });
    expect(first.breached).toBe(1);
    expect(first.escalated).toBe(1);

    // A restart, then three more ticks.
    for (let i = 0; i < 3; i++) await sla.sweep(new Date(), { organisationId: A.org });

    const clock = await clockFor(conversationId);
    expect(clock!.escalatedAt).toBeTruthy();

    const managerNotes = await prisma.notification.findMany({
      where: { userId: 'u_sla_mgr', entityId: conversationId },
    });
    expect(managerNotes).toHaveLength(1);
    expect(managerNotes[0].title).toMatch(/still unanswered/i);

    // The rep got the breach alert and nothing else: escalating means somebody
    // ELSE now knows, not that the same person is told twice.
    const repNotes = await prisma.notification.findMany({
      where: { userId: 'u_sla_rep', entityId: conversationId },
    });
    expect(repNotes).toHaveLength(1);
    expect(repNotes[0].title).not.toMatch(/still unanswered/i);
  });

  it('a tenant that never escalates still breaches and still chases', async () => {
    await request(server())
      .put('/crm/sla/settings')
      .set(auth(hoT))
      .send({ escalateAfterMinutes: null })
      .expect(200);

    const { conversationId } = await inbound({ minutesAgo: 60, assignTo: 'u_sla_rep' });
    const clock = await clockFor(conversationId);
    expect(clock!.escalateAt).toBeNull();

    const res = await sla.sweep(new Date(), { organisationId: A.org });
    expect(res.escalated).toBe(0);
    expect((await clockFor(conversationId))!.status).toBe('breached');
    expect((await clockFor(conversationId))!.escalatedAt).toBeNull();

    await request(server())
      .put('/crm/sla/settings')
      .set(auth(hoT))
      .send({ escalateAfterMinutes: 15 })
      .expect(200);
  });

  // ==========================================================================
  // 6. The branch's calendar, not the server's
  // ==========================================================================

  it('the queue task is dated at the BRANCH, not wherever the server is', async () => {
    // Kiritimati is UTC+14, Niue is UTC-11: twenty-five hours apart, so their
    // local calendar dates differ at every instant of the year. If the task were
    // dated from the server's clock the two would match, and a store across the
    // dateline would never see its own overdue work in "due today".
    const east = await inbound({ minutesAgo: 7, storeId: A.east, assignTo: 'u_sla_rep' });
    const west = await inbound({ minutesAgo: 7, storeId: A.west, assignTo: 'u_sla_rep' });

    await sla.sweep(new Date(), { organisationId: A.org });

    const eastClock = await clockFor(east.conversationId);
    const westClock = await clockFor(west.conversationId);
    const eastTask = await prisma.task.findUnique({ where: { id: eastClock!.taskId! } });
    const westTask = await prisma.task.findUnique({ where: { id: westClock!.taskId! } });

    expect(eastTask!.dueDate).toBeTruthy();
    expect(westTask!.dueDate).toBeTruthy();
    expect(eastTask!.dueDate!.toISOString()).not.toBe(westTask!.dueDate!.toISOString());
  });

  // ==========================================================================
  // 7. Nothing dials
  // ==========================================================================

  it('switching automatic calling on still places no call, and says why', async () => {
    const res = await request(server())
      .put('/crm/sla/settings')
      .set(auth(hoT))
      .send({ autoCallOnBreach: true })
      .expect(200);
    expect(res.body.autoCallOnBreach).toBe(true);
    // The flag being on is not the same as a provider existing, and the screen
    // is told which of the two is true.
    expect(res.body.autoCallBlockedReason).toMatch(/no telephony provider/i);

    const { conversationId } = await inbound({ minutesAgo: 7, assignTo: 'u_sla_rep' });
    await sla.sweep(new Date(), { organisationId: A.org });

    expect((await clockFor(conversationId))!.status).toBe('breached');
    // No call log invented for a call nothing placed.
    expect(await prisma.callLog.count({ where: { organisationId: A.org } })).toBe(0);

    await request(server())
      .put('/crm/sla/settings')
      .set(auth(hoT))
      .send({ autoCallOnBreach: false })
      .expect(200);
  });

  // ==========================================================================
  // 8. Reading it back
  // ==========================================================================

  it('the KPIs are aggregates, and the list filters by state', async () => {
    const summary = await request(server())
      .get('/crm/sla/summary?days=1')
      .set(auth(mgrT))
      .expect(200);

    expect(summary.body.targetMinutes).toBe(5);
    expect(summary.body.active).toBe(true);
    expect(summary.body.tracked).toBeGreaterThan(0);
    expect(summary.body.breached).toBeGreaterThan(0);
    expect(summary.body.met).toBeGreaterThan(0);
    expect(summary.body.medianResponseSeconds).toBeGreaterThan(0);
    expect(summary.body.withinTargetPct).not.toBeNull();

    // The counts agree with the database, not with the page the list returns.
    const dbBreached = await prisma.conversationResponseSla.count({
      where: { organisationId: A.org, status: 'breached' },
    });
    expect(summary.body.breached).toBe(dbBreached);

    const breaches = await request(server())
      .get('/crm/sla/clocks?status=breached&days=1&limit=200')
      .set(auth(mgrT))
      .expect(200);
    expect(breaches.body).toHaveLength(dbBreached);
    expect(breaches.body.every((r: { status: string }) => r.status === 'breached')).toBe(true);
    expect(breaches.body[0].targetMinutes).toBe(5);

    await request(server())
      .get('/crm/sla/clocks?status=nonsense')
      .set(auth(mgrT))
      .expect(400);
  });

  it('a salesperson sees the breach but not whose queue it landed in', async () => {
    const rows = await request(server())
      .get('/crm/sla/clocks?status=breached&days=1')
      .set(auth(repT))
      .expect(200);
    expect(rows.body.length).toBeGreaterThan(0);
    expect(rows.body.every((r: { taskId: string | null }) => r.taskId === null)).toBe(true);
  });

  it('turning it off stops new clocks and leaves the history intact', async () => {
    const before = await prisma.conversationResponseSla.count({ where: { organisationId: A.org } });

    await request(server())
      .put('/crm/sla/settings')
      .set(auth(hoT))
      .send({ firstResponseMinutes: null })
      .expect(200);

    const { conversationId } = await inbound({ minutesAgo: 30 });
    expect(await clockFor(conversationId)).toBeNull();
    expect(await prisma.conversationResponseSla.count({ where: { organisationId: A.org } })).toBe(
      before,
    );

    // Turning it off clears the escalation with it. Otherwise the stale 15 would
    // refuse the very write that switches the feature off, and a tenant could
    // only turn it off by knowing to send two fields at once.
    const view = await request(server()).get('/crm/sla/settings').set(auth(hoT)).expect(200);
    expect(view.body.escalateAfterMinutes).toBeNull();
    expect(view.body.active).toBe(false);
  });
});
