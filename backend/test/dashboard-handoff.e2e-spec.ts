import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * Multi-store hardening (Phase 1): a hand-off is filed against ONE concrete
 * store. A multi-store user must name it explicitly — the service must NOT
 * silently default to their first store. A single-store user auto-uses theirs.
 */
const PASSWORD = 'password123';
const NEELAM = 'neelam.area@caratsense.in'; // store_manager across surat/mumbai/ahmedabad
const AARAV = 'aarav.mehta@caratsense.in'; // store_manager, Surat only
const SURAT = 'surat-main';
const MUMBAI = 'mumbai-bandra';
const OTHER = 'ahmedabad-cg';

describe('Dashboard hand-off store attribution (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const handoff = (t: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/dashboard/handoffs')
      .set(auth(t))
      .send({ fromDept: 'Sales', toDept: 'Workshop', title: 'QA handoff', ...body });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    for (const [k, e] of [['neelam', NEELAM], ['aarav', AARAV]] as const) {
      const r = await request(app.getHttpServer()).post('/auth/login').send({ email: e, password: PASSWORD });
      expect(r.status).toBe(201);
      tokens[k] = r.body.token;
    }
  });
  afterAll(async () => { await app?.close(); });

  it('1. a multi-store user MUST specify a store (no silent first-store default)', async () => {
    const r = await handoff(tokens.neelam, {}); // no storeId
    expect(r.status).toBe(400);
  });

  it('2. a multi-store user with an explicit in-scope store succeeds', async () => {
    const r = await handoff(tokens.neelam, { storeId: MUMBAI });
    expect([200, 201]).toContain(r.status);
    expect(r.body.storeId).toBe(MUMBAI);
  });

  it('3. a single-store user may omit storeId — it uses their one store', async () => {
    const r = await handoff(tokens.aarav, {});
    expect([200, 201]).toContain(r.status);
    expect(r.body.storeId).toBe(SURAT);
  });

  it('4. an out-of-scope store is rejected', async () => {
    // aarav is Surat-only; Ahmedabad is out of scope.
    const r = await handoff(tokens.aarav, { storeId: OTHER });
    expect(r.status).toBe(403);
  });
});
