import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConversationsService } from '../src/crm/conversations.service';
import {
  adCardFrom,
  extractMetaReferral,
  platformFromSourceUrl,
} from '../src/integrations/meta-referral';
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

  /*
   * WhatsApp draws "Instagram ad" above a CTWA thread, so the platform IS
   * carried — in source_url. Reading the host is the same signal, and it
   * answers the question a branch manager actually asks about a lead.
   */
  it('reads the platform from the referral source url', () => {
    expect(platformFromSourceUrl('https://www.instagram.com/p/DdwKr6isgcO/')).toBe('instagram');
    expect(platformFromSourceUrl('https://instagram.com/reel/abc')).toBe('instagram');
    expect(platformFromSourceUrl('https://fb.me/2AbCdEfGh')).toBe('facebook');
    expect(platformFromSourceUrl('https://www.facebook.com/123/posts/456')).toBe('facebook');
    expect(platformFromSourceUrl('https://m.me/eclat')).toBe('messenger');
  });

  it('says UNKNOWN rather than defaulting to Facebook', () => {
    // Meta does not send `publisher_platform` on a referral, so a source we
    // cannot read is genuinely of unknown origin. Defaulting it would put a
    // fact on the lead that nobody established, and a manager reading
    // "Facebook" would have no way to tell it was a guess.
    expect(platformFromSourceUrl(null)).toBeNull();
    expect(platformFromSourceUrl('')).toBeNull();
    expect(platformFromSourceUrl('not a url at all')).toBeNull();
    expect(platformFromSourceUrl('https://example.com/whatever')).toBeNull();
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

  /* ----------------------------------------------- the advert, on the message */

  /*
   * WhatsApp puts a card above the customer's first message: the creative, its
   * headline, and a link back to the advert. The CRM showed a manager none of
   * that and left them decoding a 17-digit id in a side panel.
   *
   * The card is built per MESSAGE rather than per conversation on purpose. The
   * conversation row holds FIRST touch and is never rewritten, so a second ad
   * click months later is invisible there by design. On the message it is not.
   */
  it('hands the inbox everything it needs to draw the advert card', () => {
    const raw = ctwaMessage('120210000000001', 'wamid.card.1');
    raw.referral.source_url = 'https://www.instagram.com/p/DdwKr6isgcO/';
    (raw.referral as Record<string, unknown>).thumbnail_url =
      'https://scontent.xx.fbcdn.net/v/t45.1600-4/thumb.jpg';

    const card = adCardFrom(extractMetaReferral(raw))!;
    expect(card.adId).toBe('120210000000001');
    expect(card.headline).toBe('Bridal collection — Hyderabad');
    expect(card.body).toBe('Book a private viewing');
    expect(card.sourceUrl).toBe('https://www.instagram.com/p/DdwKr6isgcO/');
    expect(card.platform).toBe('instagram');
    expect(card.thumbnailUrl).toContain('thumb.jpg');
  });

  it('falls back to image_url, and to nothing at all, rather than inventing a thumbnail', () => {
    const withImage = ctwaMessage('120210000000001', 'wamid.card.2');
    (withImage.referral as Record<string, unknown>).image_url = 'https://scontent.xx.fbcdn.net/img.jpg';
    expect(adCardFrom(extractMetaReferral(withImage))!.thumbnailUrl).toContain('img.jpg');

    // A text-only advert sends neither. A card with no picture is correct;
    // a placeholder that looks like the creative is a small lie.
    const bare = ctwaMessage('120210000000001', 'wamid.card.3');
    expect(adCardFrom(extractMetaReferral(bare))!.thumbnailUrl).toBeNull();
  });

  it('returns no card for an ordinary message', () => {
    // Every message except the first of an ad thread. If this ever returned a
    // card, every bubble in every conversation would grow an advert above it.
    expect(adCardFrom(extractMetaReferral({ text: { body: 'hi' } }))).toBeNull();
    expect(adCardFrom(null)).toBeNull();
  });

  it('puts the card on the message that carried it, and on no other', async () => {
    const raw = ctwaMessage('120210000000001', 'wamid.card.thread.1');
    raw.from = '919000000020';
    raw.referral.source_url = 'https://www.instagram.com/p/DdwKr6isgcO/';
    const first = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: raw.from, externalId: raw.id,
      senderKind: 'whatsapp', senderValue: raw.from,
      body: raw.text.body, payload: raw as never, adReferral: extractMetaReferral(raw),
    });

    // A second, ordinary message on the same thread.
    const plain = { from: raw.from, id: 'wamid.card.thread.2', type: 'text', text: { body: 'Still there?' } };
    await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: raw.from, externalId: plain.id,
      senderKind: 'whatsapp', senderValue: raw.from,
      body: plain.text.body, payload: plain as never,
    });

    const res = await request(app.getHttpServer())
      .get(`/crm/conversations/${first.conversationId}`)
      .set(auth())
      .expect(200);

    const messages = res.body.messages as Array<{ body: string; ad: unknown }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].ad).toMatchObject({
      adId: '120210000000001',
      platform: 'instagram',
      headline: 'Bridal collection — Hyderabad',
    });
    expect(messages[1].ad).toBeNull();

    // And the raw provider envelope stays on the server. It carries the
    // sender's WhatsApp profile name and the whole webhook body, none of which
    // the inbox needs in order to draw a card.
    expect(messages[0]).not.toHaveProperty('payload');
  });

  /* ------------------------------------------- which app the ad was tapped in */

  /*
   * One advert, two placements, one inbox.
   *
   * The same creative runs on Instagram and on Facebook, both CTAs open
   * WhatsApp, so every lead below arrives with `channel: 'whatsapp'`. The
   * channel filter cannot separate them — only the referral's `source_url`
   * can, and this is the test that says so.
   */
  it('separates Instagram leads from Facebook leads that came through the same inbox', async () => {
    const ig = ctwaMessage('120210000000001', 'wamid.ig.1');
    ig.from = '919000000010';
    ig.referral.source_url = 'https://www.instagram.com/p/DdwKr6isgcO/';
    const igResult = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: ig.from, externalId: ig.id,
      senderKind: 'whatsapp', senderValue: ig.from,
      body: ig.text.body, payload: ig as never, adReferral: extractMetaReferral(ig),
    });

    const fb = ctwaMessage('120210000000001', 'wamid.fb.1');
    fb.from = '919000000011';
    fb.referral.source_url = 'https://www.facebook.com/eclatdiamonds/posts/123';
    const fbResult = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: fb.from, externalId: fb.id,
      senderKind: 'whatsapp', senderValue: fb.from,
      body: fb.text.body, payload: fb as never, adReferral: extractMetaReferral(fb),
    });

    // Same ad, same channel, same store — only the placement differs.
    const [igRow, fbRow] = await Promise.all([
      prisma.conversation.findUnique({
        where: { id: igResult.conversationId },
        select: { channel: true, sourceAdId: true, sourcePlatform: true },
      }),
      prisma.conversation.findUnique({
        where: { id: fbResult.conversationId },
        select: { channel: true, sourceAdId: true, sourcePlatform: true },
      }),
    ]);
    expect(igRow!.channel).toBe('whatsapp');
    expect(fbRow!.channel).toBe('whatsapp');
    expect(igRow!.sourceAdId).toBe(fbRow!.sourceAdId);
    expect(igRow!.sourcePlatform).toBe('instagram');
    expect(fbRow!.sourcePlatform).toBe('facebook');

    const onlyIg = await request(app.getHttpServer())
      .get('/crm/conversations?sourcePlatform=instagram')
      .set(auth())
      .expect(200);
    const igIds = onlyIg.body.map((c: { id: string }) => c.id);
    expect(igIds).toContain(igResult.conversationId);
    expect(igIds).not.toContain(fbResult.conversationId);

    const onlyFb = await request(app.getHttpServer())
      .get('/crm/conversations?sourcePlatform=facebook')
      .set(auth())
      .expect(200);
    const fbIds = onlyFb.body.map((c: { id: string }) => c.id);
    expect(fbIds).toContain(fbResult.conversationId);
    expect(fbIds).not.toContain(igResult.conversationId);

    // And the platform rides along on the row, so the inbox can label it
    // without a second request.
    const igBody = onlyIg.body.find((c: { id: string }) => c.id === igResult.conversationId);
    expect(igBody.source.platform).toBe('instagram');
  });

  /*
   * "Unknown" is its own bucket, not a synonym for Facebook.
   *
   * Meta does not always send `source_url`, and when it does not, the honest
   * answer is that nobody knows which app the customer was in. Folding those
   * into Facebook would make the Facebook count quietly wrong, and nothing on
   * screen would say so.
   */
  it('lists ad leads with no readable source separately, and never as Facebook', async () => {
    const bare = ctwaMessage('120210000000001', 'wamid.bare.1');
    bare.from = '919000000012';
    delete (bare.referral as { source_url?: string }).source_url;
    const result = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: bare.from, externalId: bare.id,
      senderKind: 'whatsapp', senderValue: bare.from,
      body: bare.text.body, payload: bare as never, adReferral: extractMetaReferral(bare),
    });

    const row = await prisma.conversation.findUnique({
      where: { id: result.conversationId },
      select: { sourceAdId: true, sourcePlatform: true },
    });
    expect(row!.sourceAdId).toBe('120210000000001'); // the ad is still known
    expect(row!.sourcePlatform).toBeNull(); // the placement is not

    const unknown = await request(app.getHttpServer())
      .get('/crm/conversations?sourcePlatform=unknown')
      .set(auth())
      .expect(200);
    expect(unknown.body.map((c: { id: string }) => c.id)).toContain(result.conversationId);

    const fb = await request(app.getHttpServer())
      .get('/crm/conversations?sourcePlatform=facebook')
      .set(auth())
      .expect(200);
    expect(fb.body.map((c: { id: string }) => c.id)).not.toContain(result.conversationId);
  });

  /*
   * A thread nobody clicked an ad to start is not "unknown placement" — it has
   * no placement at all. Mixing the two would put walk-in and organic chatter
   * into a bucket a marketer reads as wasted ad spend.
   */
  it('keeps non-ad conversations out of the unknown-source bucket', async () => {
    const result = await conversations.ingestInbound({
      organisationId: A.org, channel: 'whatsapp',
      externalThreadId: '919000000013', externalId: 'wamid.organic.1',
      senderKind: 'whatsapp', senderValue: '919000000013',
      body: 'Hi, are you open on Sunday?', payload: { from: '919000000013' } as never,
    });

    const unknown = await request(app.getHttpServer())
      .get('/crm/conversations?sourcePlatform=unknown')
      .set(auth())
      .expect(200);
    expect(unknown.body.map((c: { id: string }) => c.id)).not.toContain(result.conversationId);
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
