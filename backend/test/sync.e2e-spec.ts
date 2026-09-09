import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SYNC_STATE_ORGANISATION_SENTINEL } from '../src/sync/sync.service';

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
const PROFILE_ID = 'gati-sync-e2e';
const PROFILE_HASH = 'a'.repeat(64);
const SOURCE_INSTANCE_HASH = 'b'.repeat(64);

describe('Eclat backend — legacy sync (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  let agentToken: string;
  let agentId: string;
  let configRevision: string;
  let organisationId: string;

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function asAgent() {
    return {
      Authorization: `Bearer ${agentToken}`,
      'x-caratos-profile-id': PROFILE_ID,
      'x-caratos-profile-hash': PROFILE_HASH,
      'x-caratos-source-instance-hash': SOURCE_INSTANCE_HASH,
      'x-caratos-config-revision': configRevision,
    };
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
    prisma = app.get(PrismaService);

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

    const enrolled = await request(app.getHttpServer())
      .post('/integration/connect/agents')
      .set(auth(tokens.ho))
      .send({ name: 'SYNC E2E Gati agent', sourceSystem: 'gati' });
    expect(enrolled.status).toBe(201);
    agentToken = enrolled.body.token;
    agentId = enrolled.body.agent.id;
    organisationId = (
      await prisma.connectAgent.findUniqueOrThrow({
        where: { id: agentId },
        select: { organisationId: true },
      })
    ).organisationId;

    const configured = await request(app.getHttpServer())
      .post(`/integration/connect/agents/${enrolled.body.agent.id}/config`)
      .set(auth(tokens.ho))
      .send({
        config: {
          enabled: true,
          expectedProfileHash: PROFILE_HASH,
          expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
        },
      });
    expect(configured.status).toBe(201);
    configRevision = configured.body.config.configRevision;
  });

  afterAll(async () => {
    if (agentId) await prisma?.connectAgent.deleteMany({ where: { id: agentId } });
    await app?.close();
  });

  it('is machine-only — human users are rejected regardless of role', async () => {
    for (const token of [tokens.rep, tokens.ho]) {
      const res = await request(app.getHttpServer())
        .post('/sync/parties')
        .set(auth(token))
        .send({ records: [] });
      expect(res.status).toBe(403);
    }
  });

  it('refuses a machine request without its approved identity headers', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(auth(agentToken))
      .send({ records: [] });
    expect(res.status).toBe(403);
  });

  it('upserts a party on legacyId and returns the batch watermark', async () => {
    const beforeIngestion = await prisma.connectAgent.findUniqueOrThrow({
      where: { id: agentId },
      select: {
        status: true,
        lastSeenAt: true,
        lastSyncAt: true,
        lastError: true,
        agentVersion: true,
        hostname: true,
        os: true,
        lastStats: true,
      },
    });
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
      .set(asAgent())
      .send({ records: [record] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ entity: 'parties', received: 1, upserted: 1, skipped: 0 });
    expect(res.body.watermark).toBe('2026-06-20T10:00:00.000Z');
    const acceptedState = await prisma.syncState.findUnique({
      where: {
        organisationId_sourceTable_storeId: {
          organisationId,
          sourceTable: 'PartyMst',
          storeId: SYNC_STATE_ORGANISATION_SENTINEL,
        },
      },
    });
    expect(acceptedState).toMatchObject({
      sourceTable: 'PartyMst',
      storeId: SYNC_STATE_ORGANISATION_SENTINEL,
      rowsSynced: 1,
    });
    expect(acceptedState?.lastUpdatedAt?.toISOString()).toBe(
      '2026-06-20T10:00:00.000Z',
    );
    expect(
      await prisma.connectAgent.findUniqueOrThrow({
        where: { id: agentId },
        select: {
          status: true,
          lastSeenAt: true,
          lastSyncAt: true,
          lastError: true,
          agentVersion: true,
          hostname: true,
          os: true,
          lastStats: true,
        },
      }),
    ).toEqual(beforeIngestion);
  });

  it('is idempotent — re-sending the same record upserts (does not duplicate)', async () => {
    const record = {
      PartyNo: 'TEST-SYNC-PARTY-1',
      FirmName: 'Sync Test Jewellers (updated)',
      IsCustomer: 1,
    };
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(asAgent())
      .send({ records: [record] });
    expect(res.status).toBe(201);
    expect(res.body.upserted).toBe(1);
    expect(
      await prisma.syncState.count({
        where: {
          organisationId,
          sourceTable: 'PartyMst',
          storeId: SYNC_STATE_ORGANISATION_SENTINEL,
        },
      }),
    ).toBe(1);
    expect(res.body.skipped).toBe(0);
  });

  it('skips rows whose foreign keys are not present (sale-line with no header)', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/sale-lines')
      .set(asAgent())
      .send({ records: [{ JewelTransId: 'TEST-NO-SUCH-SALE', JewelId: 'x', SrNo: 1, MRP: 100 }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ entity: 'sale-lines', received: 1, upserted: 0, skipped: 1 });
    expect(
      await prisma.syncState.count({
        where: {
          organisationId,
          sourceTable: 'JewelTransInward',
          storeId: SYNC_STATE_ORGANISATION_SENTINEL,
        },
      }),
    ).toBe(0);
  });

  it('rejects unknown top-level body fields (mass-assignment guard)', async () => {
    const res = await request(app.getHttpServer())
      .post('/sync/parties')
      .set(asAgent())
      .send({ records: [], evil: true });
    expect(res.status).toBe(400);
  });
});
