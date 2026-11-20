import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * Module 15 — direct-sale discount CONTROL + soft-void (risk-based coverage of the
 * money/RBAC-critical paths). Boots the real app against the seeded eclat DB.
 *
 * Caps (config-seed): salesperson diamond 2% / making 5%; store_manager 5% / 10%;
 * head_office 100%. area_manager is collapsed (no user holds it) so it must never
 * appear as an approver.
 */
const PASSWORD = 'password123';
const REP = 'priya.rep@caratsense.in'; // salesperson, Surat
const MANAGER = 'aarav.mehta@caratsense.in'; // store_manager, Surat
const HO = 'head.office@caratsense.in'; // head_office, all stores
const SURAT = 'surat-main';
const MUMBAI = 'mumbai-bandra'; // out of Surat staff's scope

let seq = 0;
const inv = () => `QA-${Date.now()}-${seq++}`;

describe('Direct-sale discount control + void (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = (email: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });

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
    for (const [k, e] of [['rep', REP], ['manager', MANAGER], ['ho', HO]] as const) {
      const r = await login(e);
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  const sale = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/sales')
      .set(auth(token))
      .send({ storeId: SURAT, customerName: 'QA', invoiceNo: inv(), salesValue: 100000, ...body });

  // ── Cap enforcement ───────────────────────────────────────────────────────
  it('1/2. salesperson WITHIN diamond+making caps -> sale created', async () => {
    const res = await sale(tokens.rep, {
      diamondValue: 40000,
      makingValue: 10000,
      diamondDiscountPercent: 1.5, // <= 2%
      makingDiscountPercent: 4, // <= 5%
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.requiresApproval).toBeUndefined();
    expect(res.body.id).toBeTruthy();
    expect(res.body.discount).toBe(40000 * 0.015 + 10000 * 0.04); // 1000
  });

  it('3. salesperson ABOVE diamond cap -> escalates (no sale), approver is NOT area_manager', async () => {
    const res = await sale(tokens.rep, {
      diamondValue: 50000,
      diamondDiscountPercent: 4, // > 2% rep, <= 5% store_manager
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.requiresApproval).toBe(true);
    expect(res.body.id).toBeUndefined(); // no sale created
    expect(res.body.discountRequest.requiredRole).toBe('store_manager');
    expect(res.body.discountRequest.requiredRole).not.toBe('area_manager');
  });

  it('4. salesperson ABOVE making cap -> escalates', async () => {
    const res = await sale(tokens.rep, { makingValue: 30000, makingDiscountPercent: 8 }); // > 5%
    expect(res.body.requiresApproval).toBe(true);
    expect(res.body.id).toBeUndefined();
  });

  it('5. store manager WITHIN cap -> sale created', async () => {
    const res = await sale(tokens.manager, {
      diamondValue: 40000,
      makingValue: 20000,
      diamondDiscountPercent: 4, // <= 5%
      makingDiscountPercent: 8, // <= 10%
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.id).toBeTruthy();
    expect(res.body.requiresApproval).toBeUndefined();
  });

  it('6/7. store manager ABOVE cap -> escalates to HEAD OFFICE (never area_manager)', async () => {
    const res = await sale(tokens.manager, { diamondValue: 60000, diamondDiscountPercent: 15 }); // > 5%
    expect(res.body.requiresApproval).toBe(true);
    expect(res.body.discountRequest.requiredRole).toBe('head_office');
    expect(res.body.discountRequest.requiredRole).not.toBe('area_manager');
  });

  it('9. blended discount WITHOUT the split is rejected (cap bypass closed)', async () => {
    const res = await sale(tokens.rep, { afterDiscountValue: 50000 }); // 50% blended, no split
    expect(res.status).toBe(400);
  });

  it('10. diamond+making value exceeding sales value -> rejected', async () => {
    const res = await sale(tokens.rep, {
      diamondValue: 80000,
      makingValue: 40000, // 120k > 100k gross
      diamondDiscountPercent: 1,
    });
    expect(res.status).toBe(400);
  });

  it('10b. negative discount value -> rejected', async () => {
    const res = await sale(tokens.rep, { diamondValue: -100, diamondDiscountPercent: 1 });
    expect(res.status).toBe(400);
  });

  it('11. discount percent > 100 -> rejected', async () => {
    const res = await sale(tokens.rep, { diamondValue: 40000, diamondDiscountPercent: 150 });
    expect(res.status).toBe(400);
  });

  it('12. non-numeric financial value -> rejected', async () => {
    const res = await sale(tokens.rep, { diamondValue: 'lots', diamondDiscountPercent: 1 } as any);
    expect(res.status).toBe(400);
  });

  it('13. store isolation: salesperson selling for an out-of-scope store -> 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/sales')
      .set(auth(tokens.rep))
      .send({ storeId: MUMBAI, customerName: 'QA', invoiceNo: inv(), salesValue: 1000 });
    expect(res.status).toBe(403);
  });

  it('8. head office can approve an escalated sale discount', async () => {
    const escalated = await sale(tokens.rep, { diamondValue: 60000, diamondDiscountPercent: 12 }); // -> HO
    expect(escalated.body.requiresApproval).toBe(true);
    const id = escalated.body.discountRequest.id;
    const res = await request(app.getHttpServer())
      .patch(`/discounts/${id}/approve`)
      .set(auth(tokens.ho))
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.status).toBe('approved');
  });

  // ── Approved over-cap discount -> completed sale (the re-submit flow) ───────
  async function escalateAndApprove(diamondValue: number, diamondDiscountPercent: number) {
    const esc = await sale(tokens.rep, { diamondValue, diamondDiscountPercent });
    expect(esc.body.requiresApproval).toBe(true);
    const drId = esc.body.discountRequest.id as string;
    const ap = await request(app.getHttpServer())
      .patch(`/discounts/${drId}/approve`)
      .set(auth(tokens.ho))
      .send({});
    expect([200, 201]).toContain(ap.status);
    return drId;
  }

  it('C1. salesperson completes the sale with the approved discountRequestId -> sale created + linked', async () => {
    const drId = await escalateAndApprove(60000, 10); // 10% > 2% rep cap -> HO approves
    const res = await sale(tokens.rep, {
      diamondValue: 60000,
      diamondDiscountPercent: 10,
      discountRequestId: drId,
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.requiresApproval).toBeUndefined();
    expect(res.body.id).toBeTruthy();
    expect(res.body.discount).toBe(60000 * 0.1); // 6000
  });

  it('C2. an approval cannot be re-used on a second sale', async () => {
    const drId = await escalateAndApprove(50000, 9);
    const first = await sale(tokens.rep, { diamondValue: 50000, diamondDiscountPercent: 9, discountRequestId: drId });
    expect([200, 201]).toContain(first.status);
    const second = await sale(tokens.rep, { diamondValue: 50000, diamondDiscountPercent: 9, discountRequestId: drId });
    expect(second.status).toBe(409);
  });

  it('C3. applying MORE than the approved percent is rejected', async () => {
    const drId = await escalateAndApprove(50000, 8);
    const res = await sale(tokens.rep, { diamondValue: 50000, diamondDiscountPercent: 12, discountRequestId: drId }); // 12 > approved 8
    expect(res.status).toBe(400);
  });

  it('C4. an un-approved (still escalated) request cannot complete a sale', async () => {
    const esc = await sale(tokens.rep, { diamondValue: 40000, diamondDiscountPercent: 7 });
    const drId = esc.body.discountRequest.id;
    const res = await sale(tokens.rep, { diamondValue: 40000, diamondDiscountPercent: 7, discountRequestId: drId });
    expect(res.status).toBe(400);
  });

  // ── Soft-void ─────────────────────────────────────────────────────────────
  async function makeSale(token: string, storeId = SURAT) {
    const r = await request(app.getHttpServer())
      .post('/sales')
      .set(auth(token))
      .send({ storeId, customerName: 'QA void', invoiceNo: inv(), salesValue: 5000, paymentMode: 'cash', advanceReceived: 1000 });
    expect([200, 201]).toContain(r.status);
    return r.body.id as string;
  }

  it('15. salesperson CANNOT void a sale -> 403', async () => {
    const id = await makeSale(tokens.manager);
    const res = await request(app.getHttpServer())
      .post(`/sales/${id}/cancel`)
      .set(auth(tokens.rep))
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('18. void without a reason -> 400', async () => {
    const id = await makeSale(tokens.manager);
    const res = await request(app.getHttpServer())
      .post(`/sales/${id}/cancel`)
      .set(auth(tokens.manager))
      .send({});
    expect(res.status).toBe(400);
  });

  it('14/20/22. store manager voids -> isCancelled persists, payment relation intact', async () => {
    const id = await makeSale(tokens.manager);
    const res = await request(app.getHttpServer())
      .post(`/sales/${id}/cancel`)
      .set(auth(tokens.manager))
      .send({ reason: 'customer returned before delivery' });
    expect([200, 201]).toContain(res.status);
    expect(res.body.isCancelled).toBe(true);
    // Advance payment still linked to the (now voided) sale.
    expect(Array.isArray(res.body.payments)).toBe(true);
    expect(res.body.payments.length).toBeGreaterThan(0);
    // Persisted.
    const after = await request(app.getHttpServer()).get(`/sales/${id}`).set(auth(tokens.manager));
    expect(after.body.isCancelled).toBe(true);
  });

  it('17. store manager CANNOT void another store\'s sale -> 403', async () => {
    // A sale in Mumbai (created by head office, who is in scope everywhere).
    const id = await makeSale(tokens.ho, MUMBAI);
    const res = await request(app.getHttpServer())
      .post(`/sales/${id}/cancel`)
      .set(auth(tokens.manager)) // Surat manager, out of Mumbai scope
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
  });

  // ── Payment reversal (immutable original + signed reversal) ────────────────
  async function makePayment(amount = 5000) {
    const r = await request(app.getHttpServer())
      .post('/payments')
      .set(auth(tokens.manager))
      .send({ storeId: SURAT, amount, mode: 'cash', reference: 'QA payer' });
    expect([200, 201]).toContain(r.status);
    return r.body.id as string;
  }

  it('30. salesperson CANNOT reverse a payment -> 403', async () => {
    const id = await makePayment();
    const res = await request(app.getHttpServer())
      .post(`/payments/${id}/reverse`)
      .set(auth(tokens.rep))
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('26. reversal without a reason -> 400', async () => {
    const id = await makePayment();
    const res = await request(app.getHttpServer())
      .post(`/payments/${id}/reverse`)
      .set(auth(tokens.manager))
      .send({});
    expect(res.status).toBe(400);
  });

  it('24/25/28. manager reverses -> separate NEGATIVE entry that nets the original', async () => {
    const id = await makePayment(5000);
    const res = await request(app.getHttpServer())
      .post(`/payments/${id}/reverse`)
      .set(auth(tokens.manager))
      .send({ reason: 'mis-keyed collection' });
    expect([200, 201]).toContain(res.status);
    expect(res.body.id).toBeTruthy();
    expect(res.body.id).not.toBe(id); // a new, separate entry
    expect(res.body.amount).toBe(-5000); // signed reversal → nets original to 0
  });

  it('29. a payment cannot be reversed twice', async () => {
    const id = await makePayment();
    const first = await request(app.getHttpServer())
      .post(`/payments/${id}/reverse`)
      .set(auth(tokens.manager))
      .send({ reason: 'once' });
    expect([200, 201]).toContain(first.status);
    const second = await request(app.getHttpServer())
      .post(`/payments/${id}/reverse`)
      .set(auth(tokens.manager))
      .send({ reason: 'twice' });
    expect(second.status).toBe(400);
  });
});
