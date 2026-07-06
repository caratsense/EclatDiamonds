import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * Integrations (Phase 4) regression suite — WhatsApp / Razorpay / gold-rate.
 *
 * With no credentials set (the dev/CI default), every integration MUST:
 *   - report itself as not-live via GET /integrations/status,
 *   - perform a safe `dryRun` no-op instead of calling a provider, and
 *   - still enforce auth, RBAC, store-scoping and webhook signature checks.
 *
 * This proves the module is "code-complete behind env keys": it never crashes or
 * leaks when unconfigured, and the security gates hold regardless.
 */

const PASSWORD = 'password123';
const REP = 'priya.rep@caratsense.in'; // salesperson, Surat — Main
const MANAGER = 'aarav.mehta@caratsense.in'; // store_manager, Surat — Main

const SURAT = 'surat-main';
const MUMBAI = 'mumbai-bandra'; // out of Priya's (Surat) scope

describe('Eclat backend — integrations (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // rawBody mirrors main.ts so webhook signature verification sees real bytes.
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    for (const [key, email] of [
      ['rep', REP],
      ['manager', MANAGER],
    ] as const) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(201);
      tokens[key] = res.body.token;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------------ status
  describe('GET /integrations/status', () => {
    it('requires auth', async () => {
      const res = await request(app.getHttpServer()).get('/integrations/status');
      expect(res.status).toBe(401);
    });

    it('reports every integration as not-live when no credentials are set', async () => {
      const res = await request(app.getHttpServer())
        .get('/integrations/status')
        .set(auth(tokens.rep));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ whatsapp: false, razorpay: false, goldRate: false });
    });
  });

  // ---------------------------------------------------------------- WhatsApp
  describe('WhatsApp', () => {
    it('send is a dry-run no-op (and normalises the Indian number)', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/whatsapp/send')
        .set(auth(tokens.rep))
        .send({ to: '9876543210', body: 'Your CaratSense quote is ready.' });
      expect(res.status).toBe(201);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.delivered).toBe(false);
      expect(res.body.to).toBe('919876543210');
    });

    it('rejects unknown body fields (mass-assignment guard)', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/whatsapp/send')
        .set(auth(tokens.rep))
        .send({ to: '9876543210', body: 'hi', adminOverride: true });
      expect(res.status).toBe(400);
    });

    it('webhook verification echoes the challenge only with the right token', async () => {
      // No WHATSAPP_WEBHOOK_VERIFY_TOKEN configured -> any handshake is rejected.
      const res = await request(app.getHttpServer())
        .get('/integrations/whatsapp/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1234' });
      expect(res.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------- Razorpay
  describe('Razorpay', () => {
    it('payment link for an out-of-scope store -> 403', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/razorpay/payment-link')
        .set(auth(tokens.rep))
        .send({ amount: 5000, customerName: 'Test', storeId: MUMBAI });
      expect(res.status).toBe(403);
    });

    it('payment link for an in-scope store -> dry-run stub link', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/razorpay/payment-link')
        .set(auth(tokens.rep))
        .send({ amount: 5000, customerName: 'Test', storeId: SURAT });
      expect(res.status).toBe(201);
      expect(res.body.dryRun).toBe(true);
      expect(typeof res.body.shortUrl).toBe('string');
    });

    it('webhook without a valid signature -> 403 (no payment recorded)', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/razorpay/webhook')
        .send({ event: 'payment.captured', payload: {} });
      expect(res.status).toBe(403);
    });
  });

  // --------------------------------------------------------------- Gold rate
  describe('Gold rate', () => {
    it('current rates returns an array (auth required)', async () => {
      const res = await request(app.getHttpServer())
        .get('/integrations/gold-rate')
        .set(auth(tokens.rep));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('refresh is manager+ only', async () => {
      const repRes = await request(app.getHttpServer())
        .post('/integrations/gold-rate/refresh')
        .set(auth(tokens.rep));
      expect(repRes.status).toBe(403);

      const mgrRes = await request(app.getHttpServer())
        .post('/integrations/gold-rate/refresh')
        .set(auth(tokens.manager));
      expect(mgrRes.status).toBe(201);
      expect(mgrRes.body.dryRun).toBe(true); // no feed configured
    });
  });
});
