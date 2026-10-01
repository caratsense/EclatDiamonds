import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { extractMetaReferral } from '../src/integrations/meta-referral';

/**
 * Sales staff see attendance only, as a rule of the workspace (auth/access.ts).
 *
 * ATTENDANCE_ONLY_SALES_ORGS lists the organisations it is switched on for.
 *
 *  1. A salesperson there starts with attendance and nothing else: the session
 *     says so and the API refuses the rest. Staff added later start the same.
 *  2. Nobody else moves: a store manager in the same workspace, and a
 *     salesperson in a workspace that is not listed.
 *  3. Head office gives one salesperson a screen back, and People & Access says
 *     where that person's starting point comes from.
 *  4. A badly typed list switches the rule on for nobody it does not name.
 *  5. Work never goes to somebody who cannot open it: not from the fair queue,
 *     a routing rule, the lead behind a conversation or the bot's hand-off, and
 *     not from a manager assigning by hand or handing over a leaver's leads.
 */

const PASSWORD = 'password123';
const VARIABLE = 'ATTENDANCE_ONLY_SALES_ORGS';
/** The workspace the rule is switched on for, and one it is not. */
const P = { org: 'org_aop', slug: 'aop', store: 'store_aop' };
const N = { org: 'org_aop_n', slug: 'aop-n', store: 'store_aop_n' };
/** The ad a routing rule sends to the store, naming a person who cannot open the work. */
const AD = 'ad_aop';

const STAFF = [
  ['ho', 'head_office', P, 'Hema Office'],
  ['mgr', 'store_manager', P, 'Mohan Manager'],
  // Attendance only throughout.
  ['rep', 'salesperson', P, 'Riya Shah'],
  // Head office gives this one CRM and Conversations back.
  ['rep2', 'salesperson', P, 'Sunil Rao'],
  ['nrep', 'salesperson', N, 'Nita Elsewhere'],
] as const;

type Db = import('../src/prisma/prisma.service').PrismaService;

async function teardown(prisma: Db) {
  for (const org of [P.org, N.org]) {
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.notification.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } });
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.employeeProfile.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

/** A click-to-WhatsApp first message, in the provider's documented shape. */
function adClick(from: string, wamid: string, clickId: string) {
  return {
    from, id: wamid, timestamp: '1757240000', type: 'text',
    text: { body: 'Saw your ad' },
    referral: {
      source_url: 'https://fb.me/x', source_id: AD, source_type: 'ad',
      headline: 'Campaign', body: 'Enquire now', ctwa_clid: clickId,
    },
  };
}

