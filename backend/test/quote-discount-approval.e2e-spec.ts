import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OmnichannelService, OMNICHANNEL_DELIVERY_JOB } from '../src/omnichannel/omnichannel.service';
import { WhatsAppService } from '../src/integrations/whatsapp.service';

// The library entry point runs a self-test against a bundled file when it has no
// parent module, which is what jest looks like to it; the inner module does not.
const pdfParse: (data: Buffer) => Promise<{ text: string; numpages: number }> = require('pdf-parse/lib/pdf-parse.js');

/**
 * Quote pricing and the detailed quote PDF, after approval was REMOVED
 * (client, 13 Oct: "a quotation once created is created — no approval from
 * anybody").
 *
 * The properties pinned here:
 *
 *  1. NO DISCOUNT HOLDS A QUOTE. DiscountLimit rows still exist (Module 15 uses
 *     them elsewhere); a quote discount over any cap leaves through every door —
 *     WhatsApp text, PDF download, PDF on WhatsApp.
 *
 *  2. THE OLD APPROVAL ENDPOINTS answer 410 rather than crashing an old screen,
 *     and the pending list is empty.
 *
 *  3. EDITING bumps the revision and nothing else: no status flip, no door
 *     closes, no "approval withdrawn" audit entry.
 *
 *  4. THE PDF IS REAL, PRIVATE AND SCOPED: genuine PDF bytes naming the quote,
 *     reachable only through the quote's own visibility.
 *
 *  5. THE PDF ON WHATSAPP IS AN OUTBOX ROW, held to the same window and opt-out
 *     rules as text, and never reported sent when nothing was sent. Consent and
 *     template rules are the ONLY things that stop a send now.
 */

const PASSWORD = 'password123';
const CUSTOMER = '919812370101';

const A = {
  org: 'org_qd_a', slug: 'qd-a', store: 'store_qd_a', otherStore: 'store_qd_a2',
  ho: 'ho@qd-a.local', mgr: 'mgr@qd-a.local', mgr2: 'mgr2@qd-a.local',
  rep: 'rep@qd-a.local', farRep: 'farrep@qd-a.local',
};
const B = { org: 'org_qd_b', slug: 'qd-b', store: 'store_qd_b', ho: 'ho@qd-b.local', rep: 'rep@qd-b.local' };

/** metal 60,000 + making 10,000 + stones 20,000. Discount applies to the 30,000. */
const LINE = {
  description: 'Solitaire ring', karat: 18, weightGrams: 10, goldRatePerGram: 6000,
  makingCharges: 10000, stoneCharges: 20000,
};

