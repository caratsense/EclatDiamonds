import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import { AI_RESPONDER, type AiReply, type AiReplyContext } from '../src/crm/ai-responder';
import { adIdFromLink } from '../src/crm/adset-rules.service';
import { CampaignBotService } from '../src/whatsapp-bot/campaign-bot.service';
import { extractMetaReferral } from '../src/integrations/meta-referral';

/**
 * Campaign-scripted conversations (client, 8 Oct).
 *
 *  1. Two campaigns, two different configured conversations: a customer
 *     arriving from ad A gets A's exact first reply and first question; one
 *     arriving from ad B gets B's. Never the button questionnaire.
 *  2. A pasted ad link is routing, not a text field: the ad id inside it
 *     becomes the exact match.
 *  3. The free-text turn goes to the assistant WITH the campaign's brief and
 *     history; a confident answer is sent as 'ai', a low-confidence one hands
 *     off, and "talk to a person" always hands off deterministically.
 *  4. A thread that is not campaign-scripted (routing-only rule, disabled
 *     rule, human handling) reports no script, so the existing bot behaviour
 *     is untouched.
 */
const PASSWORD = 'password123';
const A = {
  org: 'org_cbot',
  slug: 'cbot',
  store: 'store_cbot',
  ho: 'ho.cbot@cbot.local',
};
const PHONE = '919000770001';

const AD_RING = '120210000777001'; // "Solitaire ring" campaign
const AD_CHAIN = '120210000777002'; // "Gold chains" campaign
const AD_PLAIN = '120210000777003'; // routing-only rule, no script

function ctwa(adId: string, wamid: string, body = 'Saw your ad') {
  return {
    from: PHONE,
    id: wamid,
    timestamp: '1757240000',
    type: 'text',
    text: { body },
    referral: {
      source_url: 'https://fb.me/x',
      source_id: adId,
      source_type: 'ad',
      headline: 'ad',
      body: 'ad',
      media_type: 'image',
      ctwa_clid: `clid-${wamid}`,
    },
  };
}

/** A controllable stand-in for the model. */
class FakeResponder {
  readonly name = 'fake';
  configured = true;
  nextReply: AiReply | null = null;
  lastContext: AiReplyContext | null = null;
  isConfigured() {
    return this.configured;
  }
  async propose(context: AiReplyContext): Promise<AiReply | null> {
    this.lastContext = context;
    return this.nextReply;
  }
}

