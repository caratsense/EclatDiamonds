import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * Module 10 — DSR (Daily Sales Report) create/file backend validation.
 * Boots the real app against the seeded eclat DB. Covers the QA-sheet fixes:
 *   - no silent store default when an "All Stores" caller files a DSR
 *   - footfall funnel (serious enquiries <= walk-ins) + no future business date
 *   - outbound recipient validation on the "send report" path
 */
const PASSWORD = 'password123';
const MANAGER = 'aarav.mehta@caratsense.in'; // store_manager, Surat
const HO = 'head.office@caratsense.in'; // head_office, all stores
const SURAT = 'surat-main';

describe('DSR create/file validation (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = (email: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
  const daily = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/reporting/daily').set(auth(token)).send(body);

  const yesterday = () => {
    const d = new Date(Date.now() - 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    for (const [k, e] of [['manager', MANAGER], ['ho', HO]] as const) {
      const r = await login(e);
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Req 2: no silent default to a single store ─────────────────────────────
  it('head office filing with storeId "all" -> 400 (must pick a concrete store)', async () => {
    const res = await daily(tokens.ho, { storeId: 'all', reportDate: yesterday(), walkIns: 5 });
    expect(res.status).toBe(400);
  });

  it('head office filing with empty storeId -> 400', async () => {
    const res = await daily(tokens.ho, { storeId: '', reportDate: yesterday(), walkIns: 5 });
    expect(res.status).toBe(400);
  });

  it('head office filing with a concrete store -> created', async () => {
    const res = await daily(tokens.ho, {
      storeId: SURAT,
      reportDate: yesterday(),
      walkIns: 10,
      seriousEnquiries: 3,
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.id).toBeTruthy();
    expect(res.body.storeId).toBe(SURAT);
    // Filed in the app, which head office tells apart from the WhatsApp bot.
    expect(res.body.source).toBe('web');
  });

  // ── Req 3: footfall funnel + future date ───────────────────────────────────
  it('serious enquiries > walk-ins -> 400', async () => {
    const res = await daily(tokens.manager, {
      storeId: SURAT,
      reportDate: yesterday(),
      walkIns: 4,
      seriousEnquiries: 9,
    });
    expect(res.status).toBe(400);
  });

  it('future report date -> 400', async () => {
    const res = await daily(tokens.manager, { storeId: SURAT, reportDate: '2099-01-01', walkIns: 1 });
    expect(res.status).toBe(400);
  });

  // ── Req 1: outbound recipient validation on the send path ──────────────────
  it('sending a DSR to a garbage phone via WhatsApp -> 400', async () => {
    const created = await daily(tokens.manager, { storeId: SURAT, reportDate: yesterday(), walkIns: 2 });
    expect([200, 201]).toContain(created.status);
    const res = await request(app.getHttpServer())
      .post(`/reporting/daily/${created.body.id}/send`)
      .set(auth(tokens.manager))
      .send({ channel: 'whatsapp', to: '98@#$-not-a-number' });
    expect(res.status).toBe(400);
  });

  it('sending a DSR to a valid mobile passes validation (not 400)', async () => {
    const created = await daily(tokens.manager, { storeId: SURAT, reportDate: yesterday(), walkIns: 2 });
    expect([200, 201]).toContain(created.status);
    const res = await request(app.getHttpServer())
      .post(`/reporting/daily/${created.body.id}/send`)
      .set(auth(tokens.manager))
      .send({ channel: 'whatsapp', to: '+91 98765 43210' });
    expect(res.status).not.toBe(400);
  });
});