async function teardown(prisma: import('../src/prisma/prisma.service').PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.message.deleteMany({ where: { organisationId: org } });
    await prisma.conversation.deleteMany({ where: { organisationId: org } });
    await prisma.jobTask.deleteMany({ where: { organisationId: org } });
    await prisma.integrationAsset.deleteMany({ where: { organisationId: org } });
    await prisma.integration.deleteMany({ where: { organisationId: org } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.productInteraction.deleteMany({ where: { organisationId: org } });
    await prisma.quoteLine.deleteMany({ where: { quote: { organisationId: org } } });
    await prisma.quoteRedeemableStore.deleteMany({ where: { quote: { organisationId: org } } });
    await prisma.quote.deleteMany({ where: { organisationId: org } });
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } });
    await prisma.mergeCandidate.deleteMany({ where: { organisationId: org } });
    await prisma.party.deleteMany({ where: { organisationId: org } });
    await prisma.discountLimit.deleteMany({ where: { organisationId: org } });
    await prisma.quoteApprovalSettings.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Quote discounts with approval removed + quote PDF (e2e)', () => {
  let app: INestApplication;
  let prisma: import('../src/prisma/prisma.service').PrismaService;
  let privateDir: string;
  const tokens: Record<string, string> = {};
  let partyId = '';

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  const createQuote = async (who: string, discountPercent: number, store = A.store) => {
    const res = await request(server())
      .post('/quotes')
      .set(as(who))
      .send({
        storeId: store, customerName: 'Discount Customer', phone: CUSTOMER,
        validUntil: '2026-10-15', discountPercent, lines: [LINE],
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; ref: string; revision: number; totals: Record<string, number> };
  };
  const gate = async (who: string, id: string) =>
    (await request(server()).get(`/quotes/${id}/approval`).set(as(who)).expect(200)).body;
  const pdf = (who: string, id: string) =>
    request(server()).get(`/quotes/${id}/pdf`).set(as(who)).buffer(true).parse(binary);
  const outboundCount = () => prisma.message.count({ where: { organisationId: A.org, direction: 'outbound' } });

  beforeAll(async () => {
    privateDir = mkdtempSync(join(tmpdir(), 'eclat-quote-pdf-'));
    process.env.PRIVATE_UPLOAD_DIR = privateDir;

    const { AppModule } = await import('../src/app.module');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const org of [A, B]) {
      await prisma.organisation.create({
        data: { id: org.org, name: `Maison ${org.slug}`, slug: org.slug, industryPackCode: 'jewellery', gstin: '24ABCDE1234F1Z5' },
      });
    }
    await prisma.store.createMany({
      data: [
        { id: A.store, name: 'Counter One', city: 'Surat', organisationId: A.org, addressLine1: '12 Ring Road', state: 'Gujarat', pincode: '395002' },
        { id: A.otherStore, name: 'Counter Two', city: 'Mumbai', organisationId: A.org },
        { id: B.store, name: 'Other Tenant', city: 'Pune', organisationId: B.org },
      ],
    });
    const users: [string, string, string, string, string][] = [
      ['ho', A.ho, 'head_office', A.org, A.store],
      ['mgr', A.mgr, 'store_manager', A.org, A.store],
      ['mgr2', A.mgr2, 'store_manager', A.org, A.store],
      ['rep', A.rep, 'salesperson', A.org, A.store],
      ['farRep', A.farRep, 'salesperson', A.org, A.otherStore],
      ['hoB', B.ho, 'head_office', B.org, B.store],
      ['repB', B.rep, 'salesperson', B.org, B.store],
    ];
    for (const [key, email, role, org, store] of users) {
      await prisma.user.create({
        data: {
          id: `u_qd_${key}`, email, name: key, role: role as never, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: org,
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }

    // Tenant A still has Module 15 caps on file, as head office would set them
    // through POST /discounts/limits. Since 13 Oct they hold NO quote: the
    // tests below pin that an over-cap discount leaves anyway.
    await prisma.discountLimit.createMany({
      data: [
        { organisationId: A.org, role: 'salesperson', storeId: null, maxPercent: 5, maxDiamondPercent: 2, maxMakingPercent: 5 },
        { organisationId: A.org, role: 'store_manager', storeId: null, maxPercent: 10, maxDiamondPercent: 5, maxMakingPercent: 10 },
        { organisationId: A.org, role: 'head_office', storeId: null, maxPercent: 100, maxDiamondPercent: 100, maxMakingPercent: 100 },
      ],
    });

    // The customer, with a WhatsApp thread they wrote on an hour ago.
    partyId = (
      await prisma.party.create({
        data: {
          organisationId: A.org, storeId: A.store, name: 'Discount Customer', phone: CUSTOMER,
          contactPoints: {
            create: { organisationId: A.org, kind: 'whatsapp', value: CUSTOMER, valueNormalized: CUSTOMER, isPrimary: true },
          },
        },
      })
    ).id;
    await prisma.conversation.create({
      data: {
        organisationId: A.org, channel: 'whatsapp', externalThreadId: CUSTOMER, partyId,
        storeId: A.store, handling: 'human', lastInboundAt: new Date(Date.now() - 3_600_000),
      },
    });

    for (const [key, email] of users.map(([k, e]) => [k, e])) {
      tokens[key] = (
        await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)
      ).body.token;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
    delete process.env.PRIVATE_UPLOAD_DIR;
    if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  });

  it('prices the discount on making and stones only — never on gold', async () => {
    const q = await createQuote('rep', 8);
    // 8% of (10,000 making + 20,000 stones) = 2,400. Gold's 60,000 is untouched.
    expect(q.totals.discount).toBe(2400);
    expect(q.totals.taxable).toBe(87600);
    expect(q.totals.grandTotal).toBe(90228);
  });

  it('a discount within the cap needs nothing, and every door is open', async () => {
    const q = await createQuote('rep', 5);
    const g = await gate('rep', q.id);
    expect(g).toMatchObject({ required: false, cleared: true, reasons: [] });

    await request(server()).post(`/quotes/${q.id}/share`).set(as('rep')).expect(201);
    const file = await pdf('rep', q.id);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  let held: { id: string; ref: string };

  it('a discount above the old cap leaves through every door — nothing holds a quote', async () => {
    held = await createQuote('rep', 8);
    const g = await gate('rep', held.id);
    expect(g).toMatchObject({ required: false, cleared: true, reason: null, reasons: [] });

    await request(server()).post(`/quotes/${held.id}/share`).set(as('rep')).expect(201);
    expect((await pdf('rep', held.id)).status).toBe(200);
  });

  it('asking and deciding are gone (410), and the pending list is empty', async () => {
    expect((await request(server()).post(`/quotes/${held.id}/request-approval`).set(as('rep'))).status).toBe(410);
    expect(
      (await request(server()).post(`/quotes/${held.id}/decide`).set(as('mgr')).send({ approve: true })).status,
    ).toBe(410);

    const pending = await request(server()).get('/quotes/approval/pending').set(as('mgr')).expect(200);
    expect(pending.body).toEqual([]);

    // The attempts flipped nothing.
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: held.id } });
    expect(q.status).toBe('draft');
    expect(q.requestedById).toBeNull();
    expect(q.decidedById).toBeNull();
  });

  it('the PDF is a genuine PDF naming the quote — with no approval line and no DRAFT stamp', async () => {
    const file = await pdf('rep', held.id);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/application\/pdf/);
    expect(file.headers['content-disposition']).toContain(`${held.ref}-r1.pdf`);
    const bytes = file.body as Buffer;
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const parsed = await pdfParse(bytes);
    expect(parsed.text).toContain(held.ref);
    expect(parsed.text).not.toMatch(/Approved by a manager/);
    expect(parsed.text).not.toMatch(/DRAFT/);
    expect(parsed.text).toContain('90,228.00');
    expect(parsed.text).toContain('Maison qd-a');
    expect(parsed.text).toContain('24ABCDE1234F1Z5');
    expect(parsed.text).toContain('Solitaire ring');
    // The bill shows each line's own discount in the Dis% column.
    expect(parsed.text).toContain('-8%');
    expect(parsed.text).toContain('2026-10-15');
  });

  it('nobody outside the quote’s visibility can download it', async () => {
    // Same tenant, a salesperson at another branch: the quote screen would 404.
    expect((await pdf('farRep', held.id)).status).toBe(404);
    // Another tenant's head office.
    expect((await pdf('hoB', held.id)).status).toBe(404);
    // Nobody at all.
    expect((await request(server()).get(`/quotes/${held.id}/pdf`)).status).toBe(401);
  });


  it('the PDF on WhatsApp is an outbox row with a private document — and is never reported sent', async () => {
    // The customer's thread is a colleague's. The rep's own quote still reaches them.
    const mgr = await prisma.user.findUniqueOrThrow({ where: { email: A.mgr }, select: { id: true } });
    await prisma.conversation.updateMany({
      where: { organisationId: A.org, externalThreadId: CUSTOMER },
      data: { assignedUserId: mgr.id },
    });
    const res = await request(server()).post(`/quotes/${held.id}/send-pdf`).set(as('rep')).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ queued: true, revision: 1, status: 'queued', dryRun: true });

    const message = await prisma.message.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(message).toMatchObject({ direction: 'outbound', status: 'queued', mediaType: 'document', mediaUrl: null });
    const document = (message.payload as { omnichannel: { document: { storageKey: string; filename: string } } })
      .omnichannel.document;
    expect(document.filename).toBe(`${held.ref}-r1.pdf`);
    expect(document.storageKey.startsWith(`org/${A.org}/quote-pdfs/`)).toBe(true);
    // Sending did not hand the rep the colleague's thread, or open it to them.
    await request(server()).get(`/crm/conversations/${message.conversationId}`).set(as('rep')).expect(404);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: message.conversationId } })).assignedUserId).toBe(mgr.id);
    expect(JSON.stringify(message.payload)).not.toMatch(/https?:\/\//);

    const job = await prisma.jobTask.findFirst({
      where: { organisationId: A.org, kind: OMNICHANNEL_DELIVERY_JOB, idempotencyKey: { contains: message.id } },
    });
    expect(job).toBeTruthy();

    // The stored copy exists, is private to this tenant, and is the same PDF.
    const { StorageService } = await import('../src/storage/storage.service');
    const storage = app.get(StorageService);
    expect((await storage.readPrivate(A.org, document.storageKey))?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await storage.readPrivate(B.org, document.storageKey)).toBeNull();

    // WhatsApp is not connected for this tenant: the worker runs and says so.
    const { JobsService } = await import('../src/jobs/jobs.service');
    await app.get(JobsService).drain(10);
    const after = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(after.status).not.toBe('sent');
    expect(after.externalId).toBeNull();
    expect(after.error).toBeTruthy();
  });

  it('outside the 24-hour window, with no template, the PDF is refused like text would be', async () => {
    await prisma.conversation.updateMany({
      where: { organisationId: A.org, externalThreadId: CUSTOMER },
      data: { lastInboundAt: new Date(Date.now() - 30 * 3_600_000) },
    });
    const res = await request(server()).post(`/quotes/${held.id}/send-pdf`).set(as('rep')).send({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/template/i);
    await prisma.conversation.updateMany({
      where: { organisationId: A.org, externalThreadId: CUSTOMER },
      data: { lastInboundAt: new Date(Date.now() - 3_600_000) },
    });
  });

  /* ------------------- editing bumps the revision, and nothing else closes */

  it.each([
    ['the discount', { discountPercent: 7 }],
    ['the price', { lines: [{ ...LINE, makingCharges: 12000 }] }],
    ['the material lines', { lines: [LINE, { ...LINE, description: 'Matching band', stoneCharges: 0 }] }],
  ])('editing %s bumps the revision and every door stays open', async (_what, edit) => {
    const q = await createQuote('rep', 8);
    expect((await gate('rep', q.id)).cleared).toBe(true);

    const edited = await request(server()).patch(`/quotes/${q.id}`).set(as('rep')).send(edit);
    expect(edited.status).toBe(200);
    expect(edited.body.revision).toBe(2);
    expect(edited.body.status).toBe('draft');

    expect((await gate('rep', q.id)).cleared).toBe(true);
    await request(server()).post(`/quotes/${q.id}/share`).set(as('rep')).expect(201);
    const file = await pdf('rep', q.id);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain('-r2.pdf');

    // The edit is on the record as an edit — not as an approval withdrawn.
    const edits = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'quotes.edited', entityId: q.id },
    });
    expect(edits).toBeTruthy();
    const invalidated = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'quotes.approval_invalidated', entityId: q.id },
    });
    expect(invalidated).toBeNull();
  });

  it('a discount changed behind the API’s back holds nothing either', async () => {
    const q = await createQuote('rep', 8);
    await prisma.quote.update({ where: { id: q.id }, data: { discountPercent: 19 } });
    expect((await gate('rep', q.id)).cleared).toBe(true);
  });

  /* ---------------------------------------- the old policy knobs are gone */

  it('the settings cannot be written (410) and read as switched off', async () => {
    const gone = await request(server())
      .put('/quotes/approval/settings').set(as('ho')).send({ valueThreshold: 50_000 });
    expect(gone.status).toBe(410);
    expect(JSON.stringify(gone.body)).toMatch(/no approval from anybody/i);

    const read = await request(server()).get('/quotes/approval/settings').set(as('mgr')).expect(200);
    expect(read.body).toMatchObject({ valueThreshold: null, allowSelfApproval: false });
  });

  it('a manager’s own quote over their own cap leaves on nobody’s say-so but theirs', async () => {
    // 12% is over the manager's old 10% cap — the case that used to need head
    // office. It leaves freely now.
    const q = await createQuote('mgr', 12);
    expect(await gate('mgr', q.id)).toMatchObject({ required: false, cleared: true, reasons: [] });
    await request(server()).post(`/quotes/${q.id}/share`).set(as('mgr')).expect(201);
  });

  it('a manager-priced quote leaves when a salesperson sends it', async () => {
    const q = await createQuote('mgr', 8);
    // Priced by the manager, handed to the rep to send: a salesperson acts only
    // on quotes assigned to them.
    const rep = await prisma.user.findUniqueOrThrow({ where: { email: A.rep }, select: { id: true } });
    await prisma.quote.update({ where: { id: q.id }, data: { assignedRepId: rep.id } });
    expect((await gate('rep', q.id)).required).toBe(false);
    await request(server()).post(`/quotes/${q.id}/share`).set(as('rep')).expect(201);
  });

  it('a stale settings row with a threshold holds nothing', async () => {
    await prisma.quoteApprovalSettings.create({
      data: { organisationId: A.org, valueThreshold: 50_000, allowSelfApproval: false },
    });
    const q = await createQuote('rep', 8); // 90,228 total, over the stale 50k
    expect(await gate('rep', q.id)).toMatchObject({ required: false, cleared: true, reasons: [] });
    await request(server()).post(`/quotes/${q.id}/share`).set(as('rep')).expect(201);
    await prisma.quoteApprovalSettings.deleteMany({ where: { organisationId: A.org } });
  });

  /* ------------------------------------------------- one tenant's rule only */

  it('a tenant that never configured caps is not given another tenant’s rule', async () => {
    const q = await request(server())
      .post('/quotes')
      .set(as('repB'))
      .send({ storeId: B.store, customerName: 'Other Customer', phone: '919812370202', discountPercent: 20, lines: [LINE] })
      .expect(201);
    const g = (await request(server()).get(`/quotes/${q.body.id}/approval`).set(as('repB')).expect(200)).body;
    expect(g).toMatchObject({ required: false, cleared: true });
    await request(server()).post(`/quotes/${q.body.id}/share`).set(as('repB')).expect(201);
    const file = await request(server())
      .get(`/quotes/${q.body.id}/pdf`).set(as('repB')).buffer(true).parse(binary);
    expect(file.status).toBe(200);
  });

  it('a customer who answered STOP does not get the PDF either', async () => {
    await request(server())
      .post('/omnichannel/consents')
      .set(as('ho'))
      .send({ partyId, channel: 'whatsapp', purpose: 'all', status: 'revoked', source: 'inbound_message' })
      .expect(201);
    const before = await outboundCount();
    const res = await request(server()).post(`/quotes/${held.id}/send-pdf`).set(as('rep')).send({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/opted out/i);
    expect(await outboundCount()).toBe(before);
  });

  it('with the approved quotation template synced, the queued PDF rides it (10 Oct)', async () => {
    // The tenant's template, as template-sync would record it after Meta's
    // APPROVED verdict. sendPdf attaches it by DEFAULT so the PDF still lands
    // when the 24-hour window is closed.
    await prisma.integration.create({
      data: {
        id: 'int_qd_wa', organisationId: A.org, providerCode: 'whatsapp_cloud',
        status: 'connected', name: 'WA',
      },
    });
    const asset = await prisma.integrationAsset.create({
      data: {
        organisationId: A.org, integrationId: 'int_qd_wa', kind: 'message_template',
        externalId: 'quotation_pdf_v1:en', name: 'quotation_pdf_v1', isActive: true,
        lastVerifiedAt: new Date(),
        metadata: {
          languageCode: 'en', category: 'utility', approvalStatus: 'approved',
          providerStatus: 'APPROVED', providerSyncedAt: new Date().toISOString(),
        },
      },
    });

    // A fresh recipient: the STOP case above opted the quote's own customer
    // out, and this test is about the template, not consent.
    const res = await request(server())
      .post(`/quotes/${held.id}/send-pdf`)
      .set(as('rep'))
      .send({ to: '9822200111' });
    expect(res.status).toBe(201);
    const message = await prisma.message.findUniqueOrThrow({ where: { id: res.body.messageId } });
    const instructions = (message.payload as {
      omnichannel: { templateAssetId?: string; templateComponents?: { type: string; parameters: { text: string }[] }[] };
    }).omnichannel;
    expect(instructions.templateAssetId).toBe(asset.id);
    const body = instructions.templateComponents?.find((c) => c.type === 'body');
    const texts = (body?.parameters ?? []).map((prm) => prm.text);
    // {{1}} customer … {{5}} valid-until, with the quote's own facts.
    expect(texts).toHaveLength(5);
    expect(texts[1]).toBe(held.ref);
    expect(texts.join(' ')).toMatch(/₹|Rs|\d/);

    // Leave the tenant as found: other cases assert the no-provider dry run.
    await prisma.integrationAsset.deleteMany({ where: { organisationId: A.org } });
    await prisma.integration.deleteMany({ where: { organisationId: A.org } });
  });
});

