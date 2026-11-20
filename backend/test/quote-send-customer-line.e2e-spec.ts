import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * A quotation reaching the customer, from the CUSTOMER-FACING line.
 *
 * FIXTURE-TESTED. Nothing here contacts Meta: the token is a fixture written
 * through the real envelope encryption, and `fetch` is replaced for the delivery
 * worker so the Graph call is captured instead of made. No live WhatsApp message
 * is sent by this file. What is asserted is WHICH number the Graph call was
 * addressed to, which is the whole point.
 *
 * The business runs two lines on one WABA: a shopfront number customers see and
 * an internal number store staff file the DSR on. They are not interchangeable,
 * and the failure is silent in both directions — a quotation arriving from the
 * operations number is replied to on a line where the sales bot is not
 * listening, and the customer reads it as a different business.
 *
 * What is being defended:
 *
 *  1. A QUOTE LEAVES FROM A CUSTOMER-FACING NUMBER OR IT DOES NOT LEAVE. Not
 *     from the oldest number, not from the one a thread happens to be pinned to,
 *     and not from the one a branch is mapped to if that one is the staff line.
 *
 *  2. THE CLASSIFICATION IS WHAT RESOLVES THE AMBIGUITY. Two numbers used to
 *     mean "refuse, no branch is mapped". One of them being the staff line makes
 *     the choice unambiguous without any branch mapping at all.
 *
 *  3. EVERY REFUSAL SAYS WHICH THING TO FIX — the branch to map, the number to
 *     classify, or the template sync to run. None of them is "could not send".
 *
 *  4. THE APPROVED TEMPLATE CARRIES THE PDF when it is there, and when it is
 *     not, the refusal names the sync rather than implying no template exists.
 *
 *  5. THE NUMBER TYPED IS THE NUMBER MESSAGED, Indian or foreign.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';
// This file asserts which number a send was addressed to, so the staging blast
// door must not turn every send into a refusal first.
delete process.env.MESSAGING_RECIPIENT_ALLOWLIST;

const PASSWORD = 'password123';
const ORG = 'org_qsend';
const STORE = 'store_qsend';
const HO = 'ho@qsend.local';
const ACCOUNT = 'int_qsend_waba';

/** The shopfront line (customer-facing) and the DSR line (staff only). */
const CUSTOMER_PN = '770000017690';
const INTERNAL_PN = '770000012616';
/** A second shopfront number, added only by the ambiguity test. */
const SECOND_PN = '770000017691';

const CUSTOMER = '919812377101';
const TEMPLATE = 'quotation_pdf_v1';

const LINE = {
  description: 'Solitaire ring',
  karat: 18,
  weightGrams: 10,
  goldRatePerGram: 6000,
  makingCharges: 10000,
  stoneCharges: 20000,
};

async function teardown(prisma: PrismaService) {
  await prisma.storeMessagingRoute.deleteMany({ where: { organisationId: ORG } });
  await prisma.message.deleteMany({ where: { organisationId: ORG } });
  await prisma.conversation.deleteMany({ where: { organisationId: ORG } });
  await prisma.jobTask.deleteMany({ where: { organisationId: ORG } });
  await prisma.integrationCredential.deleteMany({ where: { organisationId: ORG } });
  await prisma.integrationAsset.deleteMany({ where: { organisationId: ORG } });
  await prisma.integration.deleteMany({ where: { organisationId: ORG } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organisationId: ORG } });
  await prisma.productInteraction.deleteMany({ where: { organisationId: ORG } });
  await prisma.quoteLine.deleteMany({ where: { quote: { organisationId: ORG } } });
  await prisma.quoteRedeemableStore.deleteMany({ where: { quote: { organisationId: ORG } } });
  await prisma.quote.deleteMany({ where: { organisationId: ORG } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: ORG } });
  await prisma.mergeCandidate.deleteMany({ where: { organisationId: ORG } });
  await prisma.party.deleteMany({ where: { organisationId: ORG } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: ORG } } });
  await prisma.user.deleteMany({ where: { organisationId: ORG } });
  await prisma.store.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
}

