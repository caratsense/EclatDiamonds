import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { listedAttendanceOnlyOrgs, roleDefaults } from '../src/auth/access';
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
 *  6. Work somebody already holds and can no longer open is not left with them
 *     in silence: the bot's hand-off, the reply-overdue alert and the follow-up
 *     reminder reach the branch's managers instead.
 *  7. A screen given back does not hold the person down after a promotion.
 */

const PASSWORD = 'password123';
const VARIABLE = 'ATTENDANCE_ONLY_SALES_ORGS';
/** The workspace the rule is switched on for, and one it is not. */
const P = { org: 'org_aop', slug: 'aop', store: 'store_aop' };
const N = { org: 'org_aop_n', slug: 'aop-n', store: 'store_aop_n' };
/** The ad a routing rule sends to the store, naming a person who cannot open the work. */
const AD = 'ad_aop';
/** Another, whose rule names a person who has since left. */
const AD_GONE = 'ad_aop_gone';

const STAFF = [
  ['ho', 'head_office', P, 'Hema Office'],
  ['mgr', 'store_manager', P, 'Mohan Manager'],
  ['mkt', 'marketing', P, 'Meera Marketing'],
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
    await prisma.conversationResponseSla.deleteMany({ where: { organisationId: org } });
    await prisma.conversationSlaSettings.deleteMany({ where: { organisationId: org } });
    await prisma.task.deleteMany({ where: { organisationId: org } });
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
  let sla: import('../src/crm/response-sla.service').ResponseSlaService;
  let reminders: import('../src/crm/follow-up-reminders.service').FollowUpRemindersService;
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
  /** A customer writing to the store's own number, with no ad behind it. */
  const messageFrom = (from: string, sentAt = new Date()) =>
    conversations.ingestInbound({
      organisationId: P.org, channel: 'whatsapp', externalThreadId: from, externalId: `wamid.aop.msg.${from}`,
      senderKind: 'whatsapp', senderValue: from, body: 'Are you open on Sunday?', storeId: P.store, sentAt,
    });
  /** A lead form filled in on the ad itself. */
  const leadForm = (adId: string, n: number) =>
    metaLeads.acceptMetaLead({
      organisationId: P.org, integrationId: 'integ_aop', leadgenId: `lg_aop_${n}`, pageId: '55501', formId: 'form_1',
      createdAt: new Date('2026-09-10T09:00:00.000Z'), adId, adSetId: null, campaignId: null,
      adName: null, adSetName: null, campaignName: null,
      fullName: `Form ${n}`, phone: `+91981234072${n}`, email: null, fields: [],
    });
  /** A thread at the store, held by whoever is named. */
  const thread = (from: string, assignedUserId: string | null = null) =>
    prisma.conversation.create({
      data: { organisationId: P.org, storeId: P.store, channel: 'whatsapp', externalThreadId: from, assignedUserId },
    });
  /** Who was rung about something, by the bell's own key. */
  const toldAbout = async (dedupeKey: string) =>
    (await prisma.notification.findMany({ where: { dedupeKey, user: { organisationId: P.org } } })).map((n) => n.userId);

  beforeAll(async () => {
    listedBefore = process.env[VARIABLE];
    process.env[VARIABLE] = P.org;

    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const { ConversationsService } = await import('../src/crm/conversations.service');
    const { LeadIntakeService } = await import('../src/crm/lead-intake.service');
    const { MetaLeadAdapter } = await import('../src/integrations/meta-lead.adapter');
    const { WhatsAppBotService } = await import('../src/whatsapp-bot/whatsapp-bot.service');
    const { ResponseSlaService } = await import('../src/crm/response-sla.service');
    const { FollowUpRemindersService } = await import('../src/crm/follow-up-reminders.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);
    intake = app.get(LeadIntakeService);
    metaLeads = app.get(MetaLeadAdapter);
    bot = app.get(WhatsAppBotService);
    sla = app.get(ResponseSlaService);
    reminders = app.get(FollowUpRemindersService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const o of [P, N]) {
      await prisma.organisation.create({ data: { id: o.org, name: o.slug, slug: o.slug, industryPackCode: 'jewellery' } });
      await prisma.store.create({ data: { id: o.store, name: 'Bandra', city: 'Mumbai', organisationId: o.org } });
    }
    const person = (who: string, role: (typeof STAFF)[number][1], o: typeof P, name: string) => ({
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
    // The other way round: CRM but not Conversations.
    await prisma.user.create({
      data: { ...person('rep4', 'salesperson', P, 'Leela Leads'), accessOverrides: { crm: 'own' } },
    });
    // Holds both, and leaves the shop part-way through.
    await prisma.user.create({
      data: { ...person('gone', 'salesperson', P, 'Gita Gone'), accessOverrides: { crm: 'own', conversations: 'own' } },
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

  it('everybody else there, and a salesperson in a workspace that is not listed, keep every screen they had', async () => {
    // Screen for screen what the role gives where the rule is off.
    expect(await accessOf('mgr')).toEqual(roleDefaults('store_manager', null));
    expect(await accessOf('mkt')).toEqual(roleDefaults('marketing', null));
    expect(await accessOf('ho')).toEqual(roleDefaults('head_office', null));
    await get('mgr', '/leads').expect(200);
    await get('mgr', '/quotes').expect(200);
    await get('mkt', '/leads').expect(200);

    expect(await accessOf('nrep')).toEqual(roleDefaults('salesperson', null));
    await get('nrep', '/leads').expect(200);
    await get('nrep', '/quotes').expect(200);
  });

  it('the rule only ever takes screens away', () => {
    const roles = ['salesperson', 'store_manager', 'marketing', 'head_office', 'area_manager', 'storeperson'] as const;
    for (const role of roles) {
      const usual = roleDefaults(role, null);
      const here = roleDefaults(role, P.org);
      // Nothing the role does not usually have, and nothing at a higher level.
      expect(usual).toMatchObject(here);
      if (role !== 'salesperson') expect(here).toEqual(usual);
    }
    expect(roleDefaults('salesperson', P.org)).toEqual({ hrms: 'own' });
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

  it('the check at startup names a listed id that is not an organisation', async () => {
    try {
      // A typo, and an id pasted with its quotes: neither switches anything on, so both are worth a warning.
      process.env[VARIABLE] = `${P.org}, org_that_is_not_one, "${N.org}", ${P.org}`;
      expect(await listedAttendanceOnlyOrgs(prisma)).toEqual({
        on: [P.org],
        unknown: ['org_that_is_not_one', `"${N.org}"`],
      });
      delete process.env[VARIABLE];
      expect(await listedAttendanceOnlyOrgs(prisma)).toEqual({ on: [], unknown: [] });
    } finally {
      process.env[VARIABLE] = P.org;
    }
  });

  it('the fair queue passes over a salesperson who cannot open the work, even when the store names them', async () => {
    await queueOf(['u_aop_rep', 'u_aop_rep2']);

    // Two enquiries in a row: a queue of two would have given one to each.
    for (const n of [1, 2]) expect((await enquiry(n)).assigned?.userId).toBe('u_aop_rep2');

    const message = await messageFrom('919812340801');
    expect(message.automaticAssignment?.assignedUserId).toBe('u_aop_rep2');
  });

  it('a routing rule keeps its store but not a person who cannot open the work', async () => {
    await request(server())
      .post('/crm/qualification/adset-rules')
      .set(as('ho'))
      .send({
        rules: [
          {
            id: 'r_aop', name: 'Bandra ad', enabled: true, priority: 50, matchField: 'ad_id', matchValue: AD,
            storeId: P.store, assignedUserId: 'u_aop_rep', handling: 'human',
          },
          {
            id: 'r_aop_gone', name: 'Bandra ad two', enabled: true, priority: 50, matchField: 'ad_id', matchValue: AD_GONE,
            storeId: P.store, assignedUserId: 'u_aop_gone', handling: 'human',
          },
        ],
      })
      .expect(201);

    // A lead form: the rule's store, and the queue's person instead of the rule's.
    const form = await leadForm(AD, 1);
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

  it('a routing rule does not give work to somebody who has left', async () => {
    const ownerOf = async (leadId: string) => (await prisma.lead.findUnique({ where: { id: leadId } }))!.ownerId;
    // While she works here, the rule's person gets the lead.
    expect(await ownerOf((await leadForm(AD_GONE, 2)).leadId!)).toBe('u_aop_gone');

    await prisma.user.update({ where: { id: 'u_aop_gone' }, data: { isActive: false } });
    // The rule still names her. The lead goes to the queue's person instead.
    expect(await ownerOf((await leadForm(AD_GONE, 3)).leadId!)).toBe('u_aop_rep2');
  });

  it('somebody with Conversations but not CRM gets the thread, and no lead', async () => {
    await queueOf(['u_aop_rep3']);
    const click = await clickFrom('919812340803', 2);
    expect((await prisma.conversation.findUnique({ where: { id: click.conversationId } }))!.assignedUserId).toBe('u_aop_rep3');
    // Not the lead behind that thread, and not a lead from the queue either.
    expect((await prisma.lead.findUnique({ where: { id: click.leadId! } }))!.ownerId).toBeNull();
    expect((await enquiry(3)).assigned).toBeNull();
  });

  it('somebody with CRM but not Conversations gets the lead behind an ad click, and not the thread', async () => {
    await queueOf(['u_aop_rep4']);
    const click = await clickFrom('919812340805', 3);
    expect((await prisma.conversation.findUnique({ where: { id: click.conversationId } }))!.assignedUserId).toBeNull();
    // The lead takes its own turn in the queue, like an enquiry from any other door.
    expect((await prisma.lead.findUnique({ where: { id: click.leadId! } }))!.ownerId).toBe('u_aop_rep4');
  });

  it('leads and conversations take turns separately', async () => {
    // Two people for the inbox, one of them for leads.
    await queueOf(['u_aop_rep2', 'u_aop_rep3']);
    // The store's turn as it was recorded before the two kinds were told apart: one last pick, of either kind.
    const { settings } = await prisma.organisation.findUniqueOrThrow({ where: { id: P.org } });
    await prisma.organisation.update({
      where: { id: P.org },
      data: {
        settings: {
          ...(settings as object),
          crmRoundRobinState: {
            [P.store]: { lastUserId: 'u_aop_rep2', sequence: 9, updatedAt: '2026-09-01T00:00:00.000Z' },
          },
        },
      },
    });
    const inbox = async (from: string) => (await messageFrom(from)).automaticAssignment?.assignedUserId;

    const first = await inbox('919812340901');
    expect((await enquiry(4)).assigned?.userId).toBe('u_aop_rep2');
    const second = await inbox('919812340902');
    expect((await enquiry(5)).assigned?.userId).toBe('u_aop_rep2');
    const third = await inbox('919812340903');

    // The old turn still counts, so the inbox starts with the person after it. From
    // there an enquiry in between costs nobody their turn at the inbox.
    expect([first, second, third]).toEqual(['u_aop_rep3', 'u_aop_rep2', 'u_aop_rep3']);
  });

  it('the bot hands a thread to the first manager who can open Conversations', async () => {
    threadId = (await thread('919812340804')).id;
    // The hand-off itself, without the WhatsApp webhook around it.
    await bot['handToAPerson'](P.org, threadId, 'The customer asked to speak to someone.');
    const after = await prisma.conversation.findUnique({ where: { id: threadId } });
    expect(after).toMatchObject({ handling: 'human', assignedUserId: 'u_aop_mgr' });
  });

  it('the bot takes a thread from an owner who can no longer open it, and tells the manager', async () => {
    // Given to her before the rule came in.
    const stuck = await thread('919812340806', 'u_aop_rep');
    await bot['handToAPerson'](P.org, stuck.id, 'The customer asked to speak to someone.');
    expect((await prisma.conversation.findUnique({ where: { id: stuck.id } }))!.assignedUserId).toBe('u_aop_mgr');
    expect(await toldAbout(`crm:handoff:${stuck.id}`)).toEqual(['u_aop_mgr']);

    // Somebody who can open it keeps it, as before.
    const held = await thread('919812340807', 'u_aop_rep2');
    await bot['handToAPerson'](P.org, held.id, 'The customer asked to speak to someone.');
    expect((await prisma.conversation.findUnique({ where: { id: held.id } }))!.assignedUserId).toBe('u_aop_rep2');
    expect(await toldAbout(`crm:handoff:${held.id}`)).toEqual(['u_aop_rep2']);
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

  it("a leaver's leads cannot be handed to somebody who cannot open CRM; with none to hand over, the leaver simply goes", async () => {
    const lead = await prisma.lead.create({
      data: {
        organisationId: P.org, storeId: P.store, ref: 'AOP-L2', customerName: 'Left behind', source: 'walk_in',
        ownerId: joinerId,
      },
    });
    const leave = () =>
      request(server()).patch(`/users/${joinerId}/deactivate`).set(as('mgr')).send({ reassignToId: 'u_aop_rep' });
    const stillHere = async () => (await prisma.user.findUnique({ where: { id: joinerId } }))!.isActive;

    expect((await leave().expect(400)).body.message).toBe(
      'Riya Shah cannot open CRM & Leads, so open leads cannot be handed to them.',
    );
    expect(await stillHere()).toBe(true);

    // The lead goes to somebody else first. Now there is nothing to refuse.
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: 'u_aop_rep2' } });
    await leave().expect(200);
    expect(await stillHere()).toBe(false);
  });

  it('a reply overdue on a thread whose owner cannot open it goes to the managers', async () => {
    await request(server()).put('/crm/sla/settings').set(as('ho')).send({ firstResponseMinutes: 5 }).expect(200);
    // The customer wrote seven minutes ago, on a thread given to her before the rule came in.
    const { conversationId } = await messageFrom('919812340904', new Date(Date.now() - 7 * 60_000));
    await prisma.conversation.update({ where: { id: conversationId }, data: { assignedUserId: 'u_aop_rep' } });

    expect((await sla.sweep(new Date(), { organisationId: P.org })).breached).toBe(1);

    const clock = await prisma.conversationResponseSla.findFirstOrThrow({ where: { conversationId } });
    const told = await prisma.notification.findMany({ where: { dedupeKey: `sla:breach:${clock.id}` } });
    expect(told.map((n) => n.userId)).toContain('u_aop_mgr');
    expect(told.map((n) => n.userId)).not.toContain('u_aop_rep');
    expect(told[0].title).toMatch(/the person assigned cannot open it$/);
    // The task is the store's to pick up, not parked on her.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: clock.taskId! } })).assigneeId).toBeNull();
  });

  it('a follow-up reminder for somebody who cannot open CRM goes to the managers', async () => {
    const lead = await prisma.lead.create({
      data: {
        organisationId: P.org, storeId: P.store, ref: 'AOP-L3', customerName: 'Owed a call', source: 'walk_in',
        ownerId: 'u_aop_rep',
      },
    });
    // Booked by her before the rule came in. Dated long ago so the sweep finds this reminder and no other.
    const followUp = await prisma.leadFollowUp.create({
      data: {
        leadId: lead.id, storeId: P.store, seq: 1, dueDate: new Date('2020-01-02'), assigneeId: 'u_aop_rep',
        reminderAt: new Date('2020-01-01T04:30:00.000Z'),
      },
    });

    await reminders.sweep(new Date('2020-01-01T05:00:00.000Z'));

    const told = await toldAbout(`follow-up-reminder:${followUp.id}`);
    expect(told).toContain('u_aop_mgr');
    expect(told).not.toContain('u_aop_rep');
  });

  it('a screen given back does not hold the person to their own records after a promotion', async () => {
    /** Role, head office's changes and the result, as People & Access reads them. */
    const accessAfter = async (who: string) => {
      const { role, overrides, effective } = (await get('ho', `/users/u_aop_${who}/access`).expect(200)).body;
      return { role, overrides, effective };
    };
    const makeManager = (who: string) =>
      request(server()).patch(`/users/u_aop_${who}/role`).set(as('ho')).send({ role: 'store_manager' }).expect(200);
    const likeAnyStoreManager = { role: 'store_manager', overrides: {}, effective: roleDefaults('store_manager', null) };

    // Given CRM and Conversations back as a salesperson, then made store manager.
    await makeManager('rep2');
    expect(await accessAfter('rep2')).toEqual(likeAnyStoreManager);
    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { organisationId: P.org, action: 'user.role_change', entityId: 'u_aop_rep2' },
    });
    expect((trail.metadata as { accessDropped: string[] }).accessDropped.sort()).toEqual(['conversations', 'crm']);

    // The same through the employee record.
    await request(server())
      .patch('/hrms/employees/u_aop_rep4')
      .set(as('ho'))
      .send({ role: 'store_manager', employeeCode: 'AOP-4' })
      .expect(200);
    expect(await accessAfter('rep4')).toEqual(likeAnyStoreManager);

    // What head office narrowed on purpose stays narrowed; only what it gave is dropped.
    await request(server())
      .put('/users/u_aop_mkt/access')
      .set(as('ho'))
      .send({ overrides: { crm: 'own', quotation: 'own', calling: 'none' } })
      .expect(200);
    await makeManager('mkt');
    expect((await accessAfter('mkt')).overrides).toEqual({ crm: 'own', calling: 'none' });

    // Only head office edits access: a store manager's role change leaves it as it was.
    await request(server()).patch('/users/u_aop_rep3/role').set(as('mgr')).send({ role: 'marketing' }).expect(200);
    expect((await accessAfter('rep3')).overrides).toEqual({ conversations: 'own' });
  });
});
