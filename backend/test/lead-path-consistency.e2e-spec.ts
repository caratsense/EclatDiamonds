import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { MetaLeadAdapter } from '../src/integrations/meta-lead.adapter';
import { extractMetaReferral } from '../src/integrations/meta-referral';
import type { MetaLeadRecord } from '../src/integrations/meta-contracts';

/**
 * Every door into the pipeline must treat an enquiry the same way.
 *
 * Two gaps this pins, both of which made an identical customer worse off purely
 * because of which channel they arrived through:
 *
 *  1. A Meta lead form that matched a rule naming a store but no assignee was
 *     left unowned, while a QR scan or an ad click into the same branch was put
 *     in the fair queue immediately. Nobody chased the Meta ones.
 *
 *  2. An ad click that matched no routing rule correctly refused to guess a
 *     store — and then, when a human finally routed the thread, nothing opened
 *     the lead. The enquiry stayed a conversation for good and its measured ad
 *     spend never reached the pipeline or ROAS.
 *
 * FIXTURE, NOT LIVE META. The CTWA payload is the documented webhook shape with
 * invented ids, and the Lead Ads record is constructed directly. These prove the
 * CRM half — routing, assignment, exactly-once and attribution. They do not
 * prove Meta delivers either payload.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_lpc_a',
  slug: 'lpc-a',
  hyd: 'store_lpc_hyd',
  integ: 'integ_lpc_a',
  ho: 'ho.lpc@lpc-a.local',
  rep1: 'rep1.lpc@lpc-a.local',
  rep2: 'rep2.lpc@lpc-a.local',
};

function ctwaMessage(adId: string, wamid: string, from: string, clickId: string | null) {
  return {
    from,
    id: wamid,
    timestamp: '1757240000',
    type: 'text',
    text: { body: 'Saw your ad — is this available?' },
    referral: {
      source_url: 'https://fb.me/2AbCdEfGh',
      source_id: adId,
      source_type: 'ad',
      headline: 'Festive collection',
      body: 'Book a viewing',
      media_type: 'image',
      ...(clickId ? { ctwa_clid: clickId } : {}),
    },
  };
}

describe('Lead-path consistency: every door assigns and opens the same way (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let sink: MetaLeadAdapter;
  let token: string;
  let rep1Id: string;
  let rep2Id: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const metaRecord = (over: Partial<MetaLeadRecord> = {}): MetaLeadRecord =>
    ({
      organisationId: A.org,
      integrationId: A.integ,
      leadgenId: 'lg_lpc_1',
      pageId: '55501',
      formId: 'form_9',
      createdAt: new Date('2026-09-10T09:00:00.000Z'),
      adId: 'ad_lpc_1',
      adSetId: null,
      campaignId: null,
      adName: 'Festive ad',
      adSetName: null,
      campaignName: null,
      fullName: 'Priya Menon',
      phone: '+919812345601',
      email: 'priya.lpc@example.com',
      fields: [{ name: 'full_name', values: ['Priya Menon'] }],
      ...over,
    }) as MetaLeadRecord;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);
    sink = app.get(MetaLeadAdapter);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({ data: { id: A.org, name: 'LPC A', slug: A.slug } });
    await prisma.store.create({
      data: { id: A.hyd, name: 'Hyderabad', city: 'Hyderabad', organisationId: A.org },
    });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.hyd, isPrimary: true } },
      },
    });
    const r1 = await prisma.user.create({
      data: {
        email: A.rep1, name: 'Rep One', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.hyd, isPrimary: true } },
      },
    });
    const r2 = await prisma.user.create({
      data: {
        email: A.rep2, name: 'Rep Two', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.hyd, isPrimary: true } },
      },
    });
    rep1Id = r1.id;
    rep2Id = r2.id;

    await prisma.integration.create({
      data: {
        id: A.integ, organisationId: A.org, providerCode: 'meta_ads',
        status: 'connected', name: 'Meta',
      },
    });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: A.ho, password: PASSWORD });
    token = login.body.token;

    // The branch runs a fair queue. Both reps are eligible.
    await request(app.getHttpServer())
      .put('/crm/round-robin/policy')
      .set(auth())
      .send({ enabled: true, stores: [{ storeId: A.hyd, eligibleUserIds: [rep1Id, rep2Id] }] })
      .expect(200);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------- Meta Lead Ads → fair queue */

  describe('Meta Lead Ads joins the same queue as every other door', () => {
    it('gives a lead an owner when the rule chose a store but named no assignee', async () => {
      await request(app.getHttpServer())
        .post('/crm/qualification/adset-rules')
        .set(auth())
        .send({
          rules: [{
            id: 'r-meta', name: 'Festive', enabled: true, priority: 50,
            matchField: 'ad_id', matchValue: 'ad_lpc_1', storeId: A.hyd,
            assignedUserId: null, handling: 'ai',
          }],
        })
        .expect(201);

      const res = await sink.acceptMetaLead(metaRecord());
      expect(res.accepted).toBe(true);

      const lead = await prisma.lead.findUnique({
        where: { id: res.leadId! },
        select: { ownerId: true, storeId: true, source: true },
      });
      expect(lead!.storeId).toBe(A.hyd);
      expect(lead!.source).toBe('meta_ads');
      // The whole point: previously null.
      expect(lead!.ownerId).toBeTruthy();
      expect([rep1Id, rep2Id]).toContain(lead!.ownerId);
    });

    it('does not reassign on redelivery of the same leadgen id', async () => {
      const before = await prisma.lead.findFirst({
        where: { organisationId: A.org, originKey: 'meta_lead:lg_lpc_1' },
        select: { id: true, ownerId: true },
      });

      const again = await sink.acceptMetaLead(metaRecord());
      expect(again.duplicate).toBe(true);
      expect(again.leadId).toBe(before!.id);

      const after = await prisma.lead.findUnique({
        where: { id: before!.id },
        select: { ownerId: true },
      });
      expect(after!.ownerId).toBe(before!.ownerId);

      const count = await prisma.lead.count({
        where: { organisationId: A.org, originKey: 'meta_lead:lg_lpc_1' },
      });
      expect(count).toBe(1);
    });

    it('records the automatic assignment in the audit trail', async () => {
      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, originKey: 'meta_lead:lg_lpc_1' },
        select: { id: true },
      });
      const trail = await prisma.auditLog.findMany({
        where: { organisationId: A.org, entityType: 'Lead', entityId: lead!.id },
        select: { action: true, systemActorId: true },
      });
      // An automatic assignment nobody can see is an assignment nobody can
      // question. It is attributed to the system actor, not to a person.
      expect(trail.some((t) => /round_robin/i.test(t.action))).toBe(true);
      expect(trail.every((t) => t.systemActorId !== undefined)).toBe(true);
    });
  });

  /* --------------------------- CTWA: a store supplied later opens the lead */

  describe('an ad click routed later still becomes exactly one lead', () => {
    const CLICK = 'ARBlpcClick001';
    let conversationId: string;

    it('opens no lead while no rule supplies a branch', async () => {
      const raw = ctwaMessage('ad_unrouted_lpc', 'wamid.lpc.1', '919000000501', CLICK);
      const result = await conversations.ingestInbound({
        organisationId: A.org,
        channel: 'whatsapp',
        externalThreadId: '919000000501',
        externalId: 'wamid.lpc.1',
        senderKind: 'whatsapp',
        senderValue: '919000000501',
        body: raw.text.body,
        payload: raw as never,
        adReferral: extractMetaReferral(raw),
      });
      conversationId = result.conversationId;

      // Correct refusal: a store is never guessed.
      expect(result.leadId).toBeNull();
      const convo = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { storeId: true, sourceClickId: true },
      });
      expect(convo!.storeId).toBeNull();
      // The click survives on the row, which is what makes the backfill possible.
      expect(convo!.sourceClickId).toBe(CLICK);
    });

    it('opens the lead when a human supplies the branch', async () => {
      const res = await request(app.getHttpServer())
        .post(`/crm/conversations/${conversationId}/assign`)
        .set(auth())
        .send({ storeId: A.hyd, handling: 'human', reason: 'Routed by hand' });
      expect(res.status).toBe(201);

      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, originKey: `click:${CLICK}` },
        select: { id: true, storeId: true, source: true, phone: true },
      });
      expect(lead).toBeTruthy();
      expect(lead!.storeId).toBe(A.hyd);
      expect(lead!.source).toBe('whatsapp');
      // A lead nobody can call is not a lead.
      expect(lead!.phone).toBeTruthy();
    });

    it('moves the measured touch onto the lead instead of counting the click twice', async () => {
      const lead = await prisma.lead.findFirst({
        where: { organisationId: A.org, originKey: `click:${CLICK}` },
        select: { id: true, partyId: true },
      });

      const onLead = await prisma.attributionTouch.findMany({
        where: { organisationId: A.org, leadId: lead!.id, channel: 'ad' },
        select: { clickId: true, evidence: true },
      });
      expect(onLead).toHaveLength(1);
      expect(onLead[0].clickId).toBe(CLICK);
      expect(onLead[0].evidence).toBe('measured');

      // Nothing left dangling on the party, and nothing duplicated: exactly one
      // touch exists for this click in the whole tenant.
      const all = await prisma.attributionTouch.count({
        where: { organisationId: A.org, clickId: CLICK },
      });
      expect(all).toBe(1);
    });

    it('re-routing the same thread does not open a second lead', async () => {
      // Send it back to the central queue, then route it again.
      await request(app.getHttpServer())
        .post(`/crm/conversations/${conversationId}/assign`)
        .set(auth())
        .send({ storeId: null, reason: 'Back to the queue' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/crm/conversations/${conversationId}/assign`)
        .set(auth())
        .send({ storeId: A.hyd, reason: 'Routed again' })
        .expect(201);

      const count = await prisma.lead.count({
        where: { organisationId: A.org, originKey: `click:${CLICK}` },
      });
      expect(count).toBe(1);

      const touches = await prisma.attributionTouch.count({
        where: { organisationId: A.org, clickId: CLICK },
      });
      expect(touches).toBe(1);
    });

    it('opens nothing for a thread that never came from an ad', async () => {
      const before = await prisma.lead.count({ where: { organisationId: A.org } });
      const result = await conversations.ingestInbound({
        organisationId: A.org,
        channel: 'whatsapp',
        externalThreadId: '919000000502',
        externalId: 'wamid.lpc.organic',
        senderKind: 'whatsapp',
        senderValue: '919000000502',
        body: 'Do you open on Sunday?',
        payload: {} as never,
      });

      await request(app.getHttpServer())
        .post(`/crm/conversations/${result.conversationId}/assign`)
        .set(auth())
        .send({ storeId: A.hyd, reason: 'Someone should answer this' })
        .expect(201);

      // Routing an ordinary question must not manufacture a sales lead.
      const after = await prisma.lead.count({ where: { organisationId: A.org } });
      expect(after).toBe(before);
    });
  });
});

async function teardown(prisma: PrismaService) {
  const org = A.org;
  await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: org } });
  await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
  await prisma.message.deleteMany({ where: { organisationId: org } });
  await prisma.conversation.deleteMany({ where: { organisationId: org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: org } } }).catch(() => undefined);
  await prisma.lead.deleteMany({ where: { organisationId: org } });
  await prisma.integrationCredential.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.integrationAsset.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.integration.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
  await prisma.party.deleteMany({ where: { organisationId: org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
  await prisma.user.deleteMany({ where: { organisationId: org } });
  await prisma.store.deleteMany({ where: { organisationId: org } });
  await prisma.organisation.deleteMany({ where: { id: org } });
}