describe('Campaign-scripted bot conversations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: ConversationsService;
  let campaignBot: CampaignBotService;
  const fake = new FakeResponder();
  let token = '';
  let wamidSeq = 1;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  /** One ad-originated inbound through the real ingest pipeline. */
  async function arrive(adId: string, body?: string) {
    const wamid = `wamid.cbot-${wamidSeq++}`;
    const raw = ctwa(adId, wamid, body);
    const result = await conversations.ingestInbound({
      organisationId: A.org,
      channel: 'whatsapp',
      externalThreadId: PHONE,
      externalId: wamid,
      senderKind: 'whatsapp',
      senderValue: PHONE,
      body: raw.text.body,
      payload: raw as never,
      adReferral: extractMetaReferral(raw),
    });
    return result.conversationId;
  }

  /** Wipe the thread between scenarios so each arrival is a first contact. */
  async function resetThread() {
    await prisma.message.deleteMany({ where: { organisationId: A.org } });
    await prisma.attributionTouch.deleteMany({ where: { organisationId: A.org } });
    await prisma.conversationRoutingConflict.deleteMany({
      where: { conversation: { organisationId: A.org } },
    });
    await prisma.lead.deleteMany({ where: { organisationId: A.org } });
    await prisma.conversation.deleteMany({ where: { organisationId: A.org } });
    await prisma.whatsAppSession.deleteMany({ where: { phoneE164: PHONE } });
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_RESPONDER)
      .useValue(fake)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    conversations = app.get(ConversationsService);
    campaignBot = app.get(CampaignBotService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Campaign Bot Jewels', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: A.store, name: 'Main', city: 'Mumbai', organisationId: A.org },
    });
    await prisma.user.create({
      data: {
        email: A.ho,
        name: 'HO',
        role: 'head_office',
        passwordHash: hash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: A.org,
        userStores: { create: { storeId: A.store, isPrimary: true } },
      },
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: A.ho, password: PASSWORD });
    token = login.body.token;

    // Three campaigns: two scripted (one configured via a pasted ad LINK with
    // no typed match value), one routing-only.
    await request(app.getHttpServer())
      .post('/crm/qualification/adset-rules')
      .set(auth())
      .send({
        rules: [
          {
            id: 'camp-ring',
            name: 'Solitaire ring — Know the price',
            enabled: true,
            priority: 100,
            matchField: 'ad_id',
            matchValue: AD_RING,
            storeId: A.store,
            assignedUserId: null,
            handling: 'ai',
            firstReply:
              'Hi! The solitaire ring from our ad starts at ₹85,000 for 0.5 carat (IGI certified).',
            questions: ['Which carat size are you considering?', 'When would you like to visit?'],
            aiContext:
              'Campaign: Solitaire ring. Pricing: 0.5ct ₹85,000; 0.7ct ₹1,30,000; 1ct ₹2,40,000. All IGI certified, 14-day exchange. Store: Main, Mumbai.',
            aiGuardrails: 'No discounts beyond the listed prices.',
          },
          {
            id: 'camp-chain',
            name: 'Gold chains festive',
            enabled: true,
            priority: 100,
            matchField: 'tag', // deliberately wrong-but-valid; the LINK must repair it
            matchValue: '',
            adLink: `https://www.facebook.com/ads/library/?id=${AD_CHAIN}&active_status=all`,
            storeId: A.store,
            assignedUserId: null,
            handling: 'ai',
            firstReply: 'Namaste! Our festive gold chain collection starts at ₹42,000. May I know what occasion you are shopping for?',
            questions: ['What occasion are you shopping for?'],
            aiContext: 'Campaign: Gold chains. 22k chains from ₹42,000, festive 5% making-charge offer till Diwali.',
          },
          {
            id: 'plain-route',
            name: 'Plain routing, no script',
            enabled: true,
            priority: 100,
            matchField: 'ad_id',
            matchValue: AD_PLAIN,
            storeId: A.store,
            assignedUserId: null,
            handling: 'ai',
          },
        ],
      })
      .expect(201);
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  beforeEach(async () => {
    fake.configured = true;
    fake.nextReply = null;
    fake.lastContext = null;
    await resetThread();
  });

  /* ------------------------------------------------------- the link parser */

  it('finds the ad id in the shapes Meta links come in, and refuses short numbers', () => {
    expect(adIdFromLink(`https://www.facebook.com/ads/library/?id=${AD_RING}`)).toBe(AD_RING);
    expect(
      adIdFromLink(`https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=${AD_CHAIN}&act=1`),
    ).toBe(AD_CHAIN);
    expect(adIdFromLink('https://fb.me/short?id=2026')).toBeNull();
    expect(adIdFromLink('')).toBeNull();
  });

  it('a pasted link became the exact ad_id match on save', async () => {
    const res = await request(app.getHttpServer())
      .get('/crm/qualification/adset-rules')
      .set(auth())
      .expect(200);
    const chain = res.body.find((r: { id: string }) => r.id === 'camp-chain');
    expect(chain.matchField).toBe('ad_id');
    expect(chain.matchValue).toBe(AD_CHAIN);
    expect(chain.adLink).toContain(AD_CHAIN);
  });

  /* ------------------------------------- two campaigns, two conversations */

  it('an arrival from campaign A gets exactly A\'s configured opener and question', async () => {
    const conversationId = await arrive(AD_RING);
    const rule = await campaignBot.scriptFor(A.org, conversationId);
    expect(rule?.id).toBe('camp-ring');

    const turn = await campaignBot.handle(A.org, conversationId, rule!, 'Saw your ad');
    expect(turn.authorType).toBe('bot');
    expect(turn.handoff).toBeUndefined();
    expect(turn.text).toBe(
      'Hi! The solitaire ring from our ad starts at ₹85,000 for 0.5 carat (IGI certified).\n\nWhich carat size are you considering?',
    );
    // Nothing menu-shaped about it.
    expect(turn.text).not.toMatch(/\b1\)\s|\b2\)\s|choose one/i);
  });

  it('an arrival from campaign B gets B\'s opener, un-doubled because it already asks', async () => {
    const conversationId = await arrive(AD_CHAIN);
    const rule = await campaignBot.scriptFor(A.org, conversationId);
    expect(rule?.id).toBe('camp-chain');

    const turn = await campaignBot.handle(A.org, conversationId, rule!, 'hi');
    // The opener ends with a question of its own, so the configured question
    // is not stapled on after it.
    expect(turn.text).toBe(
      'Namaste! Our festive gold chain collection starts at ₹42,000. May I know what occasion you are shopping for?',
    );
  });

  /* --------------------------------------------------- the free-text turn */

  it('a follow-up goes to the assistant with the campaign brief and is sent as ai', async () => {
    const conversationId = await arrive(AD_RING);
    const rule = await campaignBot.scriptFor(A.org, conversationId);
    // The opener has gone out (recorded as a message), so this is turn two.
    await prisma.message.create({
      data: {
        organisationId: A.org,
        conversationId,
        direction: 'outbound',
        authorType: 'bot',
        body: 'opener',
      },
    });

    fake.nextReply = {
      text: 'The 1 carat solitaire is ₹2,40,000, IGI certified.',
      confidence: 0.9,
      provider: 'fake',
      model: 'fake',
    };
    const turn = await campaignBot.handle(A.org, conversationId, rule!, 'how much is the 1 carat?');
    expect(turn.authorType).toBe('ai');
    expect(turn.text).toBe('The 1 carat solitaire is ₹2,40,000, IGI certified.');
    expect(turn.handoff).toBeUndefined();

    // The model saw the campaign, its brief, its guardrails and the history.
    expect(fake.lastContext?.campaign?.name).toBe('Solitaire ring — Know the price');
    expect(fake.lastContext?.campaign?.brief).toContain('1ct ₹2,40,000');
    expect(fake.lastContext?.campaign?.guardrails).toContain('No discounts');
    expect(fake.lastContext?.campaign?.questions).toEqual([
      'Which carat size are you considering?',
      'When would you like to visit?',
    ]);
    expect(fake.lastContext?.historyText).toContain('Customer: Saw your ad');
  });

  it('low confidence hands off instead of guessing, with the model\'s reason', async () => {
    const conversationId = await arrive(AD_RING);
    const rule = await campaignBot.scriptFor(A.org, conversationId);
    await prisma.message.create({
      data: { organisationId: A.org, conversationId, direction: 'outbound', authorType: 'bot', body: 'opener' },
    });

    fake.nextReply = { text: 'maybe?', confidence: 0.2, provider: 'fake', model: 'fake' };
    const turn = await campaignBot.handle(A.org, conversationId, rule!, 'do you buy back old gold from other shops?');
    expect(turn.handoff).toBeDefined();
    expect(turn.text).toContain('colleague');
  });

  it('"talk to a person" hands off deterministically, never via the model', async () => {
    const conversationId = await arrive(AD_RING);
    const rule = await campaignBot.scriptFor(A.org, conversationId);
    fake.nextReply = { text: 'should never be used', confidence: 0.99, provider: 'fake', model: 'fake' };
    const turn = await campaignBot.handle(A.org, conversationId, rule!, 'can I talk to a person please');
    expect(turn.handoff?.reason).toMatch(/asked to speak/i);
    expect(fake.lastContext).toBeNull();
  });

  it('an unconfigured assistant degrades to a person after the opener', async () => {
    const conversationId = await arrive(AD_RING);
    const rule = await campaignBot.scriptFor(A.org, conversationId);
    await prisma.message.create({
      data: { organisationId: A.org, conversationId, direction: 'outbound', authorType: 'bot', body: 'opener' },
    });
    fake.configured = false;
    const turn = await campaignBot.handle(A.org, conversationId, rule!, 'and in 18k?');
    expect(turn.handoff?.reason).toMatch(/not configured/i);
  });

  /* ------------------------------------------------ not-a-campaign threads */

  it('a routing-only rule has no script, so the existing bot path is untouched', async () => {
    const conversationId = await arrive(AD_PLAIN);
    expect(await campaignBot.scriptFor(A.org, conversationId)).toBeNull();
  });

  it('a human-handled thread never reports a script', async () => {
    const conversationId = await arrive(AD_RING);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { handling: 'human' },
    });
    expect(await campaignBot.scriptFor(A.org, conversationId)).toBeNull();
  });

  it('a disabled campaign stops scripting the moment it is switched off', async () => {
    const conversationId = await arrive(AD_RING);
    expect(await campaignBot.scriptFor(A.org, conversationId)).not.toBeNull();

    const res = await request(app.getHttpServer())
      .get('/crm/qualification/adset-rules')
      .set(auth())
      .expect(200);
    const rules = res.body.map((r: { id: string; enabled: boolean }) =>
      r.id === 'camp-ring' ? { ...r, enabled: false } : r,
    );
    await request(app.getHttpServer())
      .post('/crm/qualification/adset-rules')
      .set(auth())
      .send({ rules })
      .expect(201);

    expect(await campaignBot.scriptFor(A.org, conversationId)).toBeNull();

    // Switch it back for any later scenario.
    await request(app.getHttpServer())
      .post('/crm/qualification/adset-rules')
      .set(auth())
      .send({ rules: res.body })
      .expect(201);
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.message.deleteMany({ where: { organisationId: A.org } });
  await prisma.attributionTouch.deleteMany({ where: { organisationId: A.org } });
  await prisma.conversationRoutingConflict.deleteMany({
    where: { conversation: { organisationId: A.org } },
  });
  await prisma.lead.deleteMany({ where: { organisationId: A.org } });
  await prisma.conversation.deleteMany({ where: { organisationId: A.org } });
  await prisma.whatsAppSession.deleteMany({ where: { phoneE164: PHONE } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.party.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}
