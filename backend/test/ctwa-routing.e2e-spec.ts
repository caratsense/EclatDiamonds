import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { extractMetaReferral } from '../src/integrations/meta-referral';
import { resolveAdSetRule } from '../src/crm/adset-rules.service';

/**
 * Click-to-WhatsApp → routing → measured attribution.
 *
 * The routing engine existed and was never reachable: nothing passed a routing
 * context into `ingestInbound`, so no rule could ever fire in production. These
 * tests pin the connected path, and each asserts a rule from the acceptance
 * criteria in docs/COMPETITOR-CRM-ENHANCEMENT-REVIEW.md.
 *
 * FIXTURE, NOT LIVE META. The payload below is the documented CTWA webhook
 * shape with invented ids. It proves the parsing, routing, tenancy and
 * attribution logic. It does NOT prove Meta delivers this — that needs a real
 * ad, app review and a live webhook, and is called out as blocked in the report.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_ctwa_a', slug: 'ctwa-a',
  hyd: 'store_ctwa_hyd', franchise: 'store_ctwa_fr',
  ho: 'ho.ctwa@ctwa-a.local', rep: 'rep.ctwa@ctwa-a.local',
};
const B = { org: 'org_ctwa_b', slug: 'ctwa-b', store: 'store_ctwa_b' };

/** Sanitized Meta CTWA inbound message. Ids are fabricated; the SHAPE is real. */
function ctwaMessage(adId: string, wamid: string) {
  return {
    from: '919000000001',
    id: wamid,
    timestamp: '1757240000',
    type: 'text',
    text: { body: 'Saw your ad, do you have this in 22k?' },
    referral: {
      source_url: 'https://fb.me/2AbCdEfGh',
      source_id: adId,
      source_type: 'ad',
      headline: 'Bridal collection — Hyderabad',
      body: 'Book a private viewing',
      media_type: 'image',
      ctwa_clid: 'ARBxyz123clickid',
    },
  };
}

