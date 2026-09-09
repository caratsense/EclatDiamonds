import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationAiGate, AI_RESPONDER, type AiReply, type AiReplyContext, type AiResponder } from '../src/crm/ai-responder';
import { parseReply } from '../src/crm/ai/provider-ai-responder';
import { screenInbound, POLICY_VERSION, MIN_CONFIDENCE } from '../src/crm/ai/policy';

/**
 * Phase 2C — provider-backed drafting, and the rules that keep it safe.
 *
 * The properties under test are the ones that would matter at 2am:
 *
 *   - a conversation a person owns NEVER reaches a provider, whatever else is on;
 *   - a provider failure produces a visible human queue, not silence;
 *   - nothing is drafted from nothing;
 *   - a draft is a DRAFT — approving it is a human act and never claims delivery;
 *   - one tenant's drafts, and one tenant's knowledge, stay that tenant's.
 *
 * The responder is a SPY, so "was the model invoked?" is asserted directly
 * rather than inferred from a column that nothing reads.
 */
const PW = 'password123';

const O = {
  org: 'org_p2c', slug: 'p2c', store: 'store_p2c',
  ho: 'ho.p2c@p2c.local', rep: 'rep.p2c@p2c.local',
};
const X = { org: 'org_p2c_x', slug: 'p2c-x', store: 'store_p2c_x', ho: 'ho.x@p2cx.local' };

/** Records every invocation so the tests can assert called / not called. */
class SpyResponder implements AiResponder {
  calls: AiReplyContext[] = [];
  configured = true;
  next: AiReply | null | 'throw' = null;
  readonly name = 'spy/spy-1';
  isConfigured() { return this.configured; }
  async propose(ctx: AiReplyContext): Promise<AiReply | null> {
    this.calls.push(ctx);
    if (this.next === 'throw') throw new Error('provider exploded');
    return this.next;
  }
  reset() { this.calls = []; this.configured = true; this.next = null; }
  good(over: Partial<AiReply> = {}): AiReply {
    return {
      text: 'Our opening hours are 10am to 7pm, Monday to Saturday.',
      confidence: 0.92, provider: 'spy', model: 'spy-1', latencyMs: 42,
      policyVersion: POLICY_VERSION, ...over,
    };
  }
}