describe('Attendance-only sales staff, as a workspace rule (e2e)', () => {
  let app: INestApplication;
  let prisma: Db;
  let conversations: import('../src/crm/conversations.service').ConversationsService;
  let intake: import('../src/crm/lead-intake.service').LeadIntakeService;
  let metaLeads: import('../src/integrations/meta-lead.adapter').MetaLeadAdapter;
  let bot: import('../src/whatsapp-bot/whatsapp-bot.service').WhatsAppBotService;
  let listedBefore: string | undefined;
  /** What sign-in itself returned, by person. */
  const signedIn: Record<string, { token: string; access: Record<string, string> }> = {};
  let joinerId: string;
  let threadId: string;

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${signedIn[who].token}` });
  const get = (who: string, path: string) => request(server()).get(path).set(as(who));
  const accessOf = async (who: string) => (await get(who, '/auth/me').expect(200)).body.access;
  /** The fair queue at the store, naming who the store wants in it. */
  const queueOf = (eligibleUserIds: string[]) =>
    request(server())
      .put('/crm/round-robin/policy')
      .set(as('ho'))
      .send({ enabled: true, stores: [{ storeId: P.store, eligibleUserIds }] })
      .expect(200);
  /** A website enquiry: a new lead at the store, put in its fair queue. */
  const enquiry = (n: number) =>
    intake.capture({
      organisationId: P.org, storeId: P.store, originKey: `aop:form:${n}`,
      customerName: `Enquiry ${n}`, phone: `+9198123407${10 + n}`, interest: 'Rings',
      source: 'website', identitySource: 'web_form', summary: 'A visitor sent the enquiry form.',
      auditAction: 'crm.lead_captured_from_web_form', systemActor: 'web_form_capture',
      followUpNote: 'Enquiry follow-up',
    });
  /** A customer tapping the ad and writing in. */
  const clickFrom = (from: string, n: number) => {
    const raw = adClick(from, `wamid.aop.${n}`, `CL_AOP_${n}`);
    return conversations.ingestInbound({
      organisationId: P.org, channel: 'whatsapp', externalThreadId: from, externalId: raw.id,
      senderKind: 'whatsapp', senderValue: from, body: raw.text.body, payload: raw as never,
      adReferral: extractMetaReferral(raw),
    });
  };

  beforeAll(async () => {
    listedBefore = process.env[VARIABLE];
    process.env[VARIABLE] = P.org;

    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const { ConversationsService } = await import('../src/crm/conversations.service');
    const { LeadIntakeService } = await import('../src/crm/lead-intake.service');
    const { MetaLeadAdapter } = await import('../src/integrations/meta-lead.adapter');
    const { WhatsAppBotService } = await import('../src/whatsapp-bot/whatsapp-bot.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);
    intake = app.get(LeadIntakeService);
    metaLeads = app.get(MetaLeadAdapter);
    bot = app.get(WhatsAppBotService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const o of [P, N]) {
      await prisma.organisation.create({ data: { id: o.org, name: o.slug, slug: o.slug, industryPackCode: 'jewellery' } });
      await prisma.store.create({ data: { id: o.store, name: 'Bandra', city: 'Mumbai', organisationId: o.org } });
    }
    const person = (who: string, role: 'head_office' | 'store_manager' | 'salesperson', o: typeof P, name: string) => ({
      id: `u_aop_${who}`, email: `${who}@aop.local`, name, role, passwordHash: hash,
      isActive: true, approvalStatus: 'approved' as const, organisationId: o.org,
      userStores: { create: { storeId: o.store, isPrimary: true } },
    });
    for (const [who, role, o, name] of STAFF) {
      await prisma.user.create({ data: person(who, role, o, name) });
      signedIn[who] = (
        await request(server()).post('/auth/login').send({ email: `${who}@aop.local`, password: PASSWORD }).expect(201)
      ).body;
    }
    // Conversations but not CRM: may own a thread, never the lead behind it.
    await prisma.user.create({
      data: { ...person('rep3', 'salesperson', P, 'Tara Inbox'), accessOverrides: { conversations: 'own' } },
    });
    // The store's longest-serving manager, with the inbox switched off by head office.
    await prisma.user.create({
      data: {
        ...person('mgr_old', 'store_manager', P, 'Omkar Senior'),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        accessOverrides: { conversations: 'none' },
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (listedBefore === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = listedBefore;
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('a salesperson there starts with attendance and nothing else', async () => {
    expect(signedIn.rep.access).toEqual({ hrms: 'own' });
    expect(await accessOf('rep')).toEqual({ hrms: 'own' });
    await get('rep', '/leads').expect(403);
    await get('rep', '/quotes').expect(403);
    await get('rep', '/hrms/shifts').expect(200);
  });

  it('staff added later start the same way', async () => {
    const added = await request(server())
      .post('/users')
      .set(as('ho'))
      .send({ name: 'Jaya Joiner', phone: '9876500731', email: 'jaya@aop.local', storeId: P.store })
      .expect(201);
    joinerId = added.body.id;
    const access = (await get('ho', `/users/${joinerId}/access`).expect(200)).body;
    expect(access.effective).toEqual({ hrms: 'own' });
  });

  it('a store manager there, and a salesperson in a workspace that is not listed, keep what they had', async () => {
    expect(await accessOf('mgr')).toMatchObject({ crm: 'store', quotation: 'store', inventory: 'store', hrms: 'store' });
    await get('mgr', '/leads').expect(200);
    await get('mgr', '/quotes').expect(200);

    expect(await accessOf('nrep')).toMatchObject({ hrms: 'own', crm: 'own', quotation: 'own', catalogue: 'own' });
    await get('nrep', '/leads').expect(200);
    await get('nrep', '/quotes').expect(200);
  });

  it('head office gives one salesperson CRM back, and People & Access says where they start', async () => {
    const before = (await get('ho', '/users/u_aop_rep2/access').expect(200)).body;
    expect(before.startsAttendanceOnly).toBe(true);
    expect(before.defaults).toEqual({ hrms: 'own' });

    const saved = await request(server())
      .put('/users/u_aop_rep2/access')
      .set(as('ho'))
      .send({ overrides: { crm: 'own', conversations: 'own', quotation: 'none', hrms: 'own' } })
      .expect(200);
    // Only what differs from the attendance-only start is a change worth storing.
    expect(saved.body.overrides).toEqual({ crm: 'own', conversations: 'own' });
    expect(saved.body.effective).toEqual({ hrms: 'own', crm: 'own', conversations: 'own' });
    await get('rep2', '/leads').expect(200);
    await get('rep2', '/quotes').expect(403);

    // A colleague is untouched, and the rule is not claimed for a role it does not cover.
    expect(await accessOf('rep')).toEqual({ hrms: 'own' });
    expect((await get('ho', '/users/u_aop_mgr/access').expect(200)).body.startsAttendanceOnly).toBe(false);
  });

  it('a badly typed list switches the rule on for nobody it does not name', async () => {
    try {
      for (const value of [undefined, '', ' , ,', `${P.org}x, x${P.org} ,`, 'org_that_is_not_one,']) {
        if (value === undefined) delete process.env[VARIABLE];
        else process.env[VARIABLE] = value;
        // Off for the workspace it no longer names, and still off for the other.
        expect((await accessOf('rep')).crm).toBe('own');
        expect((await accessOf('nrep')).crm).toBe('own');
      }
      // Spaces, a wrong id and a trailing comma around the right id: on for that workspace only.
      process.env[VARIABLE] = `  org_that_is_not_one , ${P.org} , `;
      expect(await accessOf('rep')).toEqual({ hrms: 'own' });
      expect((await accessOf('nrep')).crm).toBe('own');
    } finally {
      process.env[VARIABLE] = P.org;
    }
  });

  it('the fair queue passes over a salesperson who cannot open the work, even when the store names them', async () => {
    await queueOf(['u_aop_rep', 'u_aop_rep2']);

    // Two enquiries in a row: a queue of two would have given one to each.
    for (const n of [1, 2]) expect((await enquiry(n)).assigned?.userId).toBe('u_aop_rep2');

    const message = await conversations.ingestInbound({
      organisationId: P.org, channel: 'whatsapp', externalThreadId: '919812340801', externalId: 'wamid.aop.0',
      senderKind: 'whatsapp', senderValue: '919812340801', body: 'Are you open on Sunday?', storeId: P.store,
    });
    expect(message.automaticAssignment?.assignedUserId).toBe('u_aop_rep2');
  });

  it('a routing rule keeps its store but not a person who cannot open the work', async () => {
    await request(server())
      .post('/crm/qualification/adset-rules')
      .set(as('ho'))
      .send({
        rules: [{
          id: 'r_aop', name: 'Bandra ad', enabled: true, priority: 50, matchField: 'ad_id', matchValue: AD,
          storeId: P.store, assignedUserId: 'u_aop_rep', handling: 'human',
        }],
      })
      .expect(201);

    // A lead form: the rule's store, and the queue's person instead of the rule's.
    const form = await metaLeads.acceptMetaLead({
      organisationId: P.org, integrationId: 'integ_aop', leadgenId: 'lg_aop_1', pageId: '55501', formId: 'form_1',
      createdAt: new Date('2026-09-10T09:00:00.000Z'), adId: AD, adSetId: null, campaignId: null,
      adName: null, adSetName: null, campaignName: null,
      fullName: 'Priya Menon', phone: '+919812340721', email: null, fields: [],
    });
    expect(await prisma.lead.findUnique({ where: { id: form.leadId! }, select: { storeId: true, ownerId: true } }))
      .toEqual({ storeId: P.store, ownerId: 'u_aop_rep2' });

    // An ad click: the same for the conversation, and for the lead behind it.
    const click = await clickFrom('919812340802', 1);
    expect(
      await prisma.conversation.findUnique({
        where: { id: click.conversationId },
        select: { storeId: true, matchedRuleId: true, assignedUserId: true },
      }),
    ).toEqual({ storeId: P.store, matchedRuleId: 'r_aop', assignedUserId: 'u_aop_rep2' });
    expect((await prisma.lead.findUnique({ where: { id: click.leadId! } }))!.ownerId).toBe('u_aop_rep2');
  });

  it('somebody with Conversations but not CRM gets the thread, and no lead', async () => {
    await queueOf(['u_aop_rep3']);
    const click = await clickFrom('919812340803', 2);
    expect((await prisma.conversation.findUnique({ where: { id: click.conversationId } }))!.assignedUserId).toBe('u_aop_rep3');
    // Not the lead behind that thread, and not a lead from the queue either.
    expect((await prisma.lead.findUnique({ where: { id: click.leadId! } }))!.ownerId).toBeNull();
    expect((await enquiry(3)).assigned).toBeNull();
  });

  it('the bot hands a thread to the first manager who can open Conversations', async () => {
    const thread = await prisma.conversation.create({
      data: { organisationId: P.org, storeId: P.store, channel: 'whatsapp', externalThreadId: '919812340804' },
    });
    threadId = thread.id;
    // The hand-off itself, without the WhatsApp webhook around it.
    await bot['handToAPerson'](P.org, threadId, 'The customer asked to speak to someone.');
    const after = await prisma.conversation.findUnique({ where: { id: threadId } });
    expect(after).toMatchObject({ handling: 'human', assignedUserId: 'u_aop_mgr' });
  });

  it('a manager cannot give a lead to somebody who cannot open CRM', async () => {
    const lead = await prisma.lead.create({
      data: { organisationId: P.org, storeId: P.store, ref: 'AOP-L1', customerName: 'By hand', source: 'walk_in' },
    });
    const give = (ownerId: string) => request(server()).patch(`/leads/${lead.id}`).set(as('mgr')).send({ ownerId });
    expect((await give('u_aop_rep').expect(400)).body.message).toBe(
      'Riya Shah cannot open CRM & Leads, so this lead cannot be given to them.',
    );
    await give('u_aop_rep2').expect(200);
  });

  it('a manager cannot give a conversation to somebody who cannot open Conversations', async () => {
    const give = (assignedUserId: string) =>
      request(server()).post(`/crm/conversations/${threadId}/assign`).set(as('mgr')).send({ assignedUserId });
    expect((await give('u_aop_rep').expect(400)).body.message).toBe(
      'Riya Shah cannot open Conversations, so this conversation cannot be given to them.',
    );
    await give('u_aop_rep2').expect(201);
  });

  it("a leaver's leads cannot be handed to somebody who cannot open CRM, and the leaver stays", async () => {
    const handOver = await request(server())
      .patch(`/users/${joinerId}/deactivate`)
      .set(as('mgr'))
      .send({ reassignToId: 'u_aop_rep' })
      .expect(400);
    expect(handOver.body.message).toBe('Riya Shah cannot open CRM & Leads, so open leads cannot be handed to them.');
    expect((await prisma.user.findUnique({ where: { id: joinerId } }))!.isActive).toBe(true);
  });
});
