import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * Critical-path regression suite for the Eclat backend.
 *
 * Boots the REAL Nest app against the seeded `eclat_dev` DB and exercises the
 * security / scoping / pricing rules that must never silently regress:
 *   1. Auth (JWT, 401s, /auth/me)
 *   2. Store-scoping (the #1 rule)
 *   3. RBAC role gating
 *   4. Discount ceilings + mass-assignment guard (M15)
 *   5. Quote pricing math (M2, exact Decimal)
 *
 * Tests log in fresh and assert "rep < HO" rather than fixed counts, so they are
 * deterministic against the seeded data. Created rows use a unique marker.
 */

const PASSWORD = 'password123';
const REP = 'priya.rep@caratsense.in'; // salesperson, Surat — Main
const MANAGER = 'aarav.mehta@caratsense.in'; // store_manager, Surat — Main
const AREA = 'neelam.area@caratsense.in'; // area_manager, West India
const HO = 'head.office@caratsense.in'; // head_office, all stores

const SURAT = 'surat-main';
const MUMBAI = 'mumbai-bandra';
const OOS_LEAD_ID = 'ld-3011'; // a Mumbai lead — out of Priya's (Surat) scope
const SURAT_LEAVE_ID = 'lv-01'; // a leave request in Surat

describe('Eclat backend — critical paths (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};

  async function login(email: string, password = PASSWORD) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res;
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts exactly so the mass-assignment guard behaves in tests.
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
      ['area', AREA],
      ['ho', HO],
    ] as const) {
      const res = await login(email);
      expect(res.status).toBe(201);
      tokens[key] = res.body.token;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------- 1. Auth
  describe('Auth', () => {
    it('login returns a JWT for valid credentials', async () => {
      const res = await login(REP);
      expect(res.status).toBe(201);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.split('.')).toHaveLength(3); // JWT shape
      expect(res.body.role).toBe('salesperson');
    });

    it('bad password -> 401', async () => {
      const res = await login(REP, 'wrong-password');
      expect(res.status).toBe(401);
      expect(res.body.token).toBeUndefined();
    });

    it('unknown user -> 401', async () => {
      const res = await login('nobody@caratsense.in');
      expect(res.status).toBe(401);
    });

    it('/auth/me returns the correct role + stores for the rep', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set(auth(tokens.rep));
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('salesperson');
      const storeIds = res.body.stores.map((s: any) => s.id);
      expect(storeIds).toContain(SURAT);
      expect(storeIds).not.toContain(MUMBAI);
    });

    it('/auth/me for head office sees all stores', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set(auth(tokens.ho));
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('head_office');
      const storeIds = res.body.stores.map((s: any) => s.id);
      expect(storeIds).toContain(SURAT);
      expect(storeIds).toContain(MUMBAI);
    });

    it('protected route without a token -> 401', async () => {
      const res = await request(app.getHttpServer()).get('/leads');
      expect(res.status).toBe(401);
    });

    it('protected route with a garbage token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/leads')
        .set(auth('not.a.jwt'));
      expect(res.status).toBe(401);
    });
  });

  // ----------------------------------------------------- 2. Store-scoping
  describe('Store-scoping (rule #1)', () => {
    it('a salesperson sees FEWER leads than head office, and only their store', async () => {
      const repRes = await request(app.getHttpServer())
        .get('/leads')
        .set(auth(tokens.rep));
      const hoRes = await request(app.getHttpServer())
        .get('/leads')
        .set(auth(tokens.ho));
      expect(repRes.status).toBe(200);
      expect(hoRes.status).toBe(200);

      expect(repRes.body.length).toBeGreaterThan(0);
      expect(repRes.body.length).toBeLessThan(hoRes.body.length);

      // Every row the rep sees belongs to their own store.
      const repStores = new Set(repRes.body.map((l: any) => l.storeId));
      expect([...repStores]).toEqual([SURAT]);
    });

    it('salesperson requesting another store via X-Store-Id -> 403', async () => {
      const res = await request(app.getHttpServer())
        .get('/leads')
        .set(auth(tokens.rep))
        .set('X-Store-Id', MUMBAI);
      expect(res.status).toBe(403);
    });

    it('salesperson requesting their OWN store via X-Store-Id -> 200', async () => {
      const res = await request(app.getHttpServer())
        .get('/leads')
        .set(auth(tokens.rep))
        .set('X-Store-Id', SURAT);
      expect(res.status).toBe(200);
    });

    it('detail route for an out-of-scope lead id -> not leaked (404/403)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/leads/${OOS_LEAD_ID}`)
        .set(auth(tokens.rep));
      expect([403, 404]).toContain(res.status);
      // Must NOT leak the Mumbai customer's data.
      expect(res.body.storeId).not.toBe(MUMBAI);
      expect(res.body.customer).toBeUndefined();
    });

    it('head office CAN read that same lead (proves the id is real, not just missing)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/leads/${OOS_LEAD_ID}`)
        .set(auth(tokens.ho));
      expect(res.status).toBe(200);
      expect(res.body.storeId).toBe(MUMBAI);
    });
  });

  // ------------------------------------------------------------- 3. RBAC
  describe('RBAC role gating (rule #2)', () => {
    it('salesperson GET /finance/summary -> 403', async () => {
      const res = await request(app.getHttpServer())
        .get('/finance/summary')
        .set(auth(tokens.rep));
      expect(res.status).toBe(403);
    });

    it('store manager GET /finance/summary -> 403 (finance is head office only unless head office gives it)', async () => {
      const res = await request(app.getHttpServer())
        .get('/finance/summary')
        .set(auth(tokens.manager));
      expect(res.status).toBe(403);
    });

    it('salesperson GET /new-store/projects -> 403', async () => {
      const res = await request(app.getHttpServer())
        .get('/new-store/projects')
        .set(auth(tokens.rep));
      expect(res.status).toBe(403);
    });

    it('store manager GET /new-store/projects -> 403 (head office only — store provisioning)', async () => {
      const res = await request(app.getHttpServer())
        .get('/new-store/projects')
        .set(auth(tokens.manager));
      expect(res.status).toBe(403);
    });

    it('head office GET /new-store/projects -> 200', async () => {
      const res = await request(app.getHttpServer())
        .get('/new-store/projects')
        .set(auth(tokens.ho));
      expect(res.status).toBe(200);
    });

    it('salesperson PATCH /hrms/leave/:id -> 403', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/hrms/leave/${SURAT_LEAVE_ID}`)
        .set(auth(tokens.rep))
        .send({ status: 'approved' });
      expect(res.status).toBe(403);
    });

    it('store manager PATCH /hrms/leave/:id -> not gated by role (not 403)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/hrms/leave/${SURAT_LEAVE_ID}`)
        .set(auth(tokens.manager))
        .send({ status: 'approved' });
      expect(res.status).not.toBe(403);
      expect([200, 201, 204, 400]).toContain(res.status);
    });
  });

  // -------------------------------------------------- 4. Discounts (M15)
  describe('Discount ceilings + mass-assignment guard (M15)', () => {
    it('salesperson discount at 1.5% (<= 2% ceiling) -> approved', async () => {
      const res = await request(app.getHttpServer())
        .post('/discounts')
        .set(auth(tokens.rep))
        .send({
          storeId: SURAT,
          customerName: 'QA Test — approve',
          item: 'Test ring',
          percent: 1.5,
          reason: 'e2e',
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('approved');
      expect(res.body.requestedRole).toBe('salesperson');
    });

    it('salesperson discount at 6% (> 2% ceiling) -> escalated', async () => {
      const res = await request(app.getHttpServer())
        .post('/discounts')
        .set(auth(tokens.rep))
        .send({
          storeId: SURAT,
          customerName: 'QA Test — escalate',
          item: 'Test necklace',
          percent: 6,
          reason: 'e2e',
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('escalated');
    });

    it('status is SERVER-decided: client cannot force "approved" on a 6% request', async () => {
      const res = await request(app.getHttpServer())
        .post('/discounts')
        .set(auth(tokens.rep))
        .send({
          storeId: SURAT,
          customerName: 'QA Test — mass-assign',
          percent: 6,
          status: 'approved', // unknown/forbidden field
          approvedRole: 'head_office',
        });
      // ValidationPipe forbidNonWhitelisted should reject the extra fields.
      expect(res.status).toBe(400);
    });

    it('salesperson cannot file a discount for a store outside their scope -> 403', async () => {
      const res = await request(app.getHttpServer())
        .post('/discounts')
        .set(auth(tokens.rep))
        .send({
          storeId: MUMBAI,
          customerName: 'QA Test — cross store',
          item: 'Test bangle', // item is now mandatory — send a valid one so the store-scope check is what fires
          percent: 1,
        });
      expect(res.status).toBe(403);
    });
  });

  // --------------------------------------------------- 5. Quote pricing (M2)
  describe('Quote pricing math (M2, exact)', () => {
    it('server computes line totals + GST + grand total exactly', async () => {
      // 20g @ 6000/g = 120000 metal; +15000 making +8000 stones = 143000 taxable.
      // GST 3% = 4290. Grand total = 147290.
      const res = await request(app.getHttpServer())
        .post('/quotes')
        .set(auth(tokens.rep))
        .send({
          storeId: SURAT,
          customerName: 'QA Test — pricing',
          phone: '9876500000',
          lines: [
            {
              description: '22K gold chain',
              karat: 22,
              weightGrams: 20,
              goldRatePerGram: 6000,
              makingCharges: 15000,
              stoneCharges: 8000,
              caratWeight: 0,
            },
          ],
        });
      expect(res.status).toBe(201);
      const t = res.body.totals;
      expect(t.metalValue).toBe(120000);
      expect(t.makingCharges).toBe(15000);
      expect(t.stoneCharges).toBe(8000);
      expect(t.taxable).toBe(143000);
      expect(t.gst).toBeCloseTo(4290, 2);
      expect(t.grandTotal).toBeCloseTo(147290, 2);
      // Origin store is always redeemable (M2 quote portability).
      expect(res.body.redeemableStoreIds).toContain(SURAT);
    });

    it('multi-line quote sums correctly', async () => {
      const res = await request(app.getHttpServer())
        .post('/quotes')
        .set(auth(tokens.rep))
        .send({
          storeId: SURAT,
          customerName: 'QA Test — multiline',
          phone: '9876500000',
          lines: [
            { description: 'A', karat: 22, weightGrams: 10, goldRatePerGram: 6000, makingCharges: 5000, stoneCharges: 0 },
            { description: 'B', karat: 18, weightGrams: 5, goldRatePerGram: 5000, makingCharges: 2000, stoneCharges: 3000 },
          ],
        });
      expect(res.status).toBe(201);
      const t = res.body.totals;
      // metal = 60000 + 25000 = 85000; making = 7000; stones = 3000; taxable = 95000
      expect(t.metalValue).toBe(85000);
      expect(t.makingCharges).toBe(7000);
      expect(t.stoneCharges).toBe(3000);
      expect(t.taxable).toBe(95000);
      expect(t.gst).toBeCloseTo(2850, 2);
      expect(t.grandTotal).toBeCloseTo(97850, 2);
    });
  });
});
