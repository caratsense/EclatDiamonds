import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WhatsAppBotService } from '../src/whatsapp-bot/whatsapp-bot.service';
import { MetaAdMetadataService } from '../src/integrations/meta-ad-metadata.service';

/**
 * Three cities, three campaigns, one WhatsApp number — who gets the lead.
 *
 * This is the question the client actually asked: if Éclat runs a separate ad
 * campaign per showroom, does the Bandra lead reach the Bandra manager, does it
 * stay out of Udaipur's inbox, is the right person TOLD, and can an admin later
 * see which manager answered which customer.
 *
 * Each of those is a separate failure with the same symptom — "the lead went to
 * the wrong person" — so they are asserted separately:
 *
 *   1. routing      the ad id decides the branch
 *   2. handoff      the branch decides the owner
 *   3. notification the owner, and only the owner, is told
 *   4. visibility   no other branch can read it, by list or by id
 *   5. attribution  a reply is recorded against the person who typed it
 *
 * FIXTURE, NOT LIVE META — like `ctwa-routing.e2e-spec.ts`. The envelopes below
 * are the documented webhook shape with invented ids, driven straight into
 * `WhatsAppBotService.ingest`. This proves the routing, ownership, notification
 * and visibility logic. It does NOT prove Meta delivers this: that needs a real
 * ad, a reviewed app and `WHATSAPP_APP_SECRET` set on the deployment.
 */
const PASSWORD = 'password123';

const ORG = 'org_mloc';
const INTEGRATION = 'int_mloc_whatsapp';
/** The single business number every campaign points at. */
const BUSINESS_NUMBER_ID = '770000000001';

/** One branch per live campaign, named as the client names them. */
const BRANCHES = [
  {
    key: 'bandra',
    storeId: 'store_mloc_bandra',
    storeName: 'Mumbai — Bandra',
    adId: '120220000000001',
    managerEmail: 'bandra.mgr@mloc.local',
    managerName: 'Karan Malhotra',
    customer: '919000010001',
    customerName: 'Ishita Rao',
  },
  {
    key: 'rohini',
    storeId: 'store_mloc_rohini',
    storeName: 'Delhi — Rohini',
    adId: '120220000000002',
    managerEmail: 'rohini.mgr@mloc.local',
    managerName: 'Preeti Nanda',
    customer: '919000010002',
    customerName: 'Arjun Sethi',
  },
  {
    key: 'udaipur',
    storeId: 'store_mloc_udaipur',
    storeName: 'Udaipur',
    adId: '120220000000003',
    managerEmail: 'udaipur.mgr@mloc.local',
    managerName: 'Vikram Singh',
    customer: '919000010003',
    customerName: 'Meera Joshi',
  },
] as const;

const HO_EMAIL = 'ho@mloc.local';

/**
 * A NEW ad, launched later, that nobody has written a rule for.
 *
 * This is the case the whole name-matching design exists for: marketing ships a
 * mangalsutra ad into the Bandra ad set on a Tuesday, and it must route to
 * Bandra without anyone touching CaratOS.
 */
const NEW_AD_ID = '120220000000099';
const NEW_AD_CUSTOMER = '919000010004';

/**
 * Stands in for the Graph lookup.
 *
 * `MetaAdMetadataService` calls Meta, which a test must not. The SHAPE is real —
 * these are the ad-set and campaign names read from Éclat's live ad account on
 * 26 Sep — so what is stubbed is the network, not the logic being tested.
 *
 * Only the new ad resolves. The three campaign ads return null, which also
 * exercises the fail-safe: no name, so only their ad-id rules can fire.
 */
const AD_METADATA: Record<string, {
  adSetId: string | null;
  adSetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
}> = {
  [NEW_AD_ID]: {
    adSetId: '120220000000500',
    adSetName: 'Lead Campaign Bandra linking - 23-07-2026',
    campaignId: '120220000000600',
    campaignName: 'Lead Campaign Bandra linking - 23-07-2026',
  },
};

