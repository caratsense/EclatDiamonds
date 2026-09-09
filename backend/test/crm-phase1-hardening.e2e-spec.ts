import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { ConversationAiGate, AI_RESPONDER, type AiResponder, type AiReply } from '../src/crm/ai-responder';
import { extractMetaReferral } from '../src/integrations/meta-referral';

/**
 * Phase 1 hardening — each test pins a defect that was real in the shipped code.
 *
 *   A  lead reuse ignored the routed store, so a Hyderabad ad could attach its
 *      attribution to an open Mumbai lead.
 *   B  an ad click produced an anonymous lead with no phone, despite the sender's
 *      number being right there in the payload.
 *   C  a second ad on the same thread silently moved an active conversation
 *      (and its owner's pipeline) to another branch.
 *   D  two different messages carrying the same click double-counted attribution.
 *   E  "AI vs human" was a string nothing read at reply time. These tests assert
 *      the responder was INVOKED or NOT INVOKED, which a column cannot show.
 */

/** Deterministic fake provider. No network, no credentials, no model. */
class SpyResponder implements AiResponder {
  readonly name = 'spy';
  calls: string[] = [];
  configured = true;
  reply: AiReply | null = { text: 'Certainly — which piece caught your eye?', confidence: 0.9, provider: 'spy', model: 'spy-1' };
  throwOnCall = false;

  isConfigured() { return this.configured; }
  async propose(ctx: { conversationId: string }): Promise<AiReply | null> {
    this.calls.push(ctx.conversationId);
    if (this.throwOnCall) throw new Error('provider exploded');
    return this.reply;
  }
}

const P = {
  org: 'org_p1', slug: 'p1-crm',
  hyd: 'store_p1_hyd', mum: 'store_p1_mum',
  ho: 'ho.p1@p1.local',
};
const T2 = { org: 'org_p1_b', slug: 'p1-crm-b', store: 'store_p1_b' };

function ctwa(adId: string, wamid: string, from: string, clid: string | null) {
  return {
    from, id: wamid, timestamp: '1757240000', type: 'text',
    text: { body: 'Saw your ad' },
    referral: {
      source_url: 'https://fb.me/x', source_id: adId, source_type: 'ad',
      headline: 'Bridal', body: 'Book a viewing',
      ...(clid ? { ctwa_clid: clid } : {}),
    },
  };
}

