import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/auth-user';
import { FollowUpRemindersService } from '../src/crm/follow-up-reminders.service';
import { VisitFeedbackService } from '../src/crm/visit-feedback.service';
import { ChannelAdaptersService } from '../src/integrations/adapters/channel-adapters.service';
import { WhatsAppService } from '../src/integrations/whatsapp.service';
import { JobsService } from '../src/jobs/jobs.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { OmnichannelService } from '../src/omnichannel/omnichannel.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Block 3: what the counter promised, and asking how the visit went.
 *
 * Reminders
 *  1. THREE FIELDS, THREE MEANINGS. Follow-up date = when the customer is owed;
 *     reminder = when the employee is told; remark = what was said.
 *  2. THE BRANCH'S CLOCK, including across a daylight-saving change.
 *  3. A TENANT DEFAULT when nobody picks a time; refused when a picked time is
 *     after the follow-up day or already past.
 *  4. ONE REMINDER, whatever retries do; a failed notification is released and
 *     retried rather than lost.
 *
 * Visit feedback
 *  5. OFF UNLESS THE TENANT TURNS IT ON; booked only for a visit with no
 *     follow-up, once per visit, on the Nth LOCAL day.
 *  6. SENT THROUGH THE OUTBOX, counted as sent only when the provider takes it.
 *  7. STOP AND ARCHIVE ARE HONOURED: cancelled, not handed to a colleague.
 *  8. NO TEMPLATE / NOT LIVE / UNDELIVERED → A TASK for the person who served
 *     them, with the reason, and never "sent".
 *  9. A SWEEP THAT THROWS IS RETRIED; A DUPLICATE SWEEP SENDS NOTHING TWICE.
 */

const PASSWORD = 'password123';
const A = {
  org: 'org_b3_a', slug: 'b3-a', ist: 'store_b3_ist', ny: 'store_b3_ny', integ: 'int_b3_a',
  ho: 'ho@b3-a.local', rep: 'rep@b3-a.local',
};
const FEEDBACK_TEMPLATE = 'visit_feedback';

class FakeWhatsApp {
  sends: { to: string; name: string; components?: unknown }[] = [];
  async sendText() {
    throw new Error('an automatic ask never sends free text');
  }
  async sendTemplate(_org: string, to: string, name: string, _lang?: string, components?: unknown) {
    this.sends.push({ to, name, components });
    return { delivered: true, dryRun: false, messageId: `wamid.b3.${this.sends.length}`, to };
  }
  async enabledFor() {
    return true;
  }
}