describe('Multi-location ad routing, handoff and visibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bot: WhatsAppBotService;

  const token: Record<string, string> = {};
  const managerId: Record<string, string> = {};
  /** conversation id per branch, filled by the routing test. */
  const convoOf: Record<string, string> = {};
  let wamidSeq = 1;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const login = async (email: string) => {
    const r = await request(server()).post('/auth/login').send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

  /**
   * A Meta-shaped inbound envelope.
   *
   * `metadata.phone_number_id` is the tenant routing key — without it the
   * message is stored and never reaches the CRM, because there is no trustworthy
   * way to say whose customer it is. `contacts[].profile.name` is where the
   * sender's WhatsApp name lives, one level above the message.
   */
  const envelope = (
    from: string,
    text: string,
    wamid: string,
    opts: { adId?: string; profileName?: string } = {},
  ) => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: BUSINESS_NUMBER_ID },
              contacts: opts.profileName
                ? [{ wa_id: from, profile: { name: opts.profileName } }]
                : [],
              messages: [
                {
                  id: wamid,
                  from,
                  timestamp: '1758000000',
                  type: 'text',
                  text: { body: text },
                  ...(opts.adId
                    ? {
                        referral: {
                          source_url: 'https://fb.me/2AbCdEfGh',
                          source_id: opts.adId,
                          source_type: 'ad',
                          headline: 'Bridal collection',
                          body: 'Book a private viewing',
                          media_type: 'image',
                          ctwa_clid: `clid-${opts.adId}`,
                        },
                      }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });

  /**
   * Deliver one message and DRAIN it before returning.
   *
   * `ingest` acknowledges and processes in the background, exactly as it does
   * for Meta. Without draining, the next message in a scripted conversation can
   * race the previous one's session write and the test becomes order-dependent.
   */
  const send = async (
    from: string,
    text: string,
    opts: { adId?: string; profileName?: string } = {},
  ) => {
    const wamid = `wamid.MLOC-${wamidSeq++}`;
    await bot.ingest(envelope(from, text, wamid, opts));
    for (let i = 0; i < 100; i++) {
      await bot.processPending();
      const ev = await prisma.whatsAppEvent.findUnique({
        where: { wamid },
        select: { status: true },
      });
      if (!ev || (ev.status !== 'received' && ev.status !== 'processing')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return wamid;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      // The only stub in this file. Everything else runs for real against a
      // real database over real HTTP.
      .overrideProvider(MetaAdMetadataService)
      .useValue({
        resolve: async (_organisationId: string, adId: string) => AD_METADATA[adId] ?? null,
        clearCache: () => undefined,
      })
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    bot = app.get(WhatsAppBotService);

    await teardown(prisma);
    const hash = await bcrypt.hash(PASSWORD, 10);

    await prisma.organisation.create({
      data: { id: ORG, name: 'Multi-location', slug: 'mloc', industryPackCode: 'jewellery' },
    });

    for (const b of BRANCHES) {
      await prisma.store.create({
        data: {
          id: b.storeId,
          name: b.storeName,
          city: b.storeName,
          organisationId: ORG,
          timezone: 'Asia/Kolkata',
        },
      });
    }

    // One connected WhatsApp account holding the one number all the ads point at.
    await prisma.integration.create({
      data: {
        id: INTEGRATION,
        organisationId: ORG,
        providerCode: 'whatsapp_cloud',
        name: 'Éclat WhatsApp',
        status: 'connected',
      },
    });
    await prisma.integrationAsset.create({
      data: {
        organisationId: ORG,
        integrationId: INTEGRATION,
        kind: 'phone_number',
        externalId: BUSINESS_NUMBER_ID,
        name: 'Éclat main number',
        isActive: true,
        ownershipKey: `whatsapp_cloud:phone_number:${BUSINESS_NUMBER_ID}`,
      },
    });

    for (const b of BRANCHES) {
      const mgr = await prisma.user.create({
        data: {
          email: b.managerEmail,
          name: b.managerName,
          role: 'store_manager',
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: ORG,
          userStores: { create: { storeId: b.storeId, isPrimary: true } },
        },
      });
      managerId[b.key] = mgr.id;
    }

    await prisma.user.create({
      data: {
        email: HO_EMAIL,
        name: 'Head Office',
        role: 'head_office',
        passwordHash: hash,
        isActive: true,
        approvalStatus: 'approved',
        organisationId: ORG,
        userStores: { create: { storeId: BRANCHES[0].storeId, isPrimary: true } },
      },
    });

    token.ho = await login(HO_EMAIL);
    for (const b of BRANCHES) token[b.key] = await login(b.managerEmail);

    // One rule per campaign: ad id -> branch. This is the mapping the client
    // supplies, and the only thing that decides which branch owns an ad lead.
    await request(server())
      .post('/crm/qualification/adset-rules')
      .set(auth(token.ho))
      .send({
        rules: [
          ...BRANCHES.map((b, i) => ({
            id: `rule_${b.key}`,
            name: `${b.storeName} campaign`,
            enabled: true,
            priority: 50 + i,
            matchField: 'ad_id',
            matchValue: b.adId,
            storeId: b.storeId,
            assignedUserId: null,
            handling: 'ai',
          })),
          /*
           * The rule that does the real work: one per showroom, matched on the
           * name marketing already uses. No ad id appears in it, so it covers
           * every ad that ad set will ever carry.
           */
          {
            id: 'rule_bandra_by_name',
            name: 'Bandra — any ad',
            enabled: true,
            priority: 10,
            matchField: 'ad_set_name',
            matchValue: 'bandra',
            storeId: BRANCHES[0].storeId,
            assignedUserId: null,
            handling: 'ai',
          },
        ],
      })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  /* ----------------------------------------------------------- 1. routing */

  it("stamps each city's ad click with that city's branch", async () => {
    for (const b of BRANCHES) {
      await send(b.customer, 'Saw your ad, is this available?', {
        adId: b.adId,
        profileName: b.customerName,
      });
    }

    for (const b of BRANCHES) {
      const convo = await prisma.conversation.findFirst({
        where: { organisationId: ORG, externalThreadId: b.customer },
        select: { id: true, storeId: true, matchedRuleId: true, sourceAdId: true, partyId: true },
      });
      expect(convo).toBeTruthy();
      expect(convo!.storeId).toBe(b.storeId);
      expect(convo!.matchedRuleId).toBe(`rule_${b.key}`);
      expect(convo!.sourceAdId).toBe(b.adId);
      convoOf[b.key] = convo!.id;

      // The customer is recognisable by name, not by their own phone number —
      // a manager cannot ring "919000010001" and know who they are calling.
      const party = await prisma.party.findUnique({
        where: { id: convo!.partyId! },
        select: { name: true, phone: true },
      });
      expect(party!.name).toBe(b.customerName);
      expect(party!.phone).toBeTruthy();
    }
  }, 120_000);

  it('routes a brand-new ad nobody configured, using its ad-set name', async () => {
    await send(NEW_AD_CUSTOMER, 'Do you have mangalsutra designs?', {
      adId: NEW_AD_ID,
      profileName: 'Sneha Kulkarni',
    });

    const convo = await prisma.conversation.findFirst({
      where: { organisationId: ORG, externalThreadId: NEW_AD_CUSTOMER },
      select: { id: true, storeId: true, matchedRuleId: true, sourceAdId: true },
    });

    // No rule mentions this ad id. It reached the right showroom because the
    // ad set it belongs to is named for that showroom — which is the entire
    // point: marketing launches ads without touching CaratOS.
    expect(convo!.sourceAdId).toBe(NEW_AD_ID);
    expect(convo!.matchedRuleId).toBe('rule_bandra_by_name');
    expect(convo!.storeId).toBe(BRANCHES[0].storeId);
  }, 120_000);

  it('leaves an ad it cannot resolve unrouted, rather than guessing a branch', async () => {
    // Not in AD_METADATA and matching no ad-id rule: the lookup fails, no name
    // is available, nothing matches. It must wait in the head-office queue.
    await send('919000010005', 'Saw an ad', { adId: '120220000000777' });

    const convo = await prisma.conversation.findFirst({
      where: { organisationId: ORG, externalThreadId: '919000010005' },
      select: { storeId: true, matchedRuleId: true, status: true, sourceAdId: true },
    });
    expect(convo!.storeId).toBeNull();
    expect(convo!.matchedRuleId).toBeNull();
    // Still visible, and the click is still recorded — unrouted is not lost.
    expect(convo!.status).toBe('open');
    expect(convo!.sourceAdId).toBe('120220000000777');
  }, 120_000);

  /* ----------------------------------------------------------- 2. handoff */

  it("hands each thread to the manager of the branch that paid for the ad", async () => {
    // "call me now" short-circuits the script at any point, which is the ending
    // the client's flow is built around.
    for (const b of BRANCHES) await send(b.customer, 'call me now');

    for (const b of BRANCHES) {
      const convo = await prisma.conversation.findUnique({
        where: { id: convoOf[b.key] },
        select: { handling: true, assignedUserId: true, storeId: true, handoffReason: true },
      });
      expect(convo!.handling).toBe('human');
      expect(convo!.storeId).toBe(b.storeId);
      expect(convo!.assignedUserId).toBe(managerId[b.key]);
      expect(convo!.handoffReason).toBeTruthy();
    }

    // Nobody was handed somebody else's branch.
    const assignees = BRANCHES.map((b) => managerId[b.key]);
    expect(new Set(assignees).size).toBe(BRANCHES.length);
  }, 120_000);

  it('writes what the bot collected as a note against the customer, authored by the bot', async () => {
    const convo = await prisma.conversation.findUnique({
      where: { id: convoOf.bandra },
      select: { partyId: true },
    });
    const notes = await prisma.leadNote.findMany({
      where: { organisationId: ORG, partyId: convo!.partyId! },
      select: { authorId: true, authorName: true, kind: true },
    });
    expect(notes.length).toBeGreaterThan(0);
    // Never attributed to a person — nobody typed it.
    expect(notes[0].authorId).toBeNull();
    expect(notes[0].authorName).toBe('Qualification bot');
  });

  /* ------------------------------------------------------ 3. notification */

  it('tells the branch manager who got the lead, and tells nobody else', async () => {
    for (const b of BRANCHES) {
      const notifications = await prisma.notification.findMany({
        where: { entityType: 'Conversation', entityId: convoOf[b.key] },
        select: { userId: true, href: true, storeId: true, priority: true },
      });

      // Exactly one recipient: the manager who now owns it. A handoff announced
      // to the whole branch is one nobody treats as theirs.
      expect(notifications).toHaveLength(1);
      expect(notifications[0].userId).toBe(managerId[b.key]);
      expect(notifications[0].storeId).toBe(b.storeId);
      expect(notifications[0].priority).toBe('high');

      // `thread`, not `id` — the inbox selects a conversation from `?thread=`,
      // so the other spelling opens the list and selects nothing.
      expect(notifications[0].href).toBe(`/conversations?thread=${convoOf[b.key]}`);
    }
  });

  it('never notifies a manager about another branch', async () => {
    for (const b of BRANCHES) {
      const foreign = await prisma.notification.count({
        where: {
          userId: managerId[b.key],
          entityType: 'Conversation',
          entityId: { not: convoOf[b.key] },
        },
      });
      expect(foreign).toBe(0);
    }
  });

  it('a second handoff refreshes the one notification rather than stacking another', async () => {
    const before = await prisma.notification.count({
      where: { entityType: 'Conversation', entityId: convoOf.bandra },
    });
    // A fresh ad click reopens the thread; asking for a call again hands it over
    // a second time.
    await send(BRANCHES[0].customer, 'still interested', { adId: BRANCHES[0].adId });
    await send(BRANCHES[0].customer, 'call me now');

    const after = await prisma.notification.count({
      where: { entityType: 'Conversation', entityId: convoOf.bandra },
    });
    expect(after).toBe(before);
  }, 120_000);

  /* -------------------------------------------------------- 4. visibility */

  it('shows a manager their own branch and no other', async () => {
    for (const b of BRANCHES) {
      const res = await request(server())
        .get('/crm/conversations')
        .set(auth(token[b.key]))
        .expect(200);

      const ids: string[] = res.body.map((c: { id: string }) => c.id);
      expect(ids).toContain(convoOf[b.key]);

      for (const other of BRANCHES) {
        if (other.key === b.key) continue;
        expect(ids).not.toContain(convoOf[other.key]);
      }
    }
  });

  it('refuses a manager who asks for another branch\'s thread by id', async () => {
    for (const b of BRANCHES) {
      for (const other of BRANCHES) {
        if (other.key === b.key) continue;
        const res = await request(server())
          .get(`/crm/conversations/${convoOf[other.key]}`)
          .set(auth(token[b.key]));
        // Refused, not filtered. Guessing an id must not be a way in.
        expect([403, 404]).toContain(res.status);
      }
    }
  });

  it('does not tell a manager how many conversations sit in a queue they cannot read', async () => {
    const counts = await request(server())
      .get('/crm/conversations/queues')
      .set(auth(token.bandra))
      .expect(200);
    const list = await request(server())
      .get('/crm/conversations')
      .set(auth(token.bandra))
      .expect(200);

    // The badge must be computed under the same visibility rule as the list, so
    // a manager is never told how much work sits in a branch they cannot open.
    expect(counts.body.open).toBe(list.body.length);

    // And it is strictly fewer than everything in the tenant: head office can
    // see threads for the other branches and the unrouted one.
    const everything = await request(server())
      .get('/crm/conversations')
      .set(auth(token.ho))
      .expect(200);
    expect(counts.body.open).toBeLessThan(everything.body.length);
  });

  it('head office sees all three branches', async () => {
    const res = await request(server())
      .get('/crm/conversations')
      .set(auth(token.ho))
      .expect(200);
    const ids: string[] = res.body.map((c: { id: string }) => c.id);
    for (const b of BRANCHES) expect(ids).toContain(convoOf[b.key]);
  });

  /* ------------------------------------------------------- 5. attribution */

  it("records a manager's reply against the manager who typed it", async () => {
    const b = BRANCHES[0];
    await request(server())
      .post(`/crm/conversations/${convoOf[b.key]}/messages`)
      .set(auth(token[b.key]))
      .send({ body: 'Happy to help — shall I hold a viewing for Saturday?' })
      .expect(201);

    const res = await request(server())
      .get(`/crm/conversations/${convoOf[b.key]}`)
      .set(auth(token.ho))
      .expect(200);

    const outbound = res.body.messages.filter(
      (m: { direction: string; authorType: string }) =>
        m.direction === 'outbound' && m.authorType === 'agent',
    );
    expect(outbound).toHaveLength(1);

    // The structural record: who the server says sent it. This is what an admin
    // reads to verify which manager answered which customer, and it survives a
    // reply that carries no text at all.
    expect(outbound[0].authorUser?.id).toBe(managerId[b.key]);
    expect(outbound[0].authorUser?.name).toBe(b.managerName);

    // And the customer was told too — the stored body is signed, so the thread
    // is a record of what actually arrived on their phone.
    expect(outbound[0].body.startsWith(`*${b.managerName}*\n`)).toBe(true);
  });

  it("separates the bot's messages from the manager's", async () => {
    const res = await request(server())
      .get(`/crm/conversations/${convoOf.bandra}`)
      .set(auth(token.ho))
      .expect(200);

    const botMessages = res.body.messages.filter(
      (m: { authorType: string }) => m.authorType === 'bot',
    );
    expect(botMessages.length).toBeGreaterThan(0);
    // Approved script, never recorded as a person's words or as generated text.
    for (const m of botMessages) expect(m.authorUser).toBeNull();
  });

  /* ------------------------------------------------- the list, as rendered */

  it('previews the newest real message instead of a placeholder', async () => {
    const res = await request(server())
      .get('/crm/conversations')
      .set(auth(token.bandra))
      .expect(200);

    const row = res.body.find((c: { id: string }) => c.id === convoOf.bandra);
    expect(row.lastMessage).toBeTruthy();
    expect(typeof row.lastMessage.preview).toBe('string');
    expect(row.lastMessage.preview.length).toBeGreaterThan(0);

    // The preview must be the manager's actual words, with the signature
    // stripped — otherwise every staff reply previews as the sender's own name.
    expect(row.lastMessage.authorName).toBe(BRANCHES[0].managerName);
    expect(row.lastMessage.preview.startsWith('*')).toBe(false);
    expect(row.lastMessage.preview).toContain('Saturday');
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.notification.deleteMany({ where: { user: { organisationId: ORG } } });
  await prisma.whatsAppSession.deleteMany({ where: { organisationId: ORG } });
  await prisma.whatsAppEvent.deleteMany({ where: { phoneE164: { startsWith: '9190000100' } } });
  await prisma.conversationRoutingConflict.deleteMany({ where: { organisationId: ORG } });
  await prisma.attributionTouch.deleteMany({ where: { organisationId: ORG } });
  await prisma.leadQualification.deleteMany({ where: { organisationId: ORG } });
  await prisma.message.deleteMany({ where: { organisationId: ORG } });
  await prisma.conversation.deleteMany({ where: { organisationId: ORG } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.leadNote.deleteMany({ where: { organisationId: ORG } });
  // LeadFollowUp cascades from Lead, so it needs no line of its own here.
  await prisma.lead.deleteMany({ where: { organisationId: ORG } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: ORG } });
  await prisma.party.deleteMany({ where: { organisationId: ORG } });
  await prisma.integrationAsset.deleteMany({ where: { organisationId: ORG } });
  await prisma.integrationCredential.deleteMany({ where: { organisationId: ORG } });
  await prisma.integration.deleteMany({ where: { organisationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.jobTask.deleteMany({ where: { organisationId: ORG } }).catch(() => undefined);
  await prisma.userStore.deleteMany({ where: { store: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}
