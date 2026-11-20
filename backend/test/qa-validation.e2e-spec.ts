import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * QA pass — server-side validation fixes (backend must enforce, not just the UI):
 *  - staff creation requires BOTH a phone (real Indian mobile) AND an email;
 *  - custom-order customer name rejects numeric-only;
 *  - the Operating Expense KPI drill-down endpoint returns a real breakdown shape.
 */
const PASSWORD = 'password123';
const MANAGER = 'aarav.mehta@caratsense.in'; // store_manager, Surat
const HO = 'head.office@caratsense.in';
const SURAT = 'surat-main';

let seq = 0;

describe('QA validation fixes (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const post = (path: string, t: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(path).set(auth(t)).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    for (const [k, e] of [['mgr', MANAGER], ['ho', HO]] as const) {
      const r = await request(app.getHttpServer()).post('/auth/login').send({ email: e, password: PASSWORD });
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
  });
  afterAll(async () => { await app?.close(); });

  // M18 — Team / add staff: BOTH phone AND email are mandatory (confirmed rule).
  const staffEmail = () => `qa.staff.${Date.now()}.${seq++}@example.com`;

  it('staff creation is REJECTED when neither phone nor email is given', async () => {
    const r = await post('/users', tokens.mgr, { name: 'No Contact Staff', storeId: SURAT });
    expect(r.status).toBe(400);
  });

  it('staff creation is REJECTED when email is missing (phone alone is not enough)', async () => {
    const r = await post('/users', tokens.mgr, { name: 'Phone Only', storeId: SURAT, phone: '9876500000' });
    expect(r.status).toBe(400);
  });

  it('staff creation is REJECTED when phone is missing (email alone is not enough)', async () => {
    const r = await post('/users', tokens.mgr, { name: 'Email Only', storeId: SURAT, email: staffEmail() });
    expect(r.status).toBe(400);
  });

  it('staff phone must be a real Indian mobile (letters rejected)', async () => {
    const r = await post('/users', tokens.mgr, { name: 'Bad Phone', storeId: SURAT, phone: 'abc12345', email: staffEmail() });
    expect(r.status).toBe(400);
  });

  it('staff with a valid Indian mobile AND email is accepted', async () => {
    const r = await post('/users', tokens.mgr, { name: `QA Staff ${Date.now()}-${seq++}`, storeId: SURAT, phone: '9876500000', email: staffEmail() });
    expect([200, 201]).toContain(r.status);
  });

  // M6 — Custom order
  it('custom-order customer name rejects numeric-only', async () => {
    const r = await post('/timelines/orders', tokens.mgr, { storeId: SURAT, customerName: '12345', item: 'Ring' });
    expect(r.status).toBe(400);
  });

  it('custom-order with a real name is accepted', async () => {
    const r = await post('/timelines/orders', tokens.mgr, { storeId: SURAT, customerName: 'Priya Sharma', item: 'Ring' });
    expect([200, 201]).toContain(r.status);
  });

  // M16 — Operating Expense drill-down
  it('GET /finance/expenses returns a real breakdown shape', async () => {
    const r = await request(app.getHttpServer()).get('/finance/expenses').set(auth(tokens.ho));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('total');
    expect(Array.isArray(r.body.items)).toBe(true);
  });
});