describe('A quotation on WhatsApp leaves from the customer line (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let credentials: import('../src/integrations/whatsapp-credentials.service').WhatsAppCredentialsService;
  let privateDir: string;
  let token = '';
  let quoteId = '';
  let quoteRef = '';
  /** phone-number id → asset id. */
  const assetOf = new Map<string, string>();

  const server = () => app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });

  /** Register one number the way a verified connection holds it. */
  async function addNumber(externalId: string, name: string, purpose: string | null) {
    const data = {
      organisationId: ORG,
      integrationId: ACCOUNT,
      kind: 'phone_number',
      externalId,
      name,
      purpose,
      isActive: true,
      ownershipKey: `whatsapp_cloud:phone_number:${externalId}`,
    };
    // Upsert, so one failing case cannot cascade into a unique-constraint error
    // in the next and hide what actually broke.
    const asset = await prisma.integrationAsset.upsert({
      where: {
        integrationId_kind_externalId: { integrationId: ACCOUNT, kind: 'phone_number', externalId },
      },
      create: data,
      update: { purpose, isActive: true },
    });
    assetOf.set(externalId, asset.id);
    return asset;
  }

  /** Forget a fixture number, after releasing any thread held on it. */
  async function removeNumber(externalId: string) {
    const id = assetOf.get(externalId);
    if (!id) return;
    await prisma.conversation.updateMany({
      where: { organisationId: ORG, senderAssetId: id },
      data: { senderAssetId: assetOf.get(CUSTOMER_PN) },
    });
    await prisma.storeMessagingRoute.deleteMany({ where: { organisationId: ORG, assetId: id } });
    await prisma.integrationAsset.deleteMany({ where: { id } });
    assetOf.delete(externalId);
  }

  /** The tenant's approved template, as template-sync records it after Meta. */
  async function syncTemplate(verifiedAt: Date = new Date()) {
    return prisma.integrationAsset.create({
      data: {
        organisationId: ORG,
        integrationId: ACCOUNT,
        kind: 'message_template',
        externalId: `${TEMPLATE}:en`,
        name: TEMPLATE,
        isActive: true,
        lastVerifiedAt: verifiedAt,
        metadata: {
          channel: 'whatsapp',
          languageCode: 'en',
          category: 'utility',
          providerStatus: 'APPROVED',
          providerSyncedAt: verifiedAt.toISOString(),
        },
      },
    });
  }
  const unsyncTemplate = () =>
    prisma.integrationAsset.deleteMany({ where: { organisationId: ORG, kind: 'message_template' } });

  const sendPdf = (body: Record<string, unknown> = {}) =>
    request(server()).post(`/quotes/${quoteId}/send-pdf`).set(auth()).send(body);

  /** How long is the customer-care window open on this thread. */
  const window = (open: boolean) =>
    prisma.conversation.updateMany({
      where: { organisationId: ORG },
      data: { lastInboundAt: open ? new Date(Date.now() - 3_600_000) : new Date(Date.now() - 30 * 3_600_000) },
    });

  /**
   * Run the delivery worker with the provider replaced, and return the Graph
   * calls it made. The URL carries the phone-number id the message was sent
   * FROM, which is what every assertion about the sender reads.
   */
  async function deliver(): Promise<{ url: string; body: unknown }[]> {
    const { JobsService } = await import('../src/jobs/jobs.service');
    const calls: { url: string; body: unknown }[] = [];
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      calls.push({ url: target, body: init?.body });
      if (target.endsWith('/media')) {
        return new Response(JSON.stringify({ id: 'media-fixture' }), { status: 200 });
      }
      if (target.endsWith('/messages')) {
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls.length}` }] }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 200 });
    });
    try {
      await app.get(JobsService).drain(5);
    } finally {
      spy.mockRestore();
    }
    return calls.filter((c) => c.url.includes('/media') || c.url.includes('/messages'));
  }

  /** The JSON the provider was asked to send, from the /messages call. */
  const messagePayload = (calls: { url: string; body: unknown }[]) =>
    JSON.parse(String(calls.find((c) => c.url.endsWith('/messages'))!.body)) as {
      to: string;
      type: string;
      template?: { name: string; language: { code: string }; components: { type: string; parameters: unknown[] }[] };
      document?: { id: string; filename: string };
    };

  beforeAll(async () => {
    privateDir = mkdtempSync(join(tmpdir(), 'eclat-quote-send-'));
    process.env.PRIVATE_UPLOAD_DIR = privateDir;

    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { WhatsAppCredentialsService } = await import(
      '../src/integrations/whatsapp-credentials.service'
    );
    const { CredentialCrypto } = await import('../src/integration/framework/credential-crypto');

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(P);
    credentials = app.get(WhatsAppCredentialsService);
    const crypto = app.get(CredentialCrypto);
    await teardown(prisma);

    await prisma.organisation.create({
      data: {
        id: ORG,
        name: 'Eclat Fixture',
        legalName: 'Eclat Fixture Jewels',
        slug: 'qsend',
        industryPackCode: 'jewellery',
        gstin: '24ABCDE1234F1Z5',
      },
    });
    await prisma.store.create({
      data: {
        id: STORE,
        name: 'Shopfront',
        city: 'Mumbai',
        organisationId: ORG,
        addressLine1: '1 Linking Road',
        state: 'Maharashtra',
        pincode: '400050',
        timezone: 'Asia/Kolkata',
      },
    });
    await prisma.user.create({
      data: {
        id: 'u_qsend_ho',
        email: HO,
        name: 'Head Office',
        role: 'head_office',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        isActive: true,
        approvalStatus: 'approved',
        organisationId: ORG,
        userStores: { create: { storeId: STORE, isPrimary: true } },
      },
    });

    await prisma.integration.create({
      data: {
        id: ACCOUNT,
        organisationId: ORG,
        providerCode: 'whatsapp_cloud',
        name: 'Eclat WABA',
        status: 'connected',
      },
    });
    await prisma.integrationCredential.create({
      data: {
        organisationId: ORG,
        integrationId: ACCOUNT,
        kind: 'access_token',
        ...crypto.encrypt('fixture-token', {
          organisationId: ORG,
          integrationId: ACCOUNT,
          kind: 'access_token',
        }),
      },
    });
    // The live shape: two numbers on one account, one of them the staff line.
    await addNumber(CUSTOMER_PN, 'Eclat diamonds and Company', null);
    await addNumber(INTERNAL_PN, 'Eclat diamonds Internal', 'internal');
    await syncTemplate();

    token = (
      await request(server()).post('/auth/login').send({ email: HO, password: PASSWORD }).expect(201)
    ).body.token;

    const quote = await request(server())
      .post('/quotes')
      .set(auth())
      .send({
        storeId: STORE,
        customerName: 'Quote Customer',
        phone: CUSTOMER,
        validUntil: '2026-11-30',
        lines: [LINE],
      })
      .expect(201);
    quoteId = quote.body.id;
    quoteRef = quote.body.ref;
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
    if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  });

  /* ======================================================== which number */

  it('resolves the shopfront number for a customer, and refuses to guess without the audience', async () => {
    const forCustomer = await credentials.senderFor(ORG, { storeId: STORE, audience: 'customer' });
    expect(forCustomer.usable).toBe(true);
    expect(forCustomer.phoneNumberId).toBe(CUSTOMER_PN);
    expect(forCustomer.assetId).toBe(assetOf.get(CUSTOMER_PN));

    // The same tenant, same branch, with nothing said about who the message is
    // for: two numbers and no route is still an honest refusal.
    const unqualified = await credentials.senderFor(ORG, { storeId: STORE });
    expect(unqualified.usable).toBe(false);
    expect(unqualified.reason).toContain('2 WhatsApp numbers');
  });

  it('sends the PDF from the customer-facing number, on the approved template', async () => {
    const res = await sendPdf();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      queued: true,
      ref: quoteRef,
      dryRun: false,
      template: { name: TEMPLATE, languageCode: 'en' },
      templateUnavailable: null,
    });

    const calls = await deliver();
    // The media upload and the message both address the SHOPFRONT number's id.
    expect(calls.map((c) => c.url.replace(/^.*graph\.facebook\.com/, ''))).toEqual([
      expect.stringContaining(`/${CUSTOMER_PN}/media`),
      expect.stringContaining(`/${CUSTOMER_PN}/messages`),
    ]);
    expect(calls.some((c) => c.url.includes(INTERNAL_PN))).toBe(false);

    const payload = messagePayload(calls);
    expect(payload.to).toBe(CUSTOMER);
    expect(payload.type).toBe('template');
    expect(payload.template?.name).toBe(TEMPLATE);
    expect(payload.template?.language.code).toBe('en');
    // The PDF rides in the template's DOCUMENT header; the quote's facts fill
    // the five body parameters, in the order the approved wording uses.
    const header = payload.template?.components.find((c) => c.type === 'header');
    expect(header?.parameters).toEqual([
      { type: 'document', document: { id: 'media-fixture', filename: `${quoteRef}-r1.pdf` } },
    ]);
    const body = payload.template?.components.find((c) => c.type === 'body');
    expect((body?.parameters as { text: string }[]).map((p) => p.text)[1]).toBe(quoteRef);
    expect(body?.parameters).toHaveLength(5);

    const message = await prisma.message.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(message.status).toBe('sent');
    expect(message.externalId).toBeTruthy();
  });

  it('answers from the customer line even when the thread is pinned to the staff line', async () => {
    // A thread can be pinned to the internal number by an inbound message that
    // landed there. A reply normally MUST leave from the pinned number — but
    // not when the pinned number is one a customer may not be messaged from.
    await prisma.conversation.updateMany({
      where: { organisationId: ORG, externalThreadId: CUSTOMER },
      data: { senderAssetId: assetOf.get(INTERNAL_PN) },
    });
    const res = await sendPdf();
    expect(res.status).toBe(201);
    const calls = await deliver();
    expect(calls.every((c) => c.url.includes(CUSTOMER_PN))).toBe(true);
    expect(calls.some((c) => c.url.includes(INTERNAL_PN))).toBe(false);

    await prisma.conversation.updateMany({
      where: { organisationId: ORG, externalThreadId: CUSTOMER },
      data: { senderAssetId: assetOf.get(CUSTOMER_PN) },
    });
  });

  it('ignores a branch mapped to the staff line rather than messaging a customer from it', async () => {
    // The mapping table is also the INBOUND half of routing, so a route naming
    // the internal number is legitimate — it just cannot answer "which number
    // does this customer hear from".
    await prisma.storeMessagingRoute.create({
      data: {
        organisationId: ORG,
        storeId: STORE,
        channel: 'whatsapp',
        integrationId: ACCOUNT,
        assetId: assetOf.get(INTERNAL_PN)!,
        createdById: 'u_qsend_ho',
      },
    });
    const sender = await credentials.senderFor(ORG, { storeId: STORE, audience: 'customer' });
    expect(sender.phoneNumberId).toBe(CUSTOMER_PN);
    expect(sender.resolvedBy).toBe('only_number');

    const res = await sendPdf();
    expect(res.status).toBe(201);
    const calls = await deliver();
    expect(calls.some((c) => c.url.includes(INTERNAL_PN))).toBe(false);
    expect(calls.some((c) => c.url.includes(CUSTOMER_PN))).toBe(true);

    await prisma.storeMessagingRoute.deleteMany({ where: { organisationId: ORG } });
  });

  it('honours the branch route when it names a customer-facing number', async () => {
    const second = await addNumber(SECOND_PN, 'Second shopfront', null);
    await prisma.storeMessagingRoute.create({
      data: {
        organisationId: ORG,
        storeId: STORE,
        channel: 'whatsapp',
        integrationId: ACCOUNT,
        assetId: second.id,
        createdById: 'u_qsend_ho',
      },
    });
    const sender = await credentials.senderFor(ORG, { storeId: STORE, audience: 'customer' });
    expect(sender.phoneNumberId).toBe(SECOND_PN);
    expect(sender.resolvedBy).toBe('store_route');

    // An outbound-first thread with no number of its own: the branch's route is
    // what decides, which is the case the route exists for. A thread that HAS
    // one keeps it (the test above), because that is where the customer's
    // 24-hour window lives.
    await prisma.conversation.updateMany({
      where: { organisationId: ORG, externalThreadId: CUSTOMER },
      data: { senderAssetId: null },
    });
    const res = await sendPdf();
    expect(res.status).toBe(201);
    const calls = await deliver();
    expect(calls.every((c) => c.url.includes(SECOND_PN))).toBe(true);

    await removeNumber(SECOND_PN);
  });

  /* ====================================================== clear refusals */

  it('refuses, naming the branch, when two customer-facing numbers are unrouted', async () => {
    await addNumber(SECOND_PN, 'Second shopfront', null);
    const before = await prisma.message.count({ where: { organisationId: ORG } });

    const res = await sendPdf();
    expect(res.status).toBe(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('2 customer-facing WhatsApp numbers');
    expect(said).toContain('this branch has no sender mapped to it');
    // Nothing queued: a message that cannot leave must not sit in an outbox
    // looking sent.
    expect(await prisma.message.count({ where: { organisationId: ORG } })).toBe(before);

    await removeNumber(SECOND_PN);
  });

  it('refuses, naming the classification, when every number is a staff line', async () => {
    await prisma.integrationAsset.updateMany({
      where: { organisationId: ORG, kind: 'phone_number' },
      data: { purpose: 'internal' },
    });
    const before = await prisma.message.count({ where: { organisationId: ORG } });

    const res = await sendPdf();
    expect(res.status).toBe(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('marked as internal staff lines');
    expect(said).toContain('customer-facing');
    expect(await prisma.message.count({ where: { organisationId: ORG } })).toBe(before);

    // The text summary door answers the same way, rather than reporting the
    // connection as missing.
    const shared = await request(server()).post(`/quotes/${quoteId}/share`).set(auth()).send({});
    expect(shared.status).toBe(400);
    expect(JSON.stringify(shared.body)).toContain('marked as internal staff lines');

    await prisma.integrationAsset.updateMany({
      where: { organisationId: ORG, kind: 'phone_number', externalId: CUSTOMER_PN },
      data: { purpose: null },
    });
  });

  it('still queues, with the real reason, when the number is fine but its token is not', async () => {
    // A broken or expired credential is NOT a refusal: the message waits in the
    // outbox with the reason against it and sends on a retry once the token is
    // replaced, which is how a tenant brings a number live without re-entering
    // every quote. What it must not do is claim to have sent.
    await prisma.integrationCredential.updateMany({
      where: { organisationId: ORG, integrationId: ACCOUNT, kind: 'access_token' },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });
    const res = await sendPdf();
    expect(res.status).toBe(201);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.senderReason).toContain('expired');

    const calls = await deliver();
    expect(calls).toHaveLength(0);
    const message = await prisma.message.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(message.status).not.toBe('sent');
    expect(message.error).toBeTruthy();

    await prisma.integrationCredential.updateMany({
      where: { organisationId: ORG, integrationId: ACCOUNT, kind: 'access_token' },
      data: { expiresAt: null },
    });
  });

  /* ========================================================== the template */

  it('names the missing sync when the window is shut and the template is not recorded here', async () => {
    await unsyncTemplate();
    await window(false);
    const res = await sendPdf();
    expect(res.status).toBe(400);
    const said = JSON.stringify(res.body);
    // Both halves: the rule, and the reason the business's own approved
    // template is not satisfying it.
    expect(said).toContain('outside the 24-hour customer-care window');
    expect(said).toContain(TEMPLATE);
    expect(said).toContain('Synchronise templates');
  });

  it('says the verdict is stale rather than attaching a template queue() would refuse', async () => {
    // A provider verdict older than a day fails closed everywhere else; the
    // quote send used to attach it anyway, turning a send that would have
    // worked inside the window into a hard refusal with no explanation.
    await unsyncTemplate();
    await syncTemplate(new Date(Date.now() - 30 * 3_600_000));
    await window(false);
    const res = await sendPdf();
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('out of date');
  });

  it('still sends inside the window with no template, and says the template is missing', async () => {
    await unsyncTemplate();
    await window(true);
    const res = await sendPdf();
    expect(res.status).toBe(201);
    expect(res.body.template).toBeNull();
    expect(res.body.templateUnavailable).toContain('has not been recorded');

    const calls = await deliver();
    expect(messagePayload(calls).type).toBe('document');
    expect(calls.every((c) => c.url.includes(CUSTOMER_PN))).toBe(true);
    await syncTemplate();
  });

  /* ========================================================= the recipient */

  it('messages the number typed at send time, Indian or foreign', async () => {
    const indian = await sendPdf({ to: '9822200111' });
    expect(indian.status).toBe(201);
    expect(messagePayload(await deliver()).to).toBe('919822200111');

    // PR #43 let a quote hold an international customer; the send has to reach
    // them. The India-first normaliser downstream rejects bare foreign digits,
    // so the leading + has to survive all the way here.
    const foreign = await sendPdf({ to: '+971551234567' });
    expect(foreign.status).toBe(201);
    expect(messagePayload(await deliver()).to).toBe('971551234567');
  });

  it('refuses a number that is not dialable, before anything is queued', async () => {
    const before = await prisma.message.count({ where: { organisationId: ORG } });
    const res = await sendPdf({ to: '12345' });
    expect(res.status).toBe(400);
    expect(await prisma.message.count({ where: { organisationId: ORG } })).toBe(before);
  });
});