/* ---------------------------------------------------------------------------
 * The delivery worker and the provider call, without a database or a network.
 * ------------------------------------------------------------------------- */

describe('quote PDF delivery (worker + provider shape)', () => {
  const PDF = Buffer.from('%PDF-1.7\n% test document\n');

  function worker(opts: { stored: Buffer | null }) {
    let handler: ((payload: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    const updates: { data: Record<string, unknown> }[] = [];
    const conversation = {
      id: 'c1', organisationId: 'org-a', partyId: 'p1', storeId: 's1', channel: 'whatsapp',
      externalThreadId: CUSTOMER, lastInboundAt: new Date(), senderAssetId: null,
      party: { id: 'p1', phone: null, whatsapp: CUSTOMER, contactPoints: [] },
    };
    const prisma = {
      message: {
        findFirst: jest.fn(async () => ({
          id: 'm1', organisationId: 'org-a', conversationId: 'c1', direction: 'outbound',
          body: 'Quote QT-1', mediaUrl: null, mediaType: 'document', status: 'queued',
          payload: {
            omnichannel: {
              purpose: 'service',
              document: { storageKey: 'org/org-a/quote-pdfs/q1-r1.pdf', filename: 'QT-1-r1.pdf', mimeType: 'application/pdf' },
            },
          },
          conversation,
        })),
        update: jest.fn(async (input: { data: Record<string, unknown> }) => {
          updates.push(input);
          return { id: 'm1', ...input.data };
        }),
      },
      activityEvent: { findMany: jest.fn(async () => []) },
      conversation: { updateMany: jest.fn(async () => ({ count: 1 })) },
      // A sent message settles any feedback ask that was waiting on it.
      feedbackRequest: { updateMany: jest.fn(async () => ({ count: 0 })) },
    };
    const whatsapp = {
      sendText: jest.fn(),
      sendTemplate: jest.fn(),
      sendDocument: jest.fn(async () => ({ delivered: true, dryRun: false, messageId: 'wamid.doc', to: CUSTOMER })),
    };
    const storage = { readPrivate: jest.fn(async () => opts.stored) };
    const service = new OmnichannelService(
      prisma as never,
      { register: (_kind: string, fn: typeof handler) => { handler = fn; } } as never,
      {} as never,
      { record: jest.fn(async () => ({})) } as never,
      {} as never,
      whatsapp as never,
      { deliverability: async () => ({ state: 'live', reason: 'Fixture.' }) } as never,
      {} as never,
      {} as never,
      storage as never,
    );
    service.onModuleInit();
    const run = () =>
      handler!({ messageId: 'm1' }, { jobId: 'j1', organisationId: 'org-a', attempt: 1, kind: OMNICHANNEL_DELIVERY_JOB });
    return { run, updates, whatsapp, storage };
  }

  it('reads the private copy for its own tenant and hands the bytes to the provider as a document', async () => {
    const w = worker({ stored: PDF });
    await w.run();
    expect(w.storage.readPrivate).toHaveBeenCalledWith('org-a', 'org/org-a/quote-pdfs/q1-r1.pdf');
    expect(w.whatsapp.sendText).not.toHaveBeenCalled();
    expect(w.whatsapp.sendDocument).toHaveBeenCalledWith(
      'org-a',
      CUSTOMER,
      { buffer: PDF, filename: 'QT-1-r1.pdf', mimeType: 'application/pdf', caption: 'Quote QT-1' },
      { assetId: null, storeId: 's1' },
      undefined,
    );
    expect(w.updates.at(-1)!.data).toMatchObject({ status: 'sent', externalId: 'wamid.doc' });
  });

  it('fails permanently, without calling the provider, when the stored document is gone', async () => {
    const w = worker({ stored: null });
    const result = await w.run();
    expect(w.whatsapp.sendDocument).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: false, code: 'attachment_missing' });
    expect(w.updates.at(-1)!.data).toMatchObject({ status: 'failed' });
  });

  it('uploads to the provider’s media store and sends the media id — never a link', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = String(url).endsWith('/media') ? { id: 'media-123' } : { messages: [{ id: 'wamid.doc' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    try {
      const service = new WhatsAppService(
        { get: () => undefined } as never,
        {
          senderFor: async () => ({
            usable: true, accessToken: 'token', phoneNumberId: 'pn1', scope: 'tenant', assetId: 'a1', resolvedBy: 'only_number',
          }),
        } as never,
      );
      const result = await service.sendDocument(
        'org-a', CUSTOMER, { buffer: PDF, filename: 'QT-1-r1.pdf', mimeType: 'application/pdf', caption: 'Quote QT-1' },
      );
      expect(result).toMatchObject({ delivered: true, dryRun: false, messageId: 'wamid.doc' });
      expect(calls[0].url).toMatch(/\/pn1\/media$/);
      expect(calls[0].init.body).toBeInstanceOf(FormData);
      expect(calls[1].url).toMatch(/\/pn1\/messages$/);
      expect(JSON.parse(String(calls[1].init.body))).toEqual({
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'document',
        document: { id: 'media-123', filename: 'QT-1-r1.pdf', caption: 'Quote QT-1' },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not upload anything when WhatsApp is not connected', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const service = new WhatsAppService(
        { get: () => undefined } as never,
        { senderFor: async () => ({ usable: false, scope: 'none', reason: 'No WhatsApp sender is configured.' }) } as never,
      );
      const result = await service.sendDocument(
        'org-a', CUSTOMER, { buffer: PDF, filename: 'QT-1-r1.pdf', mimeType: 'application/pdf' },
      );
      expect(result).toMatchObject({ delivered: false, dryRun: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

});