describe('CRM Phase 2C — AI drafting, screening and human review (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gate: ConversationAiGate;
  const spy = new SpyResponder();

  let hoToken: string;
  let repToken: string;
  let xToken: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      // The whole point of the AI_RESPONDER token: swap the provider for a spy.
      .overrideProvider(AI_RESPONDER).useValue(spy)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    gate = app.get(ConversationAiGate);

    await teardown(prisma);
    const hash = await bcrypt.hash(PW, 10);

    for (const t of [O, X]) {
      await prisma.organisation.create({ data: { id: t.org, name: t.slug, slug: t.slug } });
      await prisma.store.create({ data: { id: t.store, name: 'S', city: 'C', organisationId: t.org } });
    }
    await prisma.user.create({ data: {
      email: O.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
      approvalStatus: 'approved', organisationId: O.org,
      userStores: { create: { storeId: O.store, isPrimary: true } },
    }});
    await prisma.user.create({ data: {
      email: O.rep, name: 'Rep', role: 'salesperson', passwordHash: hash, isActive: true,
      approvalStatus: 'approved', organisationId: O.org,
      userStores: { create: { storeId: O.store, isPrimary: true } },
    }});
    await prisma.user.create({ data: {
      email: X.ho, name: 'X HO', role: 'head_office', passwordHash: hash, isActive: true,
      approvalStatus: 'approved', organisationId: X.org,
      userStores: { create: { storeId: X.store, isPrimary: true } },
    }});

    // Drafting on for both tenants; each gets its OWN knowledge.
    for (const t of [O, X]) {
      await prisma.organisation.update({
        where: { id: t.org },
        data: { settings: { crmAiDraftEnabled: true } as never },
      });
      await seedKnowledge(prisma, t.org, `${t.slug} opening hours are 10am to 7pm.`);
    }

    const login = async (email: string) =>
      (await http().post('/auth/login').send({ email, password: PW })).body.token as string;
    hoToken = await login(O.ho);
    repToken = await login(O.rep);
    xToken = await login(X.ho);
  });

  afterAll(async () => { await teardown(prisma); await app?.close(); });

  beforeEach(() => spy.reset());

  /* ================================================== the gate never calls */

  describe('when the provider must not be called at all', () => {
    it('a human-owned conversation NEVER reaches the provider', async () => {
      const c = await convo(prisma, O.org, O.store, 'human');
      spy.next = spy.good();
      const decision = await gate.consider(ctx(O.org, c.id));

      expect(decision.outcome).toBe('human_only');
      expect(decision.invoked).toBe(false);
      // The assertion that matters: the model was not consulted, at all.
      expect(spy.calls).toHaveLength(0);
      expect(await drafts(prisma, c.id)).toBe(0);
    });

    it('an unrouted conversation never reaches the provider', async () => {
      const c = await convo(prisma, O.org, O.store, 'unassigned');
      spy.next = spy.good();
      const decision = await gate.consider(ctx(O.org, c.id));
      expect(decision.outcome).toBe('unassigned');
      expect(spy.calls).toHaveLength(0);
    });

    it('a tenant that has not switched drafting on never reaches the provider', async () => {
      await prisma.organisation.update({
        where: { id: O.org }, data: { settings: { crmAiDraftEnabled: false } as never },
      });
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.next = spy.good();
      const decision = await gate.consider(ctx(O.org, c.id));
      expect(decision.outcome).toBe('tenant_disabled');
      expect(spy.calls).toHaveLength(0);
      await prisma.organisation.update({
        where: { id: O.org }, data: { settings: { crmAiDraftEnabled: true } as never },
      });
    });

    it('a complaint is screened out BEFORE the provider is paid', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.next = spy.good();
      const decision = await gate.consider(ctx(O.org, c.id, 'This is a scam, I want a refund immediately'));

      expect(decision.outcome).toBe('screened_out');
      // Not "we called and discarded the answer" — never called.
      expect(spy.calls).toHaveLength(0);
      const after = await prisma.conversation.findUnique({ where: { id: c.id } });
      expect(after!.handling).toBe('human');
      expect(after!.handoffReason).toMatch(/complaint/i);
    });

    it('an opt-out is screened out and handed to a person', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.next = spy.good();
      const decision = await gate.consider(ctx(O.org, c.id, 'STOP please remove me from your list'));
      expect(decision.outcome).toBe('screened_out');
      expect(spy.calls).toHaveLength(0);
      expect((await prisma.conversation.findUnique({ where: { id: c.id } }))!.handling).toBe('human');
    });

    it('nothing is drafted when there is no knowledge to answer from', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.next = spy.good();
      // A question whose words appear in no document.
      const decision = await gate.consider(ctx(O.org, c.id, 'zzzqqq unmatchable phrase'));

      expect(decision.outcome).toBe('no_knowledge');
      expect(spy.calls).toHaveLength(0);
      expect((await prisma.conversation.findUnique({ where: { id: c.id } }))!.handling).toBe('human');
      expect(await drafts(prisma, c.id)).toBe(0);
    });
  });

  /* =============================================== failure always visible */

  describe('when the provider fails', () => {
    it('an exception hands the thread to a person rather than going silent', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.next = 'throw';
      const decision = await gate.consider(ctx(O.org, c.id, 'what are your opening hours'));

      expect(decision.outcome).toBe('provider_failed');
      expect(spy.calls).toHaveLength(1);
      const after = await prisma.conversation.findUnique({ where: { id: c.id } });
      expect(after!.handling).toBe('human');
      expect(after!.handoffReason).toBeTruthy();
      // Crucially: no half-written draft was left behind.
      expect(await drafts(prisma, c.id)).toBe(0);
    });

    it('an unconfigured provider hands over instead of pretending', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.configured = false;
      const decision = await gate.consider(ctx(O.org, c.id, 'what are your opening hours'));
      expect(decision.outcome).toBe('provider_unavailable');
      expect(spy.calls).toHaveLength(0);
      expect((await prisma.conversation.findUnique({ where: { id: c.id } }))!.handling).toBe('human');
    });

    it('an under-confident answer is discarded, not shown', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.next = spy.good({ confidence: MIN_CONFIDENCE - 0.01 });
      const decision = await gate.consider(ctx(O.org, c.id, 'what are your opening hours'));
      expect(decision.outcome).toBe('low_confidence');
      expect(await drafts(prisma, c.id)).toBe(0);
    });

    it('a model asking for a person is obeyed even at high confidence', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      spy.next = spy.good({ confidence: 0.99, handoffReason: 'I am not sure about the price.' });
      const decision = await gate.consider(ctx(O.org, c.id, 'what are your opening hours'));
      expect(decision.outcome).toBe('low_confidence');
      expect(await drafts(prisma, c.id)).toBe(0);
    });
  });

  /* ================================================== a good draft, stored */

  describe('a successful draft', () => {
    let conversationId: string;
    let draftId: string;

    it('is stored as a draft with its full provenance — and nothing is sent', async () => {
      const c = await convo(prisma, O.org, O.store, 'ai');
      conversationId = c.id;
      spy.next = spy.good();
      const decision = await gate.consider(ctx(O.org, c.id, 'what are your opening hours'));
      expect(decision.outcome).toBe('replied_draft');

      const msg = await prisma.message.findFirst({ where: { conversationId: c.id } });
      expect(msg!.status).toBe('draft');       // never 'sent'
      expect(msg!.authorType).toBe('ai');
      expect(msg!.direction).toBe('outbound');

      const rec = await prisma.aiDraftRecord.findUnique({ where: { messageId: msg!.id } });
      expect(rec).toBeTruthy();
      draftId = rec!.id;
      expect(rec!.provider).toBe('spy');
      expect(rec!.model).toBe('spy-1');
      expect(Number(rec!.confidence)).toBeCloseTo(0.92, 3);
      expect(rec!.latencyMs).toBe(42);
      expect(rec!.policyVersion).toBe(POLICY_VERSION);
      expect(rec!.review).toBe('pending');
      // The evidence: which documents it was written from.
      expect(rec!.knowledgeDocumentIds.length).toBeGreaterThan(0);

      // TENANT ISOLATION, asserted in the test that made the call — the spy is
      // reset between tests, so reading spy.calls from a later one proves
      // nothing about what this draft was given.
      const call = spy.calls[0];
      expect(call.knowledgeText).toContain('p2c opening hours');
      // Tenant X's document says "p2c-x ..." — it must not be in this prompt.
      expect(call.knowledgeText).not.toContain('p2c-x opening hours');
      expect(call.businessName).toBe(O.slug);
    });

    it('is listed for review with its sources named', async () => {
      const res = await http().get('/crm/ai/drafts').query({ conversationId }).set(auth(hoToken));
      expect(res.status).toBe(200);
      const row = res.body.find((d: { id: string }) => d.id === draftId);
      expect(row).toBeTruthy();
      expect(row.review).toBe('pending');
      expect(row.sources.length).toBeGreaterThan(0);
      expect(row.sources[0].title).toBeTruthy();
      expect(row.sources[0].deleted).toBe(false);
    });

    it('another tenant can neither see it nor act on it', async () => {
      const list = await http().get('/crm/ai/drafts').set(auth(xToken));
      expect(list.status).toBe(200);
      expect(list.body.map((d: { id: string }) => d.id)).not.toContain(draftId);

      const approve = await http().post(`/crm/ai/drafts/${draftId}/approve`).set(auth(xToken)).send({});
      expect(approve.status).toBe(404);
      // And it is still pending — a cross-tenant call changed nothing.
      expect((await prisma.aiDraftRecord.findUnique({ where: { id: draftId } }))!.review).toBe('pending');
    });

    it('approving queues it — it is never reported as sent', async () => {
      const res = await http().post(`/crm/ai/drafts/${draftId}/approve`).set(auth(repToken)).send({});
      expect(res.status).toBe(201);
      expect(res.body.decision).toBe('approved');
      expect(res.body.delivery.state).toBe('queued');
      expect(res.body.delivery.note).toMatch(/will not reach the customer/i);

      const rec = await prisma.aiDraftRecord.findUnique({ where: { id: draftId } });
      expect(rec!.review).toBe('approved');
      expect(rec!.reviewedById).toBeTruthy();   // attributed to a person
      expect(rec!.reviewedAt).toBeInstanceOf(Date);

      const msg = await prisma.message.findUnique({ where: { id: rec!.messageId } });
      // The distinction the whole layer rests on.
      expect(msg!.status).toBe('queued');
      expect(msg!.status).not.toBe('sent');
      expect(msg!.authorType).toBe('ai');       // still attributable to the model
    });

    it('cannot be reviewed twice', async () => {
      const again = await http().post(`/crm/ai/drafts/${draftId}/reject`).set(auth(hoToken)).send({});
      expect(again.status).toBe(400);
      expect((await prisma.aiDraftRecord.findUnique({ where: { id: draftId } }))!.review).toBe('approved');
    });
  });

  describe('editing and rejecting', () => {
    it('an edited approval is recorded as edited, not approved', async () => {
      const { draftId, messageId } = await freshDraft();
      const res = await http().post(`/crm/ai/drafts/${draftId}/approve`)
        .set(auth(hoToken)).send({ body: 'Rewritten by a person.', note: 'tone' });
      expect(res.status).toBe(201);
      expect(res.body.decision).toBe('edited');

      const rec = await prisma.aiDraftRecord.findUnique({ where: { id: draftId } });
      expect(rec!.review).toBe('edited');
      expect(rec!.reviewNote).toBe('tone');
      const msg = await prisma.message.findUnique({ where: { id: messageId } });
      expect(msg!.body).toBe('Rewritten by a person.');
      expect(msg!.status).toBe('queued');
    });

    it('a rejected draft is rejected — NOT failed — and its text is kept', async () => {
      const { draftId, messageId } = await freshDraft();
      const before = await prisma.message.findUnique({ where: { id: messageId } });

      const res = await http().post(`/crm/ai/drafts/${draftId}/reject`)
        .set(auth(hoToken)).send({ note: 'wrong answer' });
      expect(res.status).toBe(201);

      const msg = await prisma.message.findUnique({ where: { id: messageId } });
      // 'failed' means the network refused it. A person declining is a different
      // fact, and merging them would corrupt every delivery-failure metric.
      expect(msg!.status).toBe('rejected');
      expect(msg!.status).not.toBe('failed');
      expect(msg!.body).toBe(before!.body);   // what was proposed is still readable
      expect((await prisma.aiDraftRecord.findUnique({ where: { id: draftId } }))!.review).toBe('rejected');
    });

    it('two reviewers deciding at once produce exactly one decision', async () => {
      const { draftId } = await freshDraft();
      const fire = () => http().post(`/crm/ai/drafts/${draftId}/approve`).set(auth(hoToken)).send({});
      const [a, b] = await Promise.all([fire(), fire()]);
      expect([a.status, b.status].sort()).toEqual([201, 400]);
      expect((await prisma.aiDraftRecord.findUnique({ where: { id: draftId } }))!.review).toBe('approved');
    });
  });

  /* ===================================================== pure-unit safety */

  describe('screening and parsing', () => {
    it('screens complaints, opt-outs and legal threats but not ordinary questions', () => {
      expect(screenInbound('I want a refund').blocked).toBe(true);
      expect(screenInbound('my lawyer will call you').kind).toBe('legal_or_safety');
      expect(screenInbound('STOP').kind).toBe('opt_out');
      expect(screenInbound('Do you have this in stock?').blocked).toBe(false);
      expect(screenInbound('').blocked).toBe(true);
    });

    it('does not fire on words that merely contain a trigger', () => {
      // "issue" contains "sue"; "shop stops at 7" contains "stop". Word
      // boundaries are what keep the screen from sending every message to a human.
      expect(screenInbound('I have an issue with the size').kind).not.toBe('legal_or_safety');
      expect(screenInbound('Where is the nearest bus stop?').kind).not.toBe('opt_out');
    });

    it('rejects malformed provider output instead of coercing it', () => {
      expect(parseReply('')).toBeNull();
      expect(parseReply('I think you should visit us!')).toBeNull();
      expect(parseReply('{"reply": 42}')).toBeNull();
      expect(parseReply('{"reply":"hi","confidence":"high"}')).toEqual(
        expect.objectContaining({ reply: 'hi', confidence: 0 }),   // not "probably fine"
      );
    });

    it('accepts the contract, fenced or bare, and clamps confidence', () => {
      expect(parseReply('```json\n{"reply":"hi","confidence":0.8}\n```')).toEqual(
        expect.objectContaining({ reply: 'hi', confidence: 0.8, needsHuman: false }),
      );
      expect(parseReply('{"reply":"hi","confidence":5}')!.confidence).toBe(1);
      expect(parseReply('{"reply":"","needsHuman":true,"handoffReason":"unsure"}')).toEqual(
        expect.objectContaining({ needsHuman: true, handoffReason: 'unsure' }),
      );
    });
  });

  /* ----------------------------------------------------------- helpers */

  async function freshDraft() {
    const c = await convo(prisma, O.org, O.store, 'ai');
    spy.reset();
    spy.next = spy.good();
    const d = await gate.consider(ctx(O.org, c.id, 'what are your opening hours'));
    expect(d.outcome).toBe('replied_draft');
    const msg = await prisma.message.findFirst({ where: { conversationId: c.id } });
    const rec = await prisma.aiDraftRecord.findUnique({ where: { messageId: msg!.id } });
    return { draftId: rec!.id, messageId: msg!.id, conversationId: c.id };
  }
});

