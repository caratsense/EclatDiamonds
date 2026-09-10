import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import {
  AI_RESPONDER,
  ConversationAiGate,
  type AiReply,
  type AiReplyContext,
  type AiResponder,
} from '../src/crm/ai-responder';
import {
  AUTO_SEND_MIN_CONFIDENCE,
  POLICY_VERSION,
  screenForAutoSend,
} from '../src/crm/ai/policy';

/**
 * Unattended replies, and every gate that stands in front of one.
 *
 * The product default is a draft a person approves. This suite exists because
 * the moment that default can be switched off, the switch itself becomes the
 * most safety-critical thing in the CRM: everything downstream of it reaches a
 * real customer with nobody reading it first.
 *
 * So most of what follows asserts that a reply was NOT sent. A test suite for an
 * autonomous feature that only proves it works is not a test suite for an
 * autonomous feature.
 */
const PASSWORD = 'password123';

const A = {
  org: 'org_auto_a', slug: 'auto-a', store: 'store_auto_a',
  ho: 'ho.auto@auto-a.local',
};

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
  confident(over: Partial<AiReply> = {}): AiReply {
    return {
      text: 'We are open from 10am to 7pm, Monday to Saturday.',
      confidence: 0.95, provider: 'spy', model: 'spy-1', latencyMs: 30,
      policyVersion: POLICY_VERSION, ...over,
    };
  }
}

