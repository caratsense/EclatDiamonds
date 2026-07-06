import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';

/**
 * Legacy-sync ingestion (/sync/*) regression suite.
 *
 * Proves the production sink the on-site agent pushes to:
 *   - is head_office-only (store staff cannot bulk-write),
 *   - upserts on legacyId idempotently (re-sending refreshes, never duplicates),
 *   - returns the batch watermark for the agent to advance, and
 *   - safely skips rows whose foreign keys aren't present yet.
 *
 * Uses fixed TEST-* legacyIds so re-runs upsert the same rows (no accumulation).
 */

const PASSWORD = 'password123';
const REP = 'priya.rep@caratsense.in'; // salesperson
const HO = 'head.office@caratsense.in'; // head_office (the sync service account role)

describe('Eclat backend — legacy sync (e2e)', () => {
  let app: INestApplication;
  const tokens: Record<string, string> = {};

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
      ['ho', HO],
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

  it('is head_office-only — a salesperson is rejected', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(auth(tokens.rep))
      .send({ records: [] });
    expect(res.status).toBe(403);
  });

  it('upserts a party on legacyId and returns the batch watermark', async () => {
    const record = {
      PartyNo: 'TEST-SYNC-PARTY-1',
      FirmName: 'Sync Test Jewellers',
      IsCustomer: 1,
      OwnerMobile: '9876500000',
      FirmCity: 'Surat',
      UpdateDate: '2026-06-20T10:00:00.000Z',
    };
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(auth(tokens.ho))
      .send({ records: [record] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ entity: 'parties', received: 1, upserted: 1, skipped: 0 });
    expect(res.body.watermark).toBe('2026-06-20T10:00:00.000Z');
  });

  it('is idempotent — re-sending the same record upserts (does not duplicate)', async () => {
    const record = {
      PartyNo: 'TEST-SYNC-PARTY-1',
      FirmName: 'Sync Test Jewellers (updated)',
      IsCustomer: 1,
    };
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(auth(tokens.ho))
      .send({ records: [record] });
    expect(res.status).toBe(201);
    expect(res.body.upserted).toBe(1);
    expect(res.body.skipped).toBe(0);
  });

  it('skips rows whose foreign keys are not present (sale-line with no header)', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/sale-lines')
      .set(auth(tokens.ho))
      .send({ records: [{ JewelTransId: 'TEST-NO-SUCH-SALE', JewelId: 'x', SrNo: 1, MRP: 100 }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ entity: 'sale-lines', received: 1, upserted: 0, skipped: 1 });
  });

  it('rejects unknown top-level body fields (mass-assignment guard)', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(auth(tokens.ho))
      .send({ records: [], evil: true });
    expect(res.status).toBe(400);
  });
});