/* ------------------------------------------------------------- fixtures */

let seq = 0;
async function convo(prisma: PrismaService, org: string, store: string, handling: string) {
  seq += 1;
  return prisma.conversation.create({
    data: {
      organisationId: org, channel: 'whatsapp', externalThreadId: `p2c-${seq}`,
      storeId: store, handling, status: 'open', lastMessageAt: new Date(),
    },
  });
}

const ctx = (org: string, conversationId: string, inboundText = 'what are your opening hours'): AiReplyContext => ({
  organisationId: org, conversationId, inboundText, channel: 'whatsapp',
});

const drafts = (prisma: PrismaService, conversationId: string) =>
  prisma.message.count({ where: { conversationId, status: 'draft' } });

/** A document + one searchable chunk, written directly (upload needs a file). */
async function seedKnowledge(prisma: PrismaService, org: string, text: string) {
  const doc = await prisma.knowledgeDocument.create({
    data: {
      organisationId: org, title: `${org} handbook`, originalFileName: 'handbook.txt',
      mimeType: 'text/plain', sizeBytes: text.length, sha256: `sha-${org}`,
      storageKey: `k/${org}/handbook.txt`, status: 'ready',
    },
  });
  await prisma.knowledgeChunk.create({
    data: {
      organisationId: org, documentId: doc.id, chunkIndex: 0, content: text,
      charStart: 0, charEnd: text.length,
    },
  });
}

async function teardown(prisma: PrismaService) {
  for (const org of [O.org, X.org]) {
    await prisma.aiDraftRecord.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.jobTask.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.leadQualification.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
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
