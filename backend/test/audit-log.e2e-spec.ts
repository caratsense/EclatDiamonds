import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * Audit Log read surface: store scoping (a store_manager sees only their own
 * store), the head-office store filter, the inclusive `to` date boundary, and
 * resolved store names.
 */
const PASSWORD = 'password123';
const AARAV = 'aarav.mehta@caratsense.in'; // store_manager, Surat
const HO = 'head.office@caratsense.in';
const PRIYA = 'priya.rep@caratsense.in'; // salesperson (no audit access)
const SURAT = 'surat-main';
const MUMBAI = 'mumbai-bandra';

let seq = 0;

describe('Audit log read (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, t: string) => request(app.getHttpServer()).get(path).set(auth(t));

  // The audit row we assert on is produced by creating a stock item at Surat.
  let stockId = '';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    for (const [k, e] of [['aarav', AARAV], ['ho', HO], ['priya', PRIYA]] as const) {
      const r = await request(app.getHttpServer()).post('/auth/login').send({ email: e, password: PASSWORD });
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
    // Produce a Surat-scoped audit row (stock.create writes one).
    const c = await request(app.getHttpServer())
      .post('/stock')
      .set(auth(tokens.aarav))
      .send({ storeId: SURAT, sku: `AUD-${Date.now()}-${seq++}`, metal: 'gold_22k' });
    expect([200, 201]).toContain(c.status);
    stockId = c.body.id;
  });
  afterAll(async () => { await app?.close(); });

  it('1. a salesperson cannot read the audit log', async () => {
    expect((await get('/audit', tokens.priya)).status).toBe(403);
  });

  it('2. the store manager sees their own store entry (with a resolved store name)', async () => {
    const r = await get(`/audit?entityType=StockItem&entityId=${stockId}`, tokens.aarav);
    expect(r.status).toBe(200);
    const row = r.body.items.find((x: any) => x.entityId === stockId);
    expect(row).toBeTruthy();
    expect(row.storeId).toBe(SURAT);
    expect(row.storeName).toBeTruthy(); // name resolved, not a raw id only
  });

  it('3. head office filtered to another store does NOT see the Surat entry', async () => {
    const r = await get(`/audit?entityId=${stockId}&storeId=${MUMBAI}`, tokens.ho);
    expect(r.status).toBe(200);
    expect(r.body.items.find((x: any) => x.entityId === stockId)).toBeUndefined();
  });

  it('4. head office with no store filter sees the entry', async () => {
    const r = await get(`/audit?entityId=${stockId}`, tokens.ho);
    expect(r.body.items.find((x: any) => x.entityId === stockId)).toBeTruthy();
  });

  it('5. `to` = today is inclusive of entries created today (no off-by-a-day)', async () => {
    const r = await get(`/audit?entityId=${stockId}&to=${today}`, tokens.ho);
    expect(r.status).toBe(200);
    expect(r.body.items.find((x: any) => x.entityId === stockId)).toBeTruthy();
  });
});
