import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { extractMetaReferral } from '../src/integrations/meta-referral';

/**
 * Phase 1 residual correctness: ownership, conflict resolution, concurrency and
 * queue visibility.
 *
 * The defect this file exists for: `applyRoute` tested only `!matchedRuleId`.
 * A conversation a MANAGER assigned by hand has no matched rule, so a later ad
 * would quietly take a thread that already had a branch, an owner and a person
 * handling it — moving live work, and its owner's pipeline, to another city.
 */
const PW = 'password123';

const O = {
  org: 'org_p1b', slug: 'p1b',
  hyd: 'store_p1b_hyd', mum: 'store_p1b_mum',
  ho: 'ho.p1b@p1b.local',
  hydRep: 'hyd.rep@p1b.local',
  mumRep: 'mum.rep@p1b.local',
};

function ctwa(adId: string, wamid: string, from: string, clid: string | null) {
  return {
    from, id: wamid, timestamp: '1757240000', type: 'text',
    text: { body: 'Saw your ad' },
    referral: {
      source_url: 'https://fb.me/x', source_id: adId, source_type: 'ad',
      headline: 'Campaign', body: 'Enquire now',
      ...(clid ? { ctwa_clid: clid } : {}),
    },
  };
}

describe('CRM Phase 1B — routing ownership, conflicts, concurrency, queues (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let convos: ConversationsService;
  let hoToken: string;
  let mumRepToken: string;
  let hydRepId: string;
  let mumRepId: string;

  const ho = () => ({ Authorization: `Bearer ${hoToken}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    convos = app.get(ConversationsService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PW, 10);
    await prisma.organisation.create({ data: { id: O.org, name: 'P1B', slug: O.slug } });
    await prisma.store.createMany({ data: [
      { id: O.hyd, name: 'Hyderabad', city: 'Hyderabad', organisationId: O.org },
      { id: O.mum, name: 'Mumbai', city: 'Mumbai', organisationId: O.org },
    ]});
    await prisma.user.create({ data: {
      email: O.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
      approvalStatus: 'approved', organisationId: O.org,
      userStores: { create: { storeId: O.hyd, isPrimary: true } },
    }});
    const hydRep = await prisma.user.create({ data: {
      email: O.hydRep, name: 'Hyd Rep', role: 'salesperson', passwordHash: hash, isActive: true,
      approvalStatus: 'approved', organisationId: O.org,
      userStores: { create: { storeId: O.hyd, isPrimary: true } },
    }});
    const mumRep = await prisma.user.create({ data: {
      email: O.mumRep, name: 'Mum Rep', role: 'salesperson', passwordHash: hash, isActive: true,
      approvalStatus: 'approved', organisationId: O.org,
      userStores: { create: { storeId: O.mum, isPrimary: true } },
    }});
    hydRepId = hydRep.id; mumRepId = mumRep.id;

    await setRules(prisma, O.org, [
      { id: 'r-hyd', name: 'Hyderabad', enabled: true, priority: 50, matchField: 'ad_id',
        matchValue: 'AD_HYD', storeId: O.hyd, assignedUserId: null, handling: 'ai' },
      { id: 'r-mum', name: 'Mumbai', enabled: true, priority: 50, matchField: 'ad_id',
        matchValue: 'AD_MUM', storeId: O.mum, assignedUserId: null, handling: 'ai' },
    ]);

    hoToken = (await request(app.getHttpServer()).post('/auth/login').send({ email: O.ho, password: PW })).body.token;
    mumRepToken = (await request(app.getHttpServer()).post('/auth/login').send({ email: O.mumRep, password: PW })).body.token;
  });

  afterAll(async () => { await teardown(prisma); await app?.close(); });

  /* ================================================================ 1A */

  it('1A: a MANUALLY assigned Mumbai thread is not seized by a Hyderabad ad', async () => {
    const first = ctwa('AD_NONE', 'wa.1a.1', '919220000001', 'CL_1A1');
    const r = await ingest(convos, first, 'th-1a');
    // Nothing matched, so it is genuinely unassigned — then a manager routes it.
    await convos.assign(await hoUser(prisma), r.conversationId, {
      storeId: O.mum, assignedUserId: mumRepId, handling: 'human', reason: 'Manual',
    });

    const ad = ctwa('AD_HYD', 'wa.1a.2', '919220000001', 'CL_1A2');
    await ingest(convos, ad, 'th-1a');

    const c = await prisma.conversation.findUnique({
      where: { id: r.conversationId },
      select: { storeId: true, assignedUserId: true, handling: true, routingReviewRequired: true },
    });
    // The defect: this used to become Hyderabad/ai and drop the owner.
    expect(c!.storeId).toBe(O.mum);
    expect(c!.assignedUserId).toBe(mumRepId);
    expect(c!.handling).toBe('human');
    expect(c!.routingReviewRequired).toBe(true);
  });

  it('1A: a manually human-handled thread is not flipped to AI by a later rule', async () => {
    const first = ctwa('AD_NONE', 'wa.1a.3', '919220000002', 'CL_1A3');
    const r = await ingest(convos, first, 'th-1a2');
    await convos.assign(await hoUser(prisma), r.conversationId, {
      storeId: O.hyd, assignedUserId: hydRepId, handling: 'human', reason: 'Manual',
    });

    // Same store, but the rule wants AI.
    await ingest(convos, ctwa('AD_HYD', 'wa.1a.4', '919220000002', 'CL_1A4'), 'th-1a2');

    const c = await prisma.conversation.findUnique({
      where: { id: r.conversationId }, select: { handling: true, assignedUserId: true },
    });
    expect(c!.handling).toBe('human');
    expect(c!.assignedUserId).toBe(hydRepId);
  });

  it('1A: a genuinely unassigned thread DOES accept its first rule', async () => {
    const r = await ingest(convos, ctwa('AD_HYD', 'wa.1a.5', '919220000003', 'CL_1A5'), 'th-1a3');
    const c = await prisma.conversation.findUnique({
      where: { id: r.conversationId },
      select: { storeId: true, handling: true, matchedRuleId: true, routingReviewRequired: true },
    });
    expect(c!.storeId).toBe(O.hyd);
    expect(c!.handling).toBe('ai');
    expect(c!.matchedRuleId).toBe('r-hyd');
    expect(c!.routingReviewRequired).toBe(false);
  });

  it('1A: an automated thread receiving another store\'s ad keeps its store and flags review', async () => {
    const r = await ingest(convos, ctwa('AD_HYD', 'wa.1a.6', '919220000004', 'CL_1A6'), 'th-1a4');
    await ingest(convos, ctwa('AD_MUM', 'wa.1a.7', '919220000004', 'CL_1A7'), 'th-1a4');
    const c = await prisma.conversation.findUnique({
      where: { id: r.conversationId },
      select: { storeId: true, matchedRuleId: true, routingReviewRequired: true },
    });
    expect(c!.storeId).toBe(O.hyd);
    expect(c!.matchedRuleId).toBe('r-hyd');
    expect(c!.routingReviewRequired).toBe(true);
  });

  it('1A: a SAME-store later ad changes nothing and raises no conflict', async () => {
    const r = await ingest(convos, ctwa('AD_HYD', 'wa.1a.8', '919220000005', 'CL_1A8'), 'th-1a5');
    const before = await prisma.conversation.findUnique({
      where: { id: r.conversationId }, select: { storeId: true, assignedUserId: true, handling: true },
    });
    await ingest(convos, ctwa('AD_HYD', 'wa.1a.9', '919220000005', 'CL_1A9'), 'th-1a5');
    const after = await prisma.conversation.findUnique({
      where: { id: r.conversationId },
      select: { storeId: true, assignedUserId: true, handling: true, routingReviewRequired: true },
    });
    expect(after!.storeId).toBe(before!.storeId);
    expect(after!.assignedUserId).toBe(before!.assignedUserId);
    expect(after!.handling).toBe(before!.handling);
    expect(after!.routingReviewRequired).toBe(false);
  });

  /* ================================================================ 1B */

  it('1B: the conflict is a queryable ROW carrying original and proposed routing', async () => {
    const conflicts = await prisma.conversationRoutingConflict.findMany({
      where: { organisationId: O.org, resolution: null },
      orderBy: { detectedAt: 'asc' },
    });
    expect(conflicts.length).toBeGreaterThan(0);
    const c = conflicts[0];
    expect(c.originalStoreId).toBeTruthy();
    expect(c.proposedStoreId).toBeTruthy();
    expect(c.originalStoreId).not.toBe(c.proposedStoreId);
    expect(c.sourceAdId).toBeTruthy();
    expect(c.detectedAt).toBeInstanceOf(Date);
    expect(c.resolution).toBeNull();
  });

  it('1B: keeping the original clears the flag and preserves routing + history', async () => {
    const conflict = await prisma.conversationRoutingConflict.findFirst({
      where: { organisationId: O.org, resolution: null },
    });
    const before = await prisma.conversation.findUnique({
      where: { id: conflict!.conversationId }, select: { storeId: true, assignedUserId: true },
    });

    const res = await request(app.getHttpServer())
      .post(`/crm/conversations/routing-conflicts/${conflict!.id}/resolve`)
      .set(ho())
      .send({ decision: 'kept_original', note: 'Belongs to the original branch.' });
    expect(res.status).toBe(201);

    const after = await prisma.conversation.findUnique({
      where: { id: conflict!.conversationId },
      select: { storeId: true, assignedUserId: true, routingReviewRequired: true },
    });
    expect(after!.storeId).toBe(before!.storeId);
    expect(after!.assignedUserId).toBe(before!.assignedUserId);
    expect(after!.routingReviewRequired).toBe(false);

    // History is kept, not deleted.
    const row = await prisma.conversationRoutingConflict.findUnique({ where: { id: conflict!.id } });
    expect(row).toBeTruthy();
    expect(row!.resolution).toBe('kept_original');
    expect(row!.resolvedById).toBeTruthy();
    expect(row!.resolvedAt).toBeInstanceOf(Date);
  });

  it('1B: a conflict cannot be resolved twice', async () => {
    const done = await prisma.conversationRoutingConflict.findFirst({
      where: { organisationId: O.org, NOT: { resolution: null } },
    });
    const res = await request(app.getHttpServer())
      .post(`/crm/conversations/routing-conflicts/${done!.id}/resolve`)
      .set(ho()).send({ decision: 'kept_original' });
    expect(res.status).toBe(400);
  });

  /* ================================================================ 1E */

  it('1E: an assignee who does not work at the destination is refused', async () => {
    const r = await ingest(convos, ctwa('AD_HYD', 'wa.1e.1', '919220000010', 'CL_1E1'), 'th-1e');
    const res = await request(app.getHttpServer())
      .post(`/crm/conversations/${r.conversationId}/assign`)
      .set(ho())
      .send({ storeId: O.hyd, assignedUserId: mumRepId });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not work at the destination/i);
  });

  it('1E: assigning a person with no destination location is refused', async () => {
    const r = await ingest(convos, ctwa('AD_NONE', 'wa.1e.2', '919220000011', 'CL_1E2'), 'th-1e2');
    const res = await request(app.getHttpServer())
      .post(`/crm/conversations/${r.conversationId}/assign`)
      .set(ho()).send({ assignedUserId: hydRepId });
    expect(res.status).toBe(400);
  });

  it('1E: a valid assignment moves store, owner and handling together and is audited', async () => {
    const r = await ingest(convos, ctwa('AD_HYD', 'wa.1e.3', '919220000012', 'CL_1E3'), 'th-1e3');
    const res = await request(app.getHttpServer())
      .post(`/crm/conversations/${r.conversationId}/assign`)
      .set(ho())
      .send({ storeId: O.hyd, assignedUserId: hydRepId, handling: 'human', reason: 'Taking over' });
    expect(res.status).toBe(201);
    expect(res.body.storeId).toBe(O.hyd);
    expect(res.body.assignedUserId).toBe(hydRepId);
    expect(res.body.handling).toBe('human');

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: O.org, action: 'conversation.assigned', entityId: r.conversationId },
    });
    expect(audit).toBeTruthy();
  });

  it('1E: a caller cannot assign into a store outside their own scope', async () => {
    const r = await ingest(convos, ctwa('AD_MUM', 'wa.1e.4', '919220000013', 'CL_1E4'), 'th-1e4');
    // The Mumbai rep tries to move a thread to Hyderabad.
    const res = await request(app.getHttpServer())
      .post(`/crm/conversations/${r.conversationId}/assign`)
      .set({ Authorization: `Bearer ${mumRepToken}` })
      .send({ storeId: O.hyd });
    expect([403, 404]).toContain(res.status);
  });

  /* ================================================================ 1C/1D */

  it('1C/1D: concurrent deliveries of the same click yield one lead, one touch, one party', async () => {
    const from = '919220000020';
    const a = ctwa('AD_HYD', 'wa.cc.1', from, 'CL_CONCURRENT');
    const b = ctwa('AD_HYD', 'wa.cc.2', from, 'CL_CONCURRENT');

    // Different provider message ids (so the message dedupe does NOT cover it),
    // same click — fired together.
    const [r1, r2] = await Promise.all([
      ingest(convos, a, 'th-cc'),
      ingest(convos, b, 'th-cc'),
    ]);
    expect(r1.conversationId).toBe(r2.conversationId);

    const leads = await prisma.lead.findMany({
      where: { organisationId: O.org, originKey: 'click:CL_CONCURRENT' }, select: { id: true },
    });
    expect(leads).toHaveLength(1);

    const touches = await prisma.attributionTouch.count({
      where: { organisationId: O.org, clickId: 'CL_CONCURRENT' },
    });
    expect(touches).toBe(1);

    const parties = await prisma.contactPoint.count({
      where: { organisationId: O.org, valueNormalized: { contains: '9220000020' } },
    });
    expect(parties).toBe(1);

    // Both messages persisted — they are genuinely different messages.
    const msgs = await prisma.message.count({
      where: { organisationId: O.org, externalId: { in: ['wa.cc.1', 'wa.cc.2'] } },
    });
    expect(msgs).toBe(2);
  });

  it('1D: the SAME provider message delivered twice concurrently creates one message', async () => {
    const from = '919220000021';
    const m = ctwa('AD_HYD', 'wa.same.1', from, 'CL_SAME');
    const [x, y] = await Promise.all([
      ingest(convos, m, 'th-same'),
      ingest(convos, m, 'th-same'),
    ]);
    expect(x.conversationId).toBe(y.conversationId);
    const n = await prisma.message.count({ where: { organisationId: O.org, externalId: 'wa.same.1' } });
    expect(n).toBe(1);
    // Exactly one of the two calls is a duplicate; neither throws.
    expect([x.duplicate, y.duplicate].filter(Boolean)).toHaveLength(1);
  });

  it('1C: a genuinely different click creates a second opportunity when the first is closed', async () => {
    const leadOne = await prisma.lead.findFirst({
      where: { organisationId: O.org, originKey: 'click:CL_CONCURRENT' },
    });
    await prisma.lead.update({ where: { id: leadOne!.id }, data: { outcome: 'won' } });

    await ingest(convos, ctwa('AD_HYD', 'wa.cc.3', '919220000020', 'CL_SECOND'), 'th-cc');
    const second = await prisma.lead.findFirst({
      where: { organisationId: O.org, originKey: 'click:CL_SECOND' },
    });
    expect(second).toBeTruthy();
    expect(second!.id).not.toBe(leadOne!.id);
  });

  /* ================================================================ 1F */

  it('1F: a salesperson cannot see the central (storeless) queue', async () => {
    // Make an unrouted, storeless conversation.
    await ingest(convos, ctwa('AD_NONE', 'wa.1f.1', '919220000030', 'CL_1F1'), 'th-1f');

    const asRep = await request(app.getHttpServer())
      .get('/crm/conversations').set({ Authorization: `Bearer ${mumRepToken}` });
    expect(asRep.status).toBe(200);
    const storeless = (asRep.body as Array<{ storeId: string | null }>).filter((c) => c.storeId === null);
    // The defect this closes: every user used to see every unrouted thread in
    // the tenant, including customers from branches they do not work at.
    expect(storeless).toHaveLength(0);

    const asHo = await request(app.getHttpServer()).get('/crm/conversations').set(ho());
    expect((asHo.body as Array<{ storeId: string | null }>).some((c) => c.storeId === null)).toBe(true);
  });

  it('1F: a salesperson cannot open a storeless conversation by id either', async () => {
    const storeless = await prisma.conversation.findFirst({
      where: { organisationId: O.org, storeId: null }, select: { id: true },
    });
    const res = await request(app.getHttpServer())
      .get(`/crm/conversations/${storeless!.id}`)
      .set({ Authorization: `Bearer ${mumRepToken}` });
    expect(res.status).toBe(404);
  });

  /* ================================================================ 1G */

  it('1G: the three AI switches default OFF and are readable', async () => {
    const res = await request(app.getHttpServer()).get('/crm/qualification/ai-settings').set(ho());
    expect(res.status).toBe(200);
    expect(res.body.qualificationEnabled).toBe(false);
    expect(res.body.draftEnabled).toBe(false);
    expect(res.body.autoSendEnabled).toBe(false);
    expect(res.body.providerConfigured).toBe(false);
  });

  it('1G: saving one switch does not clobber unrelated Organisation.settings', async () => {
    const before = await prisma.organisation.findUnique({ where: { id: O.org }, select: { settings: true } });
    const rulesBefore = (before!.settings as Record<string, unknown>).crmAdSetRules;
    expect(Array.isArray(rulesBefore)).toBe(true);

    const res = await request(app.getHttpServer())
      .post('/crm/qualification/ai-settings').set(ho())
      .send({ qualificationEnabled: true });
    expect(res.status).toBe(201);
    expect(res.body.qualificationEnabled).toBe(true);
    // Draft/auto-send must NOT be turned on by enabling qualification.
    expect(res.body.draftEnabled).toBe(false);
    expect(res.body.autoSendEnabled).toBe(false);

    const after = await prisma.organisation.findUnique({ where: { id: O.org }, select: { settings: true } });
    expect((after!.settings as Record<string, unknown>).crmAdSetRules).toEqual(rulesBefore);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: O.org, action: 'crm.ai_settings_updated' },
    });
    expect(audit).toBeTruthy();
  });

  it('1G: a salesperson cannot change the AI switches', async () => {
    const res = await request(app.getHttpServer())
      .post('/crm/qualification/ai-settings')
      .set({ Authorization: `Bearer ${mumRepToken}` })
      .send({ draftEnabled: true });
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ helpers */

async function ingest(svc: ConversationsService, raw: ReturnType<typeof ctwa>, thread: string) {
  return svc.ingestInbound({
    organisationId: O.org, channel: 'whatsapp', externalThreadId: thread,
    externalId: raw.id, senderKind: 'whatsapp', senderValue: raw.from,
    body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
  });
}

async function hoUser(prisma: PrismaService) {
  const u = await prisma.user.findFirst({ where: { email: O.ho }, include: { userStores: true } });
  return {
    id: u!.id, email: u!.email, role: 'head_office' as const, name: u!.name,
    organisationId: O.org, storeIds: [O.hyd, O.mum], allStores: true,
  };
}

async function setRules(prisma: PrismaService, org: string, rules: unknown[]) {
  const o = await prisma.organisation.findUnique({ where: { id: org }, select: { settings: true } });
  await prisma.organisation.update({
    where: { id: org },
    data: { settings: { ...((o?.settings ?? {}) as object), crmAdSetRules: rules } as never },
  });
}

async function teardown(prisma: PrismaService) {
  await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: O.org } });
  await prisma.attributionTouch.deleteMany({ where: { organisationId: O.org } });
  await prisma.message.deleteMany({ where: { organisationId: O.org } });
  await prisma.conversation.deleteMany({ where: { organisationId: O.org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: O.org } }).catch(() => undefined);
  await prisma.lead.deleteMany({ where: { organisationId: O.org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: O.org } });
  await prisma.party.deleteMany({ where: { organisationId: O.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: O.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: O.org } } });
  await prisma.user.deleteMany({ where: { organisationId: O.org } });
  await prisma.store.deleteMany({ where: { organisationId: O.org } });
  await prisma.organisation.deleteMany({ where: { id: O.org } });
}
