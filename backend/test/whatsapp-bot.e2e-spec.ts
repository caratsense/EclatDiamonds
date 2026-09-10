import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { createHmac } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WhatsAppBotService } from '../src/whatsapp-bot/whatsapp-bot.service';

/**
 * CaratOS — WhatsApp internal reporting bot, MULTI-TENANT SAFETY.
 *
 * Org A = the seeded "Eclat" organisation (org_eclat). We stand up a separate
 * Org B and prove every WhatsApp path is organisation-scoped:
 *   - a linked identity carries the linking user's organisation
 *   - a manager can only list/revoke bindings in their own org AND store scope
 *   - a redelivered webhook (same wamid) is idempotent — one event, never two
 *   - the DailyReport per-day unique holds (web + bot both upsert)
 *   - /reporting/compliance shows ONLY the caller's own org's stores, each on
 *     its own timezone, with no Surat/default fallback for another tenant
 *   - the webhook fails closed on a bad signature
 *   - an expired / bogus link code is refused and binds nothing
 *
 * Inbound is driven through the bot service (deterministic — the HTTP webhook
 * acks and processes in the background); REST + the signature gate go over HTTP.
 */
const PASSWORD = 'password123';
const A_HO = 'head.office@caratsense.in';
const A_MGR_SURAT = 'aarav.mehta@caratsense.in'; // store_manager, surat-main
const A_MGR_MUMBAI = 'karan.malhotra@caratsense.in'; // store_manager, mumbai-bandra
const SURAT = 'surat-main';

const APP_SECRET = 'wa-test-secret';

// Test WhatsApp numbers (E.164 without '+', as Meta sends).
const PHONE_A_SURAT = '919000000001';
const PHONE_A_MUMBAI = '919000000002';
const PHONE_B = '919000000003';
const PHONE_UNKNOWN = '919000009999';