describe('CTWA ad routing and measured attribution (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let token: string;
  let repId: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({ data: { id: A.org, name: 'CTWA A', slug: A.slug } });
    await prisma.store.createMany({
      data: [
        { id: A.hyd, name: 'Hyderabad', city: 'Hyderabad', organisationId: A.org },
        { id: A.franchise, name: 'Franchise Desk', city: 'Hyderabad', organisationId: A.org },
      ],
    });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.hyd, isPrimary: true } },
      },
    });
    const rep = await prisma.user.create({
      data: {
        email: A.rep, name: 'Rep', role: 'salesperson', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.franchise, isPrimary: true } },
      },
    });
    repId = rep.id;

    // A second tenant, to prove one cannot borrow the other's store.
    await prisma.organisation.create({ data: { id: B.org, name: 'CTWA B', slug: B.slug } });
    await prisma.store.create({ data: { id: B.store, name: 'Other Tenant', city: 'Mumbai', organisationId: B.org } });

    const login = await request(app.getHttpServer()).post('/auth/login').send({ email: A.ho, password: PASSWORD });
    token = login.body.token;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ------------------------------------------------------- referral parsing */

  it('reads the ad id and click id from a real-shape CTWA payload', () => {
    const ref = extractMetaReferral(ctwaMessage('120210000000001', 'wamid.parse'));
    expect(ref).not.toBeNull();
    expect(ref!.adId).toBe('120210000000001');
    expect(ref!.clickId).toBe('ARBxyz123clickid');
    expect(ref!.headline).toBe('Bridal collection — Hyderabad');
    // The honest nulls: Meta does not send ad set or campaign on CTWA, and
    // inventing them would fabricate measured attribution.
    expect(ref!.adSetId).toBeNull();
    expect(ref!.campaignId).toBeNull();
    // Unknown provider fields survive rather than being dropped.
    expect(ref!.raw.media_type).toBe('image');
  });

  it('returns null for an ordinary message, and null is not "organic"', () => {
    expect(extractMetaReferral({ from: '9190', type: 'text', text: { body: 'hi' } })).toBeNull();
    expect(extractMetaReferral({ referral: { source_type: 'ad' } })).toBeNull();
  });

  /* --------------------------------------------------------- rule priority */

  it('a higher-priority tag rule beats a broad ad-set-name rule', () => {
    const rules = [
      { id: 'broad', name: 'Any Hyderabad', enabled: true, priority: 10, matchField: 'ad_set_name' as const,
        matchValue: 'hyderabad', storeId: A.hyd, assignedUserId: null, handling: 'ai' as const },
      { id: 'sharp', name: 'Franchise', enabled: true, priority: 90, matchField: 'tag' as const,
        matchValue: 'franchise', storeId: A.franchise, assignedUserId: null, handling: 'human' as const },
    ];
    const hit = resolveAdSetRule(rules, { adSetName: 'Hyderabad Bridal', tags: ['franchise'] });
    expect(hit?.id).toBe('sharp');
    expect(hit?.handling).toBe('human');
  });

  /* -------------------------------------------------------- tenant validity */

  it('a tenant cannot route to another tenant\'s store', async () => {
    const res = await request(app.getHttpServer())
      .post('/crm/qualification/adset-rules')
      .set(auth())
      .send({ rules: [{
        id: 'r-cross', name: 'Cross tenant', enabled: true, priority: 50,
        matchField: 'ad_id', matchValue: '999', storeId: B.store,
        assignedUserId: null, handling: 'ai',
      }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not part of this organisation/i);
  });

  it('an assignee must belong to the destination store', async () => {
    const res = await request(app.getHttpServer())
      .post('/crm/qualification/adset-rules')
      .set(auth())
      .send({ rules: [{
        id: 'r-mismatch', name: 'Wrong store', enabled: true, priority: 50,
        matchField: 'ad_id', matchValue: '999', storeId: A.hyd,
        assignedUserId: repId, handling: 'human',
      }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must belong to the destination store/i);
  });

  /* ------------------------------------------------- the connected pipeline */

  it('an ad click routes to the right store, opens a lead and records MEASURED attribution', async () => {
    await request(app.getHttpServer())
      .post('/crm/qualification/adset-rules')
      .set(auth())
      .send({ rules: [
        { id: 'r-hyd', name: 'Hyderabad retail', enabled: true, priority: 50,
          matchField: 'ad_id', matchValue: '120210000000001', storeId: A.hyd,
          assignedUserId: null, handling: 'ai' },
        { id: 'r-fr', name: 'Franchise enquiries', enabled: true, priority: 90,
          matchField: 'ad_id', matchValue: '120210000000002', storeId: A.franchise,
          assignedUserId: repId, handling: 'human' },
      ] })
      .expect(201);

    const raw = ctwaMessage('120210000000001', 'wamid.hyd.1');
    const result = await conversations.ingestInbound({
      organisationId: A.org,
      channel: 'whatsapp',
      externalThreadId: '919000000001',
      externalId: 'wamid.hyd.1',
      senderKind: 'whatsapp',
      senderValue: '919000000001',
      body: raw.text.body,
      payload: raw as never,
      adReferral: extractMetaReferral(raw),
    });

    expect(result.duplicate).toBe(false);

    const convo = await prisma.conversation.findUnique({
      where: { id: result.conversationId },
      select: {
        storeId: true, handling: true, assignedUserId: true,
        sourceAdId: true, sourceClickId: true, sourceAdSetId: true, matchedRuleId: true,
      },
    });
    // Acceptance criterion 1: Hyderabad routes to Hyderabad and stays AI-first.
    expect(convo!.storeId).toBe(A.hyd);
    expect(convo!.handling).toBe('ai');
    expect(convo!.matchedRuleId).toBe('r-hyd');
    // Criterion 7: opaque provider ids preserved.
    expect(convo!.sourceAdId).toBe('120210000000001');
    expect(convo!.sourceClickId).toBe('ARBxyz123clickid');
    expect(convo!.sourceAdSetId).toBeNull();

    // A lead was opened, because a store was genuinely known.
    expect(result.leadId).toBeTruthy();

    const touch = await prisma.attributionTouch.findFirst({
      where: { organisationId: A.org, leadId: result.leadId! },
    });
    expect(touch).toBeTruthy();
    expect(touch!.evidence).toBe('measured');
    expect(touch!.externalAdId).toBe('120210000000001');
    expect(touch!.clickId).toBe('ARBxyz123clickid');
    expect(touch!.channel).toBe('ad');
    // Criterion 7 again: measured is a different record from a salesperson's
    // declared source, not an overwrite of it.
    expect(touch!.position).toBe('first_touch');
  });

  it('a franchise ad routes to the human queue with AI disabled', async () => {
    const raw = ctwaMessage('120210000000002', 'wamid.fr.1');
    raw.from = '919000000002';
    const result = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: '919000000002', externalId: 'wamid.fr.1',
      senderKind: 'whatsapp', senderValue: '919000000002',
      body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
    });

    const convo = await prisma.conversation.findUnique({
      where: { id: result.conversationId },
      select: { storeId: true, handling: true, assignedUserId: true, handoffReason: true },
    });
    // Acceptance criterion 2.
    expect(convo!.storeId).toBe(A.franchise);
    expect(convo!.handling).toBe('human');
    expect(convo!.assignedUserId).toBe(repId);
    expect(convo!.handoffReason).toMatch(/Franchise enquiries/);
  });

  it('unmatched ad traffic stays visible and unassigned — no store is guessed', async () => {
    const raw = ctwaMessage('999999999999999', 'wamid.unknown.1');
    raw.from = '919000000003';
    const result = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: '919000000003', externalId: 'wamid.unknown.1',
      senderKind: 'whatsapp', senderValue: '919000000003',
      body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
    });

    const convo = await prisma.conversation.findUnique({
      where: { id: result.conversationId },
      select: { storeId: true, handling: true, sourceAdId: true, status: true },
    });
    // Acceptance criterion 4: visible, unassigned, no invented branch.
    expect(convo!.storeId).toBeNull();
    expect(convo!.handling).toBe('unassigned');
    expect(convo!.status).toBe('open');
    // The ad is still recorded — the click is not lost just because no rule matched.
    expect(convo!.sourceAdId).toBe('999999999999999');
    // And no lead was invented in an arbitrary store.
    expect(result.leadId).toBeNull();
  });

  it('a replayed webhook creates no second message, lead or touch', async () => {
    const before = await prisma.attributionTouch.count({ where: { organisationId: A.org } });
    const leadsBefore = await prisma.lead.count({ where: { organisationId: A.org } });

    const raw = ctwaMessage('120210000000001', 'wamid.hyd.1'); // same wamid as earlier
    const again = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: '919000000001', externalId: 'wamid.hyd.1',
      senderKind: 'whatsapp', senderValue: '919000000001',
      body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
    });

    // Acceptance criterion 6.
    expect(again.duplicate).toBe(true);
    expect(await prisma.attributionTouch.count({ where: { organisationId: A.org } })).toBe(before);
    expect(await prisma.lead.count({ where: { organisationId: A.org } })).toBe(leadsBefore);
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: org } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } });
    // Ad clicks now create a real customer identity (Phase 1B), so these have to
    // go before the organisation can be removed — the org FK is ON DELETE RESTRICT.
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}