describe('CRM Phase 1 hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let gate: ConversationAiGate;
  const spy = new SpyResponder();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_RESPONDER)
      .useValue(spy)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);
    gate = app.get(ConversationAiGate);

    await teardown(prisma);
    await prisma.organisation.create({ data: { id: P.org, name: 'P1', slug: P.slug } });
    await prisma.store.createMany({ data: [
      { id: P.hyd, name: 'Hyderabad', city: 'Hyderabad', organisationId: P.org },
      { id: P.mum, name: 'Mumbai', city: 'Mumbai', organisationId: P.org },
    ]});
    await prisma.organisation.create({ data: { id: T2.org, name: 'P1B', slug: T2.slug } });

    // Phase 2C: the gate refuses to draft with no supporting material, so the
    // tenant whose tests expect a DRAFT needs a document to answer from. The
    // chunk deliberately contains the words these tests ask about.
    const doc = await prisma.knowledgeDocument.create({ data: {
      organisationId: P.org, title: 'P1 handbook', originalFileName: 'handbook.txt',
      mimeType: 'text/plain', sizeBytes: 64, sha256: 'sha-p1-hardening',
      storageKey: 'k/p1/handbook.txt', status: 'ready',
    }});
    const chunk = 'We stock bangles, rings and chains. Hello and welcome.';
    await prisma.knowledgeChunk.create({ data: {
      organisationId: P.org, documentId: doc.id, chunkIndex: 0, content: chunk,
      charStart: 0, charEnd: chunk.length,
    }});
    await prisma.store.create({ data: { id: T2.store, name: 'Other', city: 'Delhi', organisationId: T2.org } });

    await setRules(prisma, P.org, [
      { id: 'r-hyd', name: 'Hyderabad', enabled: true, priority: 50, matchField: 'ad_id',
        matchValue: 'AD_HYD', storeId: P.hyd, assignedUserId: null, handling: 'ai' },
      { id: 'r-mum', name: 'Mumbai', enabled: true, priority: 50, matchField: 'ad_id',
        matchValue: 'AD_MUM', storeId: P.mum, assignedUserId: null, handling: 'ai' },
      { id: 'r-hum', name: 'Franchise', enabled: true, priority: 60, matchField: 'ad_id',
        matchValue: 'AD_HUMAN', storeId: P.hyd, assignedUserId: null, handling: 'human' },
    ]);
  });

  afterAll(async () => { await teardown(prisma); await app?.close(); });
  beforeEach(() => { spy.calls = []; spy.configured = true; spy.throwOnCall = false; });

  /* ------------------------------------------------------------------ B */

  it('B: an ad click creates a real customer with the phone, not an anonymous lead', async () => {
    const raw = ctwa('AD_HYD', 'wa.b1', '919111100001', 'CLID_B1');
    const res = await ingest(conversations, raw, 'AD_HYD');

    expect(res.leadId).toBeTruthy();
    const lead = await prisma.lead.findUnique({
      where: { id: res.leadId! },
      select: { phone: true, partyId: true, storeId: true, customerName: true },
    });
    // The defect: this used to be null, giving sales a lead they could not call.
    expect(lead!.phone).toBeTruthy();
    expect(lead!.partyId).toBeTruthy();
    expect(lead!.storeId).toBe(P.hyd);
    expect(lead!.customerName).not.toBe('Unidentified ad enquiry');

    // A tenant-scoped ContactPoint now owns the number.
    const cp = await prisma.contactPoint.findFirst({
      where: { organisationId: P.org, partyId: lead!.partyId! },
      select: { kind: true, valueNormalized: true },
    });
    expect(cp).toBeTruthy();
    expect(cp!.valueNormalized).toContain('9111100001');
  });

  it('B: a returning customer reuses the existing Party — no duplicate is created', async () => {
    const before = await prisma.party.count({ where: { organisationId: P.org } });
    const raw = ctwa('AD_HYD', 'wa.b2', '919111100001', 'CLID_B2');
    await ingest(conversations, raw, 'AD_HYD');
    expect(await prisma.party.count({ where: { organisationId: P.org } })).toBe(before);
  });

  it('B: the same number in another tenant is a DIFFERENT customer', async () => {
    await setRules(prisma, T2.org, [{ id: 'r-b', name: 'B', enabled: true, priority: 50,
      matchField: 'ad_id', matchValue: 'AD_HYD', storeId: T2.store, assignedUserId: null, handling: 'ai' }]);
    const raw = ctwa('AD_HYD', 'wa.b3', '919111100001', 'CLID_B3');
    const res = await conversations.ingestInbound({
      organisationId: T2.org, channel: 'whatsapp', externalThreadId: '919111100001',
      externalId: 'wa.b3', senderKind: 'whatsapp', senderValue: '919111100001',
      body: 'hi', payload: raw as never, adReferral: extractMetaReferral(raw),
    });
    const lead = await prisma.lead.findUnique({ where: { id: res.leadId! }, select: { partyId: true } });
    const otherParty = await prisma.party.findFirst({
      where: { organisationId: P.org }, select: { id: true }, orderBy: { createdAt: 'asc' },
    });
    expect(lead!.partyId).not.toBe(otherParty!.id);
  });

  /* ------------------------------------------------------------------ A */

  it('A: an open lead in ANOTHER store is not reused', async () => {
    // Same customer, an open Mumbai lead already exists.
    const party = await prisma.contactPoint.findFirst({
      where: { organisationId: P.org, valueNormalized: { contains: '9111100001' } },
      select: { partyId: true },
    });
    const seq = await prisma.lead.create({
      data: {
        organisationId: P.org, ref: `LD-P1-MUM-${Date.now()}`, storeId: P.mum,
        partyId: party!.partyId, customerName: 'Existing Mumbai', source: 'whatsapp', outcome: 'open',
      },
      select: { id: true },
    });

    // Now they click a HYDERABAD ad on a new thread.
    const raw = ctwa('AD_HYD', 'wa.a1', '919111100001', 'CLID_A1');
    const res = await conversations.ingestInbound({
      organisationId: P.org, channel: 'whatsapp', externalThreadId: 'thread-a1',
      externalId: 'wa.a1', senderKind: 'whatsapp', senderValue: '919111100001',
      body: 'hi', payload: raw as never, adReferral: extractMetaReferral(raw),
    });

    expect(res.leadId).toBeTruthy();
    // The defect: this used to return the Mumbai lead, so Hyderabad never saw
    // the enquiry and Mumbai absorbed the credit.
    expect(res.leadId).not.toBe(seq.id);
    const lead = await prisma.lead.findUnique({ where: { id: res.leadId! }, select: { storeId: true } });
    expect(lead!.storeId).toBe(P.hyd);
  });

  /* ------------------------------------------------------------------ C */

  it('C: a later ad for another store does NOT move the thread, and flags a review', async () => {
    const thread = 'thread-c1';
    const first = ctwa('AD_HYD', 'wa.c1', '919111100002', 'CLID_C1');
    const r1 = await conversations.ingestInbound({
      organisationId: P.org, channel: 'whatsapp', externalThreadId: thread,
      externalId: 'wa.c1', senderKind: 'whatsapp', senderValue: '919111100002',
      body: 'first', payload: first as never, adReferral: extractMetaReferral(first),
    });
    const afterFirst = await prisma.conversation.findUnique({
      where: { id: r1.conversationId }, select: { storeId: true, matchedRuleId: true },
    });
    expect(afterFirst!.storeId).toBe(P.hyd);

    // Same person, same thread, later clicks a MUMBAI ad.
    const second = ctwa('AD_MUM', 'wa.c2', '919111100002', 'CLID_C2');
    await conversations.ingestInbound({
      organisationId: P.org, channel: 'whatsapp', externalThreadId: thread,
      externalId: 'wa.c2', senderKind: 'whatsapp', senderValue: '919111100002',
      body: 'second', payload: second as never, adReferral: extractMetaReferral(second),
    });

    const afterSecond = await prisma.conversation.findUnique({
      where: { id: r1.conversationId },
      select: { storeId: true, matchedRuleId: true, sourceAdId: true, routingReviewRequired: true },
    });
    // Stayed put — the defect was that this silently became Mumbai.
    expect(afterSecond!.storeId).toBe(P.hyd);
    expect(afterSecond!.matchedRuleId).toBe('r-hyd');
    expect(afterSecond!.sourceAdId).toBe('AD_HYD');
    // But the conflict is visible rather than swallowed.
    expect(afterSecond!.routingReviewRequired).toBe(true);

    // And the later ad is still preserved as its own touch.
    const touches = await prisma.attributionTouch.findMany({
      where: { organisationId: P.org, externalAdId: 'AD_MUM' }, select: { id: true },
    });
    expect(touches.length).toBeGreaterThan(0);
  });

  /* ------------------------------------------------------------------ D */

  it('D: replaying the same message creates no second touch', async () => {
    const raw = ctwa('AD_HYD', 'wa.d1', '919111100003', 'CLID_D1');
    await ingest(conversations, raw, 'AD_HYD', 'thread-d1');
    const after1 = await prisma.attributionTouch.count({ where: { organisationId: P.org, clickId: 'CLID_D1' } });
    await ingest(conversations, raw, 'AD_HYD', 'thread-d1');
    expect(await prisma.attributionTouch.count({ where: { organisationId: P.org, clickId: 'CLID_D1' } })).toBe(after1);
    expect(after1).toBe(1);
  });

  it('D: two DIFFERENT messages carrying the same click id still count once', async () => {
    const m1 = ctwa('AD_HYD', 'wa.d2a', '919111100004', 'CLID_SHARED');
    const m2 = ctwa('AD_HYD', 'wa.d2b', '919111100004', 'CLID_SHARED');
    await ingest(conversations, m1, 'AD_HYD', 'thread-d2');
    await ingest(conversations, m2, 'AD_HYD', 'thread-d2');
    // The defect: different provider message ids bypassed idempotency entirely.
    expect(await prisma.attributionTouch.count({
      where: { organisationId: P.org, clickId: 'CLID_SHARED' },
    })).toBe(1);
  });

  it('D: genuinely separate clicks by the same customer are NOT collapsed', async () => {
    const m1 = ctwa('AD_HYD', 'wa.d3a', '919111100005', 'CLID_ONE');
    const m2 = ctwa('AD_HYD', 'wa.d3b', '919111100005', 'CLID_TWO');
    await ingest(conversations, m1, 'AD_HYD', 'thread-d3');
    await ingest(conversations, m2, 'AD_HYD', 'thread-d3');
    const n = await prisma.attributionTouch.count({
      where: { organisationId: P.org, clickId: { in: ['CLID_ONE', 'CLID_TWO'] } },
    });
    expect(n).toBe(2);
  });

  it('D: the same click id in two tenants is two separate touches', async () => {
    const a = ctwa('AD_HYD', 'wa.d4a', '919111100006', 'CLID_CROSS');
    await ingest(conversations, a, 'AD_HYD', 'thread-d4');
    const b = ctwa('AD_HYD', 'wa.d4b', '919111100007', 'CLID_CROSS');
    await conversations.ingestInbound({
      organisationId: T2.org, channel: 'whatsapp', externalThreadId: 'thread-d4b',
      externalId: 'wa.d4b', senderKind: 'whatsapp', senderValue: '919111100007',
      body: 'hi', payload: b as never, adReferral: extractMetaReferral(b),
    });
    expect(await prisma.attributionTouch.count({ where: { organisationId: P.org, clickId: 'CLID_CROSS' } })).toBe(1);
    expect(await prisma.attributionTouch.count({ where: { organisationId: T2.org, clickId: 'CLID_CROSS' } })).toBe(1);
  });

  /* ------------------------------------------------------------------ E */

  it('E: a human-only conversation NEVER invokes the responder', async () => {
    await enableDrafting(prisma, P.org, true);
    const raw = ctwa('AD_HUMAN', 'wa.e1', '919111100010', 'CLID_E1');
    const res = await ingest(conversations, raw, 'AD_HUMAN', 'thread-e1');

    const decision = await gate.consider({
      organisationId: P.org, conversationId: res.conversationId,
      inboundText: 'hello', channel: 'whatsapp',
    });
    // The old test only checked a column. This checks the model was not called.
    expect(spy.calls).toHaveLength(0);
    expect(decision.invoked).toBe(false);
    expect(decision.outcome).toBe('human_only');
  });

  it('E: an unassigned conversation never auto-replies', async () => {
    const raw = ctwa('AD_UNKNOWN', 'wa.e2', '919111100011', 'CLID_E2');
    const res = await ingest(conversations, raw, 'AD_UNKNOWN', 'thread-e2');
    const decision = await gate.consider({
      organisationId: P.org, conversationId: res.conversationId,
      inboundText: 'hello', channel: 'whatsapp',
    });
    expect(spy.calls).toHaveLength(0);
    expect(decision.outcome).toBe('unassigned');
  });

  it('E: an AI route does not speak while the tenant switch is off', async () => {
    await enableDrafting(prisma, P.org, false);
    const raw = ctwa('AD_HYD', 'wa.e3', '919111100012', 'CLID_E3');
    const res = await ingest(conversations, raw, 'AD_HYD', 'thread-e3');
    const decision = await gate.consider({
      organisationId: P.org, conversationId: res.conversationId,
      inboundText: 'hello', channel: 'whatsapp',
    });
    expect(spy.calls).toHaveLength(0);
    expect(decision.outcome).toBe('tenant_disabled');
  });

  it('E: an AI route WITH the switch on invokes the responder and stores a DRAFT', async () => {
    await enableDrafting(prisma, P.org, true);
    const raw = ctwa('AD_HYD', 'wa.e4', '919111100013', 'CLID_E4');
    const res = await ingest(conversations, raw, 'AD_HYD', 'thread-e4');
    const decision = await gate.consider({
      organisationId: P.org, conversationId: res.conversationId,
      inboundText: 'do you have bangles?', channel: 'whatsapp',
    });
    expect(spy.calls).toContain(res.conversationId);
    expect(decision.outcome).toBe('replied_draft');

    const draft = await prisma.message.findFirst({
      where: { conversationId: res.conversationId, direction: 'outbound' },
      select: { status: true, authorType: true },
    });
    // Never reported as sent: nothing contacted WhatsApp.
    expect(draft!.status).toBe('draft');
    expect(draft!.authorType).toBe('ai');
  });

  it('E: with no provider configured it degrades to a visible human queue', async () => {
    await enableDrafting(prisma, P.org, true);
    spy.configured = false;
    const raw = ctwa('AD_HYD', 'wa.e5', '919111100014', 'CLID_E5');
    const res = await ingest(conversations, raw, 'AD_HYD', 'thread-e5');
    const decision = await gate.consider({
      organisationId: P.org, conversationId: res.conversationId,
      inboundText: 'hello', channel: 'whatsapp',
    });
    expect(spy.calls).toHaveLength(0);
    expect(decision.outcome).toBe('provider_unavailable');
    const convo = await prisma.conversation.findUnique({
      where: { id: res.conversationId }, select: { handling: true, handoffReason: true },
    });
    expect(convo!.handling).toBe('human');
    expect(convo!.handoffReason).toMatch(/no ai provider/i);
  });

  it('E: a provider failure hands off instead of going silent', async () => {
    await enableDrafting(prisma, P.org, true);
    spy.throwOnCall = true;
    const raw = ctwa('AD_HYD', 'wa.e6', '919111100015', 'CLID_E6');
    const res = await ingest(conversations, raw, 'AD_HYD', 'thread-e6');
    const decision = await gate.consider({
      organisationId: P.org, conversationId: res.conversationId,
      // A question that actually retrieves: since Phase 2C the gate will not
      // call a provider with no supporting material, so a bare greeting would
      // now hand off BEFORE the provider could fail — and this test is about
      // what happens when it does fail.
      inboundText: 'do you have bangles?', channel: 'whatsapp',
    });
    expect(spy.calls).toHaveLength(1);
    expect(decision.outcome).toBe('provider_failed');
    const convo = await prisma.conversation.findUnique({
      where: { id: res.conversationId }, select: { handling: true },
    });
    expect(convo!.handling).toBe('human');
  });
});

async function ingest(svc: ConversationsService, raw: any, _ad: string, thread?: string) {
  return svc.ingestInbound({
    organisationId: P.org, channel: 'whatsapp',
    externalThreadId: thread ?? raw.from,
    externalId: raw.id, senderKind: 'whatsapp', senderValue: raw.from,
    body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
  });
}

async function setRules(prisma: PrismaService, org: string, rules: unknown[]) {
  const o = await prisma.organisation.findUnique({ where: { id: org }, select: { settings: true } });
  await prisma.organisation.update({
    where: { id: org },
    data: { settings: { ...((o?.settings ?? {}) as object), crmAdSetRules: rules } as never },
  });
}

async function enableDrafting(prisma: PrismaService, org: string, on: boolean) {
  const o = await prisma.organisation.findUnique({ where: { id: org }, select: { settings: true } });
  await prisma.organisation.update({
    where: { id: org },
    data: { settings: { ...((o?.settings ?? {}) as object), crmAiDraftEnabled: on } as never },
  });
}

async function teardown(prisma: PrismaService) {
  for (const org of [P.org, T2.org]) {
    await prisma.aiDraftRecord.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.knowledgeChunk.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.knowledgeDocument.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: org } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: org } });
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
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