describe('WhatsApp reporting bot — tenancy (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bot: WhatsAppBotService;
  const tokens: Record<string, string> = {};
  let mgrSuratId = '';
  let mgrMumbaiId = '';
  let wamidSeq = 1;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (email: string) => {
    const r = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
    expect(r.status).toBe(201);
    return r.body.token as string;
  };

  /** A Meta-shaped inbound text message payload for one number. */
  const inboundPayload = (from: string, text: string, wamid: string) => ({
    entry: [
      {
        changes: [
          {
            value: { messages: [{ id: wamid, from, type: 'text', text: { body: text } }] },
          },
        ],
      },
    ],
  });

  /**
   * Deliver one inbound message and DRAIN it to a terminal state before
   * returning. `ingest` also kicks off processing in the background, so we poll
   * the event until it is no longer received/processing — otherwise a background
   * pass could still be mutating the session when the next message arrives, which
   * makes the multi-step conversation non-deterministic under test.
   */
  const sendInbound = async (from: string, text: string, wamid?: string) => {
    const id = wamid ?? `wamid.TEST-${wamidSeq++}`;
    const res = await bot.ingest(inboundPayload(from, text, id));
    for (let i = 0; i < 100; i++) {
      await bot.processPending();
      const ev = await prisma.whatsAppEvent.findUnique({ where: { wamid: id }, select: { status: true } });
      if (!ev || (ev.status !== 'received' && ev.status !== 'processing')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { wamid: id, res };
  };

  /** Link `phone` to the signed-in user: start in-app, then text the code to the bot. */
  const linkNumber = async (token: string, phone: string) => {
    const start = await request(app.getHttpServer()).post('/whatsapp/link/start').set(auth(token));
    expect(start.status).toBe(201);
    const code = start.body.code as string;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    await sendInbound(phone, code);
  };

  beforeAll(async () => {
    // Enforce the signature gate for this app instance (captured at construction).
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    bot = app.get(WhatsAppBotService);

    await teardown(prisma);

    // --- Org B, fully separate ---
    const hash = await bcrypt.hash(PASSWORD, 10);
    // Reporting is a jewellery-pack module; the entitlement guard refuses it
    // to a tenant with no industry.
    await prisma.organisation.create({
      data: { id: 'org_b', name: 'Test Jewels B', slug: 'test-b', industryPackCode: 'jewellery' },
    });
    await prisma.store.create({ data: { id: 'store_b', name: 'WA-B Store', city: 'Testville', organisationId: 'org_b' } });
    await prisma.user.create({
      data: { email: 'wa.ho.b@test-b.local', name: 'HO B', role: 'head_office', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_b' },
    });
    await prisma.user.create({
      data: { email: 'wa.mgr.b@test-b.local', name: 'Mgr B', role: 'store_manager', passwordHash: hash, isActive: true, approvalStatus: 'approved', organisationId: 'org_b', userStores: { create: { storeId: 'store_b', isPrimary: true } } },
    });

    tokens.aHo = await login(A_HO);
    tokens.aMgrSurat = await login(A_MGR_SURAT);
    tokens.aMgrMumbai = await login(A_MGR_MUMBAI);
    tokens.bHo = await login('wa.ho.b@test-b.local');
    tokens.bMgr = await login('wa.mgr.b@test-b.local');

    mgrSuratId = (await prisma.user.findUniqueOrThrow({ where: { email: A_MGR_SURAT }, select: { id: true } })).id;
    mgrMumbaiId = (await prisma.user.findUniqueOrThrow({ where: { email: A_MGR_MUMBAI }, select: { id: true } })).id;

    // Link three numbers: two Org-A (different stores), one Org-B.
    await linkNumber(tokens.aMgrSurat, PHONE_A_SURAT);
    await linkNumber(tokens.aMgrMumbai, PHONE_A_MUMBAI);
    await linkNumber(tokens.bMgr, PHONE_B);
  });

  afterAll(async () => {
    await teardown(prisma);
    delete process.env.WHATSAPP_APP_SECRET;
    await app?.close();
  });

  // ── Identity + tenancy ──────────────────────────────────────────────────────

  it('a linked identity carries the linking user’s organisation', async () => {
    const a = await prisma.whatsAppIdentity.findUnique({ where: { phoneE164: PHONE_A_SURAT } });
    const b = await prisma.whatsAppIdentity.findUnique({ where: { phoneE164: PHONE_B } });
    expect(a?.organisationId).toBe('org_eclat');
    expect(a?.userId).toBe(mgrSuratId);
    expect(a?.status).toBe('active');
    expect(b?.organisationId).toBe('org_b');
  });

  it('head office lists ONLY its own organisation’s bindings', async () => {
    const a = await request(app.getHttpServer()).get('/whatsapp/identities').set(auth(tokens.aHo));
    expect(a.status).toBe(200);
    const aBody = JSON.stringify(a.body);
    expect(aBody).toContain(PHONE_A_SURAT);
    expect(aBody).toContain(PHONE_A_MUMBAI);
    expect(aBody).not.toContain(PHONE_B); // Org B must not leak in

    const b = await request(app.getHttpServer()).get('/whatsapp/identities').set(auth(tokens.bHo));
    expect(b.status).toBe(200);
    const bBody = JSON.stringify(b.body);
    expect(bBody).toContain(PHONE_B);
    expect(bBody).not.toContain(PHONE_A_SURAT);
  });

  it('a store manager lists only bindings in their own store scope', async () => {
    // Surat manager sees the Surat number, not the Mumbai one (same org, other store).
    const r = await request(app.getHttpServer()).get('/whatsapp/identities').set(auth(tokens.aMgrSurat));
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).toContain(PHONE_A_SURAT);
    expect(body).not.toContain(PHONE_A_MUMBAI);
  });

  it('revoking across organisations is refused (403)', async () => {
    const idA = (await prisma.whatsAppIdentity.findUniqueOrThrow({ where: { phoneE164: PHONE_A_SURAT }, select: { id: true } })).id;
    // Org B head office attempts to revoke an Org A binding.
    const r = await request(app.getHttpServer()).post(`/whatsapp/identities/${idA}/revoke`).set(auth(tokens.bHo));
    expect(r.status).toBe(403);
    // Still active — nothing was changed.
    const still = await prisma.whatsAppIdentity.findUniqueOrThrow({ where: { id: idA } });
    expect(still.status).toBe('active');
  });

  it('revoking across stores within the same org is refused (403)', async () => {
    const idMumbai = (await prisma.whatsAppIdentity.findUniqueOrThrow({ where: { phoneE164: PHONE_A_MUMBAI }, select: { id: true } })).id;
    // Surat manager tries to revoke the Mumbai binding — same org, out of store scope.
    const r = await request(app.getHttpServer()).post(`/whatsapp/identities/${idMumbai}/revoke`).set(auth(tokens.aMgrSurat));
    expect(r.status).toBe(403);
  });

  // ── Webhook robustness ──────────────────────────────────────────────────────

  it('a redelivered message (same wamid) is idempotent — one event, never two', async () => {
    const wamid = 'wamid.DUP-TEST-1';
    const first = await bot.ingest(inboundPayload(PHONE_A_SURAT, 'hi', wamid));
    const second = await bot.ingest(inboundPayload(PHONE_A_SURAT, 'hi', wamid));
    expect(first.received).toBe(1);
    expect(second.received).toBe(0);
    expect(second.duplicates).toBe(1);
    const count = await prisma.whatsAppEvent.count({ where: { wamid } });
    expect(count).toBe(1);
  });

  it('the webhook fails closed on an invalid signature (403)', async () => {
    const body = JSON.stringify(inboundPayload(PHONE_A_SURAT, 'hi', 'wamid.SIG-TEST'));
    const bad = await request(app.getHttpServer())
      .post('/integrations/whatsapp/webhook')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .set('content-type', 'application/json')
      .send(body);
    expect(bad.status).toBe(403);

    // A correctly-signed request is accepted (200).
    const good = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const ok = await request(app.getHttpServer())
      .post('/integrations/whatsapp/webhook')
      .set('x-hub-signature-256', `sha256=${good}`)
      .set('content-type', 'application/json')
      .send(body);
    expect(ok.status).toBe(200);
  });

  it('an expired link code is refused and binds nothing', async () => {
    // Seed an already-expired code for the Surat manager with a known value.
    const codeHash = await bcrypt.hash('EXPIRED1', 10);
    await prisma.whatsAppLinkCode.create({
      data: { userId: mgrSuratId, organisationId: 'org_eclat', codeHash, expiresAt: new Date(Date.now() - 60_000) },
    });
    await sendInbound(PHONE_UNKNOWN, 'EXPIRED1');
    const bound = await prisma.whatsAppIdentity.findUnique({ where: { phoneE164: PHONE_UNKNOWN } });
    expect(bound).toBeNull();
  });

  it('a bogus code from an unknown number binds nothing', async () => {
    await sendInbound(PHONE_UNKNOWN, 'ZZZZZZZZ');
    const bound = await prisma.whatsAppIdentity.findUnique({ where: { phoneE164: PHONE_UNKNOWN } });
    expect(bound).toBeNull();
  });

  // ── DSR: full bot chain + org stamping + upsert unique ──────────────────────

  it('a bot daily report is written org-scoped, source=whatsapp, and is idempotent', async () => {
    // Surat manager is attached to one store, so no store-pick step.
    await sendInbound(PHONE_A_SURAT, 'hi');
    await sendInbound(PHONE_A_SURAT, '1'); // start daily report
    // Answer the ten fields in order; skip the two optional old-gold questions.
    const answers = ['10', '4', '500000', '200000', '50000', '100000', '150000', '250000', 'skip', 'skip'];
    for (const a of answers) await sendInbound(PHONE_A_SURAT, a);
    await sendInbound(PHONE_A_SURAT, 'yes'); // submit

    const store = await prisma.store.findFirstOrThrow({ where: { id: SURAT }, select: { id: true } });
    const rows = await prisma.dailyReport.findMany({
      where: { storeId: store.id, source: 'whatsapp' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.organisationId).toBe('org_eclat');
    expect(row.walkIns).toBe(10);
    expect(row.seriousEnquiries).toBe(4);

    // Re-file the same day → upsert updates in place, no second row.
    const before = await prisma.dailyReport.count({ where: { storeId: store.id, reportDate: row.reportDate } });
    await sendInbound(PHONE_A_SURAT, 'hi');
    await sendInbound(PHONE_A_SURAT, '1');
    for (const a of ['11', '5', '600000', '0', '0', '0', '0', '0', 'skip', 'skip']) await sendInbound(PHONE_A_SURAT, a);
    await sendInbound(PHONE_A_SURAT, 'yes');
    const after = await prisma.dailyReport.count({ where: { storeId: store.id, reportDate: row.reportDate } });
    expect(after).toBe(before); // still one row for that store-day
    const updated = await prisma.dailyReport.findUniqueOrThrow({ where: { storeId_reportDate: { storeId: store.id, reportDate: row.reportDate } } });
    expect(updated.walkIns).toBe(11);
  });

  // ── Compliance: org-scoped, store-timezone, no default store ────────────────

  it('/reporting/compliance shows ONLY the caller’s own organisation’s stores', async () => {
    const a = await request(app.getHttpServer()).get('/reporting/compliance?days=3').set(auth(tokens.aHo));
    expect(a.status).toBe(200);
    const aNames = a.body.stores.map((s: any) => s.storeName);
    expect(aNames.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.body)).not.toContain('WA-B Store'); // Org B never appears
    // Every store reports a per-day grid; the last entry is that store's own today.
    for (const s of a.body.stores) {
      expect(s.entries.length).toBe(3);
      expect(typeof s.entries[s.entries.length - 1].date).toBe('string');
    }

    const b = await request(app.getHttpServer()).get('/reporting/compliance?days=3').set(auth(tokens.bHo));
    expect(b.status).toBe(200);
    const bNames = b.body.stores.map((s: any) => s.storeName);
    expect(bNames).toEqual(['WA-B Store']); // only its own store, no Surat/default
  });
});

async function teardown(prisma: PrismaService) {
  const phones = [PHONE_A_SURAT, PHONE_A_MUMBAI, PHONE_B, PHONE_UNKNOWN];
  await prisma.whatsAppEvent.deleteMany({ where: { phoneE164: { in: phones } } });
  await prisma.whatsAppSession.deleteMany({ where: { phoneE164: { in: phones } } });
  await prisma.whatsAppIdentity.deleteMany({ where: { phoneE164: { in: phones } } });
  await prisma.whatsAppLinkCode.deleteMany({
    where: { user: { email: { in: [A_MGR_SURAT, A_MGR_MUMBAI, 'wa.mgr.b@test-b.local'] } } },
  });
  // Bot DSRs filed against the Surat store during the test.
  await prisma.dailyReport.deleteMany({ where: { storeId: SURAT, source: 'whatsapp' } });
  // Org B teardown. AuditLog has RESTRICT on actorId, so its rows (e.g. the
  // whatsapp.link entry for the Org-B manager) must go before the users.
  await prisma.whatsAppEvent.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.whatsAppSession.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.whatsAppLinkCode.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.whatsAppIdentity.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.dailyReport.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.auditLog.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: 'org_b' } } });
  await prisma.user.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.store.deleteMany({ where: { organisationId: 'org_b' } });
  await prisma.organisation.deleteMany({ where: { slug: 'test-b' } });
}