describe('AI auto-reply: the switch, and everything that overrides it (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let gate: ConversationAiGate;
  const spy = new SpyResponder();

  let token: string;
  let partyId: string;
  let threadSeq = 0;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  /** A fresh routed, AI-handled thread with a known, consenting customer. */
  async function freshThread(inbound: string): Promise<string> {
    threadSeq += 1;
    const number = `91900000${String(8000 + threadSeq)}`;
    const result = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: number, externalId: `wamid.auto.${threadSeq}`,
      senderKind: 'whatsapp', senderValue: number,
      body: inbound,
    });
    // Attach the customer and route it, which is what a real ad click or a
    // human triage would have done.
    await prisma.conversation.update({
      where: { id: result.conversationId },
      data: { partyId, storeId: A.store, handling: 'ai' },
    });
    return result.conversationId;
  }

  const consider = (conversationId: string, inboundText: string) =>
    gate.consider({ organisationId: A.org, conversationId, inboundText, channel: 'whatsapp' });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_RESPONDER).useValue(spy)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);
    gate = app.get(ConversationAiGate);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({ data: { id: A.org, name: 'Auto A', slug: A.slug } });
    await prisma.store.create({ data: { id: A.store, name: 'Main', city: 'Pune', organisationId: A.org } });
    await prisma.user.create({
      data: {
        email: A.ho, name: 'HO', role: 'head_office', passwordHash: hash, isActive: true,
        approvalStatus: 'approved', organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    const party = await prisma.party.create({
      data: {
        organisationId: A.org, name: 'Known Customer', phone: '+919812340001',
        whatsapp: '+919812340001', storeId: A.store, types: ['customer'],
      },
      select: { id: true },
    });
    partyId = party.id;

    const login = await http().post('/auth/login').send({ email: A.ho, password: PASSWORD });
    token = login.body.token;

    // Knowledge to answer from, so `no_knowledge` is not what stops the tests.
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organisationId: A.org, title: 'Opening hours',
        originalFileName: 'hours.txt', mimeType: 'text/plain',
        sizeBytes: 80, storageKey: 'test/hours.txt', status: 'ready',
        sha256: 'a'.repeat(64),
      },
      select: { id: true },
    });
    await prisma.knowledgeChunk.create({
      data: {
        organisationId: A.org, documentId: doc.id, chunkIndex: 0,
        content:
          'Our opening hours are 10am to 7pm Monday to Saturday, closed Sunday. ' +
          'Prices are shown on each item. We do not offer a discount without a manager. ' +
          'Payment is accepted by card, cash and UPI.',
        charStart: 0, charEnd: 200,
      },
    });

    // The customer agreed to be contacted on this channel.
    await http().post('/omnichannel/consents').set(auth()).send({
      partyId, channel: 'whatsapp', purpose: 'service', status: 'granted', source: 'inbound_message',
    }).expect(201);

    // Drafting on, auto-send OFF: the product default.
    await http().post('/crm/qualification/ai-settings').set(auth())
      .send({ qualificationEnabled: false, draftEnabled: true, autoSendEnabled: false });
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  beforeEach(() => spy.reset());

  /* ------------------------------------------------------------- the default */

  describe('with auto-reply switched off (the default)', () => {
    it('drafts, and says which gate stopped the send', async () => {
      spy.next = spy.confident();
      const convo = await freshThread('What time do you open on Saturday?');
      const decision = await consider(convo, 'What time do you open on Saturday?');

      expect(decision.outcome).toBe('replied_draft');
      expect(decision.autoSendBlockedBy).toMatch(/switched off/i);

      const messages = await prisma.message.findMany({
        where: { conversationId: convo, direction: 'outbound' },
        select: { status: true, payload: true },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].status).toBe('draft');
      // No delivery instruction means the job runner will never pick it up.
      expect(messages[0].payload).toBeNull();
    });
  });

  /* ------------------------------------------------------------ switched on */

  describe('with auto-reply switched on', () => {
    beforeAll(async () => {
      await http().post('/crm/qualification/ai-settings').set(auth())
        .send({ qualificationEnabled: false, draftEnabled: true, autoSendEnabled: true });
    });

    it('sends, and promotes the SAME draft rather than composing a second', async () => {
      spy.next = spy.confident();
      const convo = await freshThread('What time do you open on Saturday?');
      const decision = await consider(convo, 'What time do you open on Saturday?');

      expect(decision.outcome).toBe('auto_sent');

      const messages = await prisma.message.findMany({
        where: { conversationId: convo, direction: 'outbound' },
        select: { id: true, status: true, authorType: true, payload: true },
      });
      // One outbound row. Two would read to the customer as being answered twice.
      expect(messages).toHaveLength(1);
      expect(messages[0].status).toBe('queued');
      expect(messages[0].authorType).toBe('ai');
      // The delivery marker the job runner actually looks for.
      expect((messages[0].payload as Record<string, unknown>).omnichannel).toBeTruthy();
    });

    it('leaves the thread on AI so the next message is not silently orphaned', async () => {
      spy.next = spy.confident();
      const convo = await freshThread('Are you open on Saturday please?');
      await consider(convo, 'Are you open on Saturday please?');

      const after = await prisma.conversation.findUnique({
        where: { id: convo }, select: { handling: true },
      });
      // The human queue path sets handling:'human'. If auto-reply did that it
      // would fire exactly once per conversation and then go quiet forever.
      expect(after!.handling).toBe('ai');
    });

    it('holds back a reply it is not confident enough about', async () => {
      spy.next = spy.confident({ confidence: 0.6 });
      const convo = await freshThread('What are your Saturday opening hours?');
      const decision = await consider(convo, 'What are your Saturday opening hours?');

      expect(decision.outcome).toBe('replied_draft');
      expect(decision.autoSendBlockedBy).toContain(String(AUTO_SEND_MIN_CONFIDENCE));

      const msg = await prisma.message.findFirst({
        where: { conversationId: convo, direction: 'outbound' }, select: { status: true },
      });
      expect(msg!.status).toBe('draft');
    });

    it('holds back a negotiation even at high confidence', async () => {
      spy.next = spy.confident();
      const text = 'Can you give me a discount on this if I buy today?';
      const convo = await freshThread(text);
      const decision = await consider(convo, text);

      expect(decision.outcome).toBe('replied_draft');
      expect(decision.autoSendBlockedBy).toMatch(/price, payment or holding stock/i);
    });

    /*
     * Asserted directly rather than through the gate, because a two-character
     * message retrieves no knowledge and is handed to a person one step earlier
     * for that reason instead. The rule is still worth having and worth pinning:
     * it is what catches a short message that DOES happen to match a document.
     */
    it('holds back a message too short to be sure what was asked', () => {
      expect(screenForAutoSend('ok').blocked).toBe(true);
      expect(screenForAutoSend('ok').reason).toMatch(/too short/i);
      expect(screenForAutoSend('?').blocked).toBe(true);
    });

    it('never sends once consent is withdrawn', async () => {
      await http().post('/omnichannel/consents').set(auth()).send({
        partyId, channel: 'whatsapp', purpose: 'service', status: 'revoked', source: 'inbound_message',
      }).expect(201);

      spy.next = spy.confident();
      const convo = await freshThread('What time do you open on Saturday?');
      const decision = await consider(convo, 'What time do you open on Saturday?');

      expect(decision.outcome).toBe('replied_draft');
      const msg = await prisma.message.findFirst({
        where: { conversationId: convo, direction: 'outbound' }, select: { status: true },
      });
      expect(msg!.status).toBe('draft');

      // Put it back for the remaining tests.
      await http().post('/omnichannel/consents').set(auth()).send({
        partyId, channel: 'whatsapp', purpose: 'service', status: 'granted', source: 'inbound_message',
      }).expect(201);
    });

    it('obeys the kill switch immediately, not from the next message', async () => {
      spy.next = spy.confident();
      const convo = await freshThread('What time do you open on Saturday?');

      // Flip it off after the thread exists but before the gate runs, which is
      // what a manager pressing the switch mid-conversation actually looks like.
      await http().post('/crm/qualification/ai-settings').set(auth())
        .send({ qualificationEnabled: false, draftEnabled: true, autoSendEnabled: false });

      const decision = await consider(convo, 'What time do you open on Saturday?');
      expect(decision.outcome).toBe('replied_draft');

      await http().post('/crm/qualification/ai-settings').set(auth())
        .send({ qualificationEnabled: false, draftEnabled: true, autoSendEnabled: true });
    });

    it('stops sending once the daily cap is reached', async () => {
      await prisma.organisation.update({
        where: { id: A.org },
        data: {
          settings: {
            ...(await currentSettings(prisma)),
            crmAiAutoSendDailyLimit: 1,
            crmAiAutoSendState: { date: new Date().toISOString().slice(0, 10), count: 1, consecutiveFailures: 0 },
          },
        },
      });

      spy.next = spy.confident();
      const convo = await freshThread('What time do you open on Saturday?');
      const decision = await consider(convo, 'What time do you open on Saturday?');

      expect(decision.outcome).toBe('replied_draft');
      expect(decision.autoSendBlockedBy).toMatch(/automatic replies for today/i);

      await prisma.organisation.update({
        where: { id: A.org },
        data: {
          settings: {
            ...(await currentSettings(prisma)),
            crmAiAutoSendDailyLimit: 200,
            crmAiAutoSendState: { date: new Date().toISOString().slice(0, 10), count: 0, consecutiveFailures: 0 },
          },
        },
      });
    });

    it('pauses itself after repeated failures', async () => {
      await prisma.organisation.update({
        where: { id: A.org },
        data: {
          settings: {
            ...(await currentSettings(prisma)),
            crmAiAutoSendState: {
              date: new Date().toISOString().slice(0, 10),
              count: 0, consecutiveFailures: 5, openedAt: new Date().toISOString(),
            },
          },
        },
      });

      spy.next = spy.confident();
      const convo = await freshThread('What time do you open on Saturday?');
      const decision = await consider(convo, 'What time do you open on Saturday?');

      expect(decision.outcome).toBe('replied_draft');
      expect(decision.autoSendBlockedBy).toMatch(/paused after/i);

      await prisma.organisation.update({
        where: { id: A.org },
        data: {
          settings: {
            ...(await currentSettings(prisma)),
            crmAiAutoSendState: { date: new Date().toISOString().slice(0, 10), count: 0, consecutiveFailures: 0 },
          },
        },
      });
    });
  });

  /* ------------------------------- the categories a provider never even sees */

  describe('screening, which happens before the provider is called', () => {
    const neverReaches = [
      ['a threat', 'I will find you if this is not sorted out'],
      ['self-harm', 'if this is not fixed I will end my life'],
      ['a card number', 'my card is 4111 1111 1111 1111 please charge it'],
      ['a clinical question', 'what dosage should I take for this?'],
      ['side effects', 'does it have any side effects I should know about?'],
    ] as const;

    for (const [label, text] of neverReaches) {
      it(`hands ${label} to a person without paying a provider`, async () => {
        spy.next = spy.confident();
        const convo = await freshThread(text);
        const decision = await consider(convo, text);

        expect(decision.outcome).toBe('screened_out');
        // The customer's words were never sent to a third party.
        expect(spy.calls).toHaveLength(0);

        const after = await prisma.conversation.findUnique({
          where: { id: convo }, select: { handling: true },
        });
        expect(after!.handling).toBe('human');
      });
    }

    it('still lets an ordinary question through', () => {
      expect(screenForAutoSend('What time do you open on Saturday?').blocked).toBe(false);
      // "What does it cost" is an ordinary question a knowledge base answers.
      // Screening it would gut the product for every retail tenant.
      expect(screenForAutoSend('How much does the small one cost?').blocked).toBe(false);
    });
  });
});

async function currentSettings(prisma: PrismaService): Promise<Record<string, unknown>> {
  const org = await prisma.organisation.findUnique({
    where: { id: A.org }, select: { settings: true },
  });
  return (org?.settings ?? {}) as Record<string, unknown>;
}

async function teardown(prisma: PrismaService) {
  const org = A.org;
  await prisma.aiDraftRecord.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.jobTask.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.message.deleteMany({ where: { organisationId: org } });
  await prisma.conversation.deleteMany({ where: { organisationId: org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.knowledgeChunk.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.knowledgeDocument.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
  await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
  await prisma.party.deleteMany({ where: { organisationId: org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } });
  await prisma.user.deleteMany({ where: { organisationId: org } });
  await prisma.store.deleteMany({ where: { organisationId: org } });
  await prisma.organisation.deleteMany({ where: { id: org } });
}