async function teardown(prisma: PrismaService) {
  const org = A.org;
  await prisma.notification.deleteMany({ where: { user: { organisationId: org } } });
  await prisma.task.deleteMany({ where: { organisationId: org } });
  await prisma.feedbackRequest.deleteMany({ where: { organisationId: org } });
  await prisma.message.deleteMany({ where: { organisationId: org } });
  await prisma.conversation.deleteMany({ where: { organisationId: org } });
  await prisma.jobTask.deleteMany({ where: { organisationId: org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: org } });
  await prisma.checkIn.deleteMany({ where: { organisationId: org } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } });
  await prisma.lead.deleteMany({ where: { organisationId: org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
  await prisma.party.deleteMany({ where: { organisationId: org } });
  await prisma.integrationAsset.deleteMany({ where: { organisationId: org } });
  await prisma.integration.deleteMany({ where: { organisationId: org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
  await prisma.user.deleteMany({ where: { organisationId: org } });
  await prisma.store.deleteMany({ where: { organisationId: org } });
  await prisma.organisation.deleteMany({ where: { id: org } });
}

describe('Follow-up reminders and visit feedback (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reminders: FollowUpRemindersService;
  let visits: VisitFeedbackService;
  let jobs: JobsService;
  let omnichannel: OmnichannelService;
  let adapters: ChannelAdaptersService;
  let notifications: NotificationsService;
  const whatsapp = new FakeWhatsApp();
  let ho = '';
  let rep = '';
  let phoneSeq = 0;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const hoUser: AuthUser = {
    id: 'u_b3_ho', name: 'HO', email: A.ho, role: Role.head_office,
    organisationId: A.org, storeIds: [A.ist, A.ny], allStores: true,
  };

  /** A walk-in with a customer record, returned by id. */
  const walkIn = async (token: string, storeId = A.ist, name = 'Walk In') => {
    phoneSeq += 1;
    const res = await request(server())
      .post('/checkins')
      .set(auth(token))
      .send({ storeId, customerName: name, phone: `98123${String(40000 + phoneSeq).padStart(5, '0')}` })
      .expect(201);
    return res.body.id as string;
  };
  const checkout = (token: string, id: string, body: Record<string, unknown>, storeId = A.ist) =>
    request(server()).patch(`/checkins/${id}`).set({ ...auth(token), 'X-Store-Id': storeId }).send(body);
  const followUpFor = async (checkInId: string) => {
    const visit = await prisma.checkIn.findUniqueOrThrow({ where: { id: checkInId } });
    return prisma.leadFollowUp.findFirst({
      where: { leadId: visit.leadId!, dueDate: visit.followUpDate! },
      orderBy: { createdAt: 'desc' },
    });
  };
  const live = () =>
    jest.spyOn(adapters, 'deliverability').mockResolvedValue({
      channel: 'whatsapp', state: 'live', code: 'ready', reason: 'test sender', verified: false,
    } as never);

  const setTemplate = () =>
    prisma.integrationAsset.create({
      data: {
        organisationId: A.org, integrationId: A.integ, kind: 'message_template',
        externalId: `${FEEDBACK_TEMPLATE}:en`, name: FEEDBACK_TEMPLATE, isActive: true,
        providerOwnershipVerified: true, lastVerifiedAt: new Date(),
        metadata: {
          channel: 'whatsapp', languageCode: 'en', category: 'utility', approvalStatus: 'pending',
          variables: [], recordedAt: new Date().toISOString(), providerStatus: 'APPROVED',
          providerSyncedAt: new Date().toISOString(),
        },
      },
    });

  beforeAll(async () => {
    process.env.PUBLIC_APP_URL = 'https://app.caratos.test';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppService)
      .useValue(whatsapp)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    reminders = app.get(FollowUpRemindersService);
    visits = app.get(VisitFeedbackService);
    jobs = app.get(JobsService);
    omnichannel = app.get(OmnichannelService);
    adapters = app.get(ChannelAdaptersService);
    notifications = app.get(NotificationsService);
    await teardown(prisma);

    await prisma.organisation.create({
      data: { id: A.org, name: 'Block Three', slug: A.slug, industryPackCode: 'retail', country: 'IN' },
    });
    await prisma.store.createMany({
      data: [
        { id: A.ist, name: 'Mumbai', city: 'Mumbai', organisationId: A.org, timezone: 'Asia/Kolkata' },
        { id: A.ny, name: 'New York', city: 'New York', organisationId: A.org, timezone: 'America/New_York' },
      ],
    });
    await prisma.integration.create({
      data: {
        id: A.integ, organisationId: A.org, providerCode: 'whatsapp_cloud', name: 'WhatsApp',
        status: 'connected', config: { whatsappBusinessAccountId: '110022003300' },
      },
    });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [id, email, role] of [
      ['u_b3_ho', A.ho, 'head_office'],
      ['u_b3_rep', A.rep, 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          id, email, name: `${id} Person`, role: role as never, passwordHash: hash, isActive: true,
          approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: [{ storeId: A.ist, isPrimary: true }, { storeId: A.ny }] },
        },
      });
    }
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token;
    ho = await login(A.ho);
    rep = await login(A.rep);
  }, 120_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  /* ============================================================= reminders */

  describe('follow-up reminders', () => {
    it('a follow-up date with no reminder gets the tenant default, at the branch', async () => {
      const id = await walkIn(rep);
      await checkout(rep, id, { outcome: 'follow_up', followUpDate: '2026-10-02', remark: 'Wants the pair' }).expect(200);
      const fu = await followUpFor(id);
      // 10:00 in Kolkata is 04:30 UTC.
      expect(fu?.reminderAt?.toISOString()).toBe('2026-10-02T04:30:00.000Z');
      expect(fu?.assigneeId).toBe('u_b3_rep');
      expect(fu?.reminderNotifiedAt).toBeNull();

      const list = await request(server()).get('/checkins').set(auth(rep)).expect(200);
      const row = list.body.find((c: { id: string }) => c.id === id);
      expect(row.reminder).toMatchObject({ local: '2026-10-02T10:00', state: 'scheduled' });
      expect(row.remark).toBe('Wants the pair');
      expect(row.feedback).toBeNull();
    });

    it('an explicit reminder is its own instant, the evening before', async () => {
      const id = await walkIn(rep);
      await checkout(rep, id, { followUpDate: '2026-10-02', reminderAt: '2026-10-01T18:00' }).expect(200);
      expect((await followUpFor(id))?.reminderAt?.toISOString()).toBe('2026-10-01T12:30:00.000Z');
    });

    it('reads the reminder on the branch clock across a daylight-saving change', async () => {
      // 1 November 2026 is the day New York leaves daylight time (-4 → -5).
      const id = await walkIn(rep, A.ny);
      await checkout(rep, id, { followUpDate: '2026-11-01', reminderAt: '2026-11-01T09:00' }, A.ny).expect(200);
      expect((await followUpFor(id))?.reminderAt?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
      // The day before is still daylight time.
      const id2 = await walkIn(rep, A.ny);
      await checkout(rep, id2, { followUpDate: '2026-10-31', reminderAt: '2026-10-31T09:00' }, A.ny).expect(200);
      expect((await followUpFor(id2))?.reminderAt?.toISOString()).toBe('2026-10-31T13:00:00.000Z');
    });

    it('a reminder alone books the follow-up on the reminder day', async () => {
      const id = await walkIn(rep);
      await checkout(rep, id, { reminderAt: '2026-10-05T16:15' }).expect(200);
      const visit = await prisma.checkIn.findUniqueOrThrow({ where: { id } });
      expect(visit.followUpDate?.toISOString().slice(0, 10)).toBe('2026-10-05');
      expect((await followUpFor(id))?.reminderAt?.toISOString()).toBe('2026-10-05T10:45:00.000Z');
    });

    it('refuses a reminder after the follow-up day, in the past, or malformed — and closes nothing', async () => {
      const id = await walkIn(rep);
      await checkout(rep, id, { followUpDate: '2026-10-02', reminderAt: '2026-10-03T09:00' }).expect(400);
      await checkout(rep, id, { followUpDate: '2026-10-02', reminderAt: '2026-01-01T09:00' }).expect(400);
      await checkout(rep, id, { followUpDate: '2026-10-02', reminderAt: '2 Oct 9am' }).expect(400);
      const visit = await prisma.checkIn.findUniqueOrThrow({ where: { id } });
      expect(visit.timeOut).toBeNull();
    });

    it('a manager sets the default; a salesperson may read it but not change it', async () => {
      await request(server()).put('/crm/follow-up-reminders/settings').set(auth(rep)).send({ defaultTimeLocal: '08:00' }).expect(403);
      await request(server())
        .put('/crm/follow-up-reminders/settings')
        .set(auth(ho))
        .send({ defaultTimeLocal: '09:15', defaultDaysBefore: 1 })
        .expect(200);
      const read = await request(server()).get('/crm/follow-up-reminders/settings').set(auth(rep)).expect(200);
      expect(read.body).toEqual({ defaultTimeLocal: '09:15', defaultDaysBefore: 1 });

      const id = await walkIn(rep);
      await checkout(rep, id, { followUpDate: '2026-10-10' }).expect(200);
      // 09:15 the day before, in Kolkata.
      expect((await followUpFor(id))?.reminderAt?.toISOString()).toBe('2026-10-09T03:45:00.000Z');
      await request(server())
        .put('/crm/follow-up-reminders/settings')
        .set(auth(ho))
        .send({ defaultTimeLocal: '10:00', defaultDaysBefore: 0 })
        .expect(200);
    });

    it('the sweep reminds once, however many times it runs', async () => {
      const after = new Date('2026-10-02T05:00:00.000Z');
      const first = await reminders.sweep(after);
      expect(first.notified).toBeGreaterThan(0);
      const again = await reminders.sweep(after);
      expect(again.notified).toBe(0);

      const notes = await prisma.notification.findMany({
        where: { userId: 'u_b3_rep', entityType: 'LeadFollowUp' },
      });
      const keys = notes.map((n) => n.dedupeKey);
      expect(new Set(keys).size).toBe(keys.length);
      // Only what was due by then went out; the 5 October reminder is still waiting.
      const pending = await prisma.leadFollowUp.findFirst({
        where: { lead: { organisationId: A.org }, reminderAt: new Date('2026-10-05T10:45:00.000Z') },
      });
      expect(pending?.reminderNotifiedAt).toBeNull();
    });

    it('a failed notification is released and retried, not lost', async () => {
      const at = new Date('2026-10-05T11:00:00.000Z');
      const emit = jest.spyOn(notifications, 'emit').mockResolvedValueOnce(undefined);
      const failed = await reminders.sweep(at);
      expect(failed.released).toBe(1);
      const row = await prisma.leadFollowUp.findFirstOrThrow({
        where: { lead: { organisationId: A.org }, reminderAt: new Date('2026-10-05T10:45:00.000Z') },
      });
      expect(row.reminderNotifiedAt).toBeNull();

      emit.mockRestore();
      const retried = await reminders.sweep(at);
      expect(retried.notified).toBe(1);
      expect(
        await prisma.notification.count({ where: { dedupeKey: `follow-up-reminder:${row.id}` } }),
      ).toBe(1);
    });

    it('rescheduling a pending follow-up moves its reminder by the same days, keeping the time', async () => {
      const id = await walkIn(rep);
      await checkout(rep, id, { followUpDate: '2026-10-20', reminderAt: '2026-10-19T17:30' }).expect(200);
      const fu = await followUpFor(id);
      const res = await request(server())
        .patch(`/leads/reminders/${fu!.id}`)
        .set(auth(rep))
        .send({ dueDate: '2026-10-23' })
        .expect(200);
      expect(res.body.reminder).toMatchObject({ local: '2026-10-22T17:30', state: 'scheduled' });
    });

    it('the lead shows each follow-up with its reminder', async () => {
      const id = await walkIn(rep);
      await checkout(rep, id, { followUpDate: '2026-10-12' }).expect(200);
      const visit = await prisma.checkIn.findUniqueOrThrow({ where: { id } });
      const lead = await request(server()).get(`/leads/${visit.leadId}`).set(auth(rep)).expect(200);
      const shown = lead.body.followUps.find((f: { dueDate: string }) => f.dueDate === '2026-10-12');
      expect(shown.reminder).toMatchObject({ local: '2026-10-12T10:00', state: 'scheduled' });
    });
  });

  /* ======================================================== visit feedback */

  describe('feedback after a visit', () => {
    const enable = (afterVisit: Record<string, unknown>) =>
      request(server()).patch('/feedback/settings').set(auth(ho)).send({ afterVisit }).expect(200);
    const askFor = (checkInId: string) =>
      prisma.feedbackRequest.findFirst({ where: { checkInId, origin: 'visit_auto' } });
    /** Make an ask due now, whatever day it was booked for. */
    const dueNow = (id: string) =>
      prisma.feedbackRequest.update({ where: { id }, data: { scheduledFor: new Date(Date.now() - 60_000) } });

    it('is off until the tenant turns it on', async () => {
      const id = await walkIn(rep);
      await checkout(rep, id, { outcome: 'left', remark: 'Just looking' }).expect(200);
      expect(await askFor(id)).toBeNull();
    });

    it('books one ask for a visit with no follow-up, and none for a visit with one', async () => {
      await enable({ enabled: true, delayDays: 7, sendTimeLocal: '11:00' });

      const plain = await walkIn(rep, A.ist, 'Asha Browsing');
      await checkout(rep, plain, { outcome: 'left' }).expect(200);
      const ask = await askFor(plain);
      expect(ask).toMatchObject({ status: 'scheduled', origin: 'visit_auto' });
      // Checking the same visit out again books nothing new.
      await checkout(rep, plain, { outcome: 'left' }).expect(200);
      expect(await prisma.feedbackRequest.count({ where: { checkInId: plain } })).toBe(1);

      const booked = await walkIn(rep);
      await checkout(rep, booked, { followUpDate: '2026-10-02' }).expect(200);
      expect(await askFor(booked)).toBeNull();

      const list = await request(server()).get('/checkins').set(auth(rep)).expect(200);
      const row = list.body.find((c: { id: string }) => c.id === plain);
      expect(row.feedback.status).toBe('scheduled');
      // A feedback ask is not a sales follow-up: nothing was put on the call queue.
      expect(row.followUpDate).toBeNull();
      expect(row.reminder).toBeNull();
    });

    it('is due on the Nth LOCAL day after the visit, at the send time', async () => {
      const party = await prisma.party.create({ data: { organisationId: A.org, name: 'Late Leaver', phone: '9812399001' } });
      const late = await prisma.checkIn.create({
        data: { organisationId: A.org, storeId: A.ist, partyId: party.id, customerName: 'Late Leaver', timeIn: new Date() },
      });
      // 23:30 on 1 October in Kolkata is still 1 October there, 18:00 UTC.
      const r1 = await visits.scheduleAfterVisit({
        organisationId: A.org, checkIn: late, closedAt: new Date('2026-10-01T18:00:00.000Z'),
        timezone: 'Asia/Kolkata', createdById: 'u_b3_rep',
      });
      expect(r1.scheduledFor?.toISOString()).toBe('2026-10-08T05:30:00.000Z');

      const party2 = await prisma.party.create({ data: { organisationId: A.org, name: 'NY Leaver', phone: '9812399002' } });
      const ny = await prisma.checkIn.create({
        data: { organisationId: A.org, storeId: A.ny, partyId: party2.id, customerName: 'NY Leaver', timeIn: new Date() },
      });
      // 23:30 on 1 October in New York is 03:30 UTC on the 2nd — still the 1st there.
      const r2 = await visits.scheduleAfterVisit({
        organisationId: A.org, checkIn: ny, closedAt: new Date('2026-10-02T03:30:00.000Z'),
        timezone: 'America/New_York', createdById: 'u_b3_rep',
      });
      expect(r2.scheduledFor?.toISOString()).toBe('2026-10-08T15:00:00.000Z');
    });

    it('a scheduled ask cannot be answered before it has been sent', async () => {
      const ask = await prisma.feedbackRequest.findFirstOrThrow({ where: { organisationId: A.org, status: 'scheduled' } });
      await request(server()).get(`/public/feedback/${ask.publicKey}`).expect(404);
    });

    it('with no template, a person is asked to do it, with the reason — nothing is sent', async () => {
      const id = await walkIn(rep, A.ist, 'Needs A Person');
      await checkout(rep, id, { outcome: 'left' }).expect(200);
      const ask = await askFor(id);
      await dueNow(ask!.id);

      const before = whatsapp.sends.length;
      const res = await visits.sweep();
      expect(res.handedToStaff).toBeGreaterThanOrEqual(1);
      const after = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(after.status).toBe('pending');
      expect(after.sentAt).toBeNull();
      expect(after.messageId).toBeNull();
      expect(after.deliveryNote).toMatch(/no WhatsApp feedback template/i);
      const task = await prisma.task.findUniqueOrThrow({ where: { id: after.taskId! } });
      expect(task.assigneeId).toBe('u_b3_rep');
      expect(task.title).toContain('how their visit went');
      expect(task.detail).toContain('not a sales follow-up');
      expect(whatsapp.sends.length).toBe(before);
    });

    it('with a template but no live sender, still a person — never a dry-run "send"', async () => {
      await setTemplate();
      await enable({ templateName: FEEDBACK_TEMPLATE, templateLanguage: 'en' });
      const id = await walkIn(rep, A.ist, 'Dry Run Customer');
      await checkout(rep, id, { outcome: 'left' }).expect(200);
      const ask = await askFor(id);
      await dueNow(ask!.id);
      await visits.sweep();
      const after = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(after.messageId).toBeNull();
      expect(after.taskId).toBeTruthy();
      expect(after.deliveryNote).toMatch(/not live/i);
    });

    it('with a live sender, it goes through the outbox and counts as sent only when delivered', async () => {
      live();
      const id = await walkIn(rep, A.ist, 'Priya Happy');
      await checkout(rep, id, { outcome: 'left' }).expect(200);
      const ask = await askFor(id);
      await dueNow(ask!.id);

      const sendsBefore = whatsapp.sends.length;
      const res = await visits.sweep();
      expect(res.queued).toBe(1);
      let row = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(row.status).toBe('pending');
      expect(row.messageId).toBeTruthy();
      expect(row.sentAt).toBeNull();
      // Nothing left on the sweep itself.
      expect(whatsapp.sends.length).toBe(sendsBefore);

      await jobs.drain(10);
      row = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(row.status).toBe('sent');
      expect(row.sentAt).toBeTruthy();
      const sent = whatsapp.sends[whatsapp.sends.length - 1];
      expect(sent.name).toBe(FEEDBACK_TEMPLATE);
      expect(JSON.stringify(sent.components)).toContain(`https://app.caratos.test/feedback/${row.publicKey}`);
      expect(JSON.stringify(sent.components)).toContain('Priya');

      const audit = await prisma.auditLog.findFirst({
        where: { organisationId: A.org, action: 'omnichannel.system_notice_queued', entityId: row.messageId! },
      });
      expect(audit?.systemActorId).toBe('visit_feedback');
    });

    it('two sweeps at once send one message', async () => {
      live();
      const id = await walkIn(rep, A.ist, 'Race Customer');
      await checkout(rep, id, { outcome: 'left' }).expect(200);
      const ask = await askFor(id);
      await dueNow(ask!.id);
      const [a, b] = await Promise.all([visits.sweep(), visits.sweep()]);
      expect(a.queued + b.queued).toBe(1);
      const row = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(await prisma.message.count({ where: { id: row.messageId! } })).toBe(1);
      expect(await visits.sweep()).toMatchObject({ queued: 0 });
    });

    it('a customer who said STOP is not asked at all — not even by a colleague', async () => {
      live();
      const id = await walkIn(rep, A.ist, 'Stop Customer');
      await checkout(rep, id, { outcome: 'left' }).expect(200);
      const visit = await prisma.checkIn.findUniqueOrThrow({ where: { id } });
      await omnichannel.recordConsent(hoUser, {
        partyId: visit.partyId, channel: 'whatsapp', purpose: 'all', status: 'revoked', source: 'inbound_stop',
      } as never);
      const ask = await askFor(id);
      await dueNow(ask!.id);
      await visits.sweep();
      const row = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(row.status).toBe('cancelled');
      expect(row.taskId).toBeNull();
      expect(row.messageId).toBeNull();
      expect(row.deliveryNote).toMatch(/opted out/i);
    });

    it('an archived customer is not asked', async () => {
      live();
      const id = await walkIn(rep, A.ist, 'Archived Customer');
      await checkout(rep, id, { outcome: 'left' }).expect(200);
      const visit = await prisma.checkIn.findUniqueOrThrow({ where: { id } });
      const ask = await askFor(id);
      await prisma.party.update({ where: { id: visit.partyId! }, data: { archivedAt: new Date(), archiveReason: 'test' } });
      await dueNow(ask!.id);
      await visits.sweep();
      const row = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(row).toMatchObject({ status: 'cancelled', taskId: null, messageId: null });
    });

    it('a sweep that throws puts the ask back and succeeds on the next run', async () => {
      live();
      const id = await walkIn(rep, A.ist, 'Retry Customer');
      await checkout(rep, id, { outcome: 'left' }).expect(200);
      const ask = await askFor(id);
      await dueNow(ask!.id);

      jest.spyOn(omnichannel, 'queueCustomerNotice').mockRejectedValueOnce(new Error('database blinked'));
      const first = await visits.sweep();
      expect(first.retrying).toBe(1);
      let row = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(row).toMatchObject({ status: 'scheduled', dispatchAttempts: 1 });

      const second = await visits.sweep();
      expect(second.queued).toBe(1);
      row = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: ask!.id } });
      expect(row.status).toBe('pending');
      expect(row.messageId).toBeTruthy();
    });

    it('an ask whose message was finally refused goes to a person, still unsent', async () => {
      const row = await prisma.feedbackRequest.findFirstOrThrow({
        where: { organisationId: A.org, status: 'pending', messageId: { not: null }, sentAt: null },
      });
      await prisma.message.update({ where: { id: row.messageId! }, data: { status: 'failed', error: 'template_unavailable: paused' } });
      const res = await visits.sweep();
      expect(res.recovered).toBeGreaterThanOrEqual(1);
      const after = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.taskId).toBeTruthy();
      expect(after.sentAt).toBeNull();
      expect(after.deliveryNote).toMatch(/not delivered/i);
    });

    it('asks still waiting for their day are not counted as requested', async () => {
      const scheduled = await prisma.feedbackRequest.count({ where: { organisationId: A.org, status: 'scheduled' } });
      expect(scheduled).toBeGreaterThan(0);
      const total = await prisma.feedbackRequest.count({ where: { organisationId: A.org } });
      const cancelledUnasked = await prisma.feedbackRequest.count({
        where: { organisationId: A.org, origin: 'visit_auto', status: 'cancelled', messageId: null, taskId: null },
      });
      const summary = await request(server()).get('/feedback/summary').set(auth(ho)).expect(200);
      expect(summary.body.asked).toBe(total - scheduled - cancelledUnasked);
    });
  });
});
