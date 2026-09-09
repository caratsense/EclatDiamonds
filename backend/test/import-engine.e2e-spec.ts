import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { Workbook } from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/** Build a real .xlsx buffer from headers + rows (proves XLSX == CSV pipeline). */
async function xlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Products with deliberately-missing metal (must import as unspecified, NEVER 22K).
const P_SKUS = ['ZZP-RING-1', 'ZZP-CHAIN-2'];
const PRODUCTS_CSV = [
  'Item Code,Item Name,Metal,Purity,Wt',
  'ZZP-RING-1,ZZ Test Ring,Gold,22,5.2',
  'ZZP-CHAIN-2,ZZ Test Chain,,,,', // no metal, no purity -> gold_unspecified
].join('\n');
const P_MAP = [
  { sourceColumn: 'Item Code', canonicalField: 'sku' },
  { sourceColumn: 'Item Name', canonicalField: 'name' },
  { sourceColumn: 'Metal', canonicalField: 'metal' },
  { sourceColumn: 'Purity', canonicalField: 'karat' },
  { sourceColumn: 'Wt', canonicalField: 'weightGrams' },
];

/**
 * CaratOS Phase 3 — import engine (Excel/CSV → Customers).
 * Proves: discovery + mapping suggestions, preview validation (valid/warning/error),
 * a real import, IDEMPOTENCY (re-run makes no duplicates), organisation attribution,
 * and the connector registry status. Nothing is silently dropped.
 */
const HO = 'head.office@caratsense.in'; // seeded Eclat head office (org_eclat)
const PASSWORD = 'password123';

// Sentinel names so we can find + clean up exactly our rows.
const NAMES = ['ZZImport Alpha', 'ZZImport Beta', 'ZZImport Gamma'];
const CSV = [
  'Customer Name,Mobile,Email,City',
  'ZZImport Alpha,9876500001,alpha@zz.test,Mumbai',
  'ZZImport Beta,9876500002,,Surat',
  ',9876500003,noname@zz.test,Delhi', // error: missing required name
  'ZZImport Gamma,notaphone,gamma@zz.test,Pune', // warning: bad phone -> imported without phone
].join('\n');

const MAPPINGS = [
  { sourceColumn: 'Customer Name', canonicalField: 'name' },
  { sourceColumn: 'Mobile', canonicalField: 'phone' },
  { sourceColumn: 'Email', canonicalField: 'email' },
  { sourceColumn: 'City', canonicalField: 'city' },
];

const TALLY_CUSTOMER = 'ZZTally Export Customer';
const TALLY_FILE = 'tally-customers.csv';
const TALLY_CSV = [
  'External ID,Customer Name,Mobile,Email,City',
  `tally:ledger-guid-1,${TALLY_CUSTOMER},9876522222,tally-export@zz.test,Indore`,
].join('\n');
const TALLY_MAPPINGS = [
  { sourceColumn: 'External ID', canonicalField: 'code' },
  ...MAPPINGS,
];
const CONNECT_AGENT_NAMES = ['ZZ Tally Agent', 'ZZ Generic ODBC Agent'];
const MACHINE_CUSTOMER = 'ZZ Machine Tally Customer';
const MACHINE_CUSTOMER_UPDATED = 'ZZ Machine Tally Customer Updated';
const MACHINE_PROFILE_HASH = 'b'.repeat(64);
const MACHINE_SOURCE_INSTANCE_HASH = 'f'.repeat(64);
const MACHINE_SOURCE_NAMESPACE = MACHINE_SOURCE_INSTANCE_HASH.slice(0, 32);
const MACHINE_CUSTOMER_CODE = `tally:${MACHINE_SOURCE_NAMESPACE}:machine-ledger-1`;
const MACHINE_PRODUCT_SKU = `tally:${MACHINE_SOURCE_NAMESPACE}:machine-stock-1`;
const MACHINE_CUSTOMER_MAP = [
  { sourceColumn: 'External ID', canonicalField: 'code' },
  { sourceColumn: 'Customer Name', canonicalField: 'name' },
];
const MACHINE_PRODUCT_MAP = [
  { sourceColumn: 'External ID', canonicalField: 'sku' },
  { sourceColumn: 'Item Name', canonicalField: 'name' },
  { sourceColumn: 'Material', canonicalField: 'metal' },
  { sourceColumn: 'Category', canonicalField: 'category' },
  { sourceColumn: 'UOM', canonicalField: 'unitOfMeasure' },
];

describe('CaratOS import engine (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const agentTokens: Record<string, string> = {};
  const agentConfigRevisions: Record<string, string> = {};
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const upload = (path: string) =>
    request(app.getHttpServer()).post(path).set(auth()).attach('file', Buffer.from(CSV), 'customers.csv');

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup(prisma);
    const r = await request(app.getHttpServer()).post('/auth/login').send({ email: HO, password: PASSWORD });
    expect(r.status).toBe(201);
    token = r.body.token;
  });

  afterAll(async () => {
    await cleanup(prisma);
    await app?.close();
  });

  it('discovery detects columns and suggests canonical mappings', async () => {
    const r = await upload('/imports/customers/discover');
    expect(r.status).toBe(201);
    expect(r.body.rowCount).toBe(4);
    const byCol = Object.fromEntries(r.body.suggestions.map((s: any) => [s.sourceColumn, s.canonicalField]));
    expect(byCol['Customer Name']).toBe('name');
    expect(byCol['Mobile']).toBe('phone');
    expect(byCol['Email']).toBe('email');
    expect(r.body.missingRequired).toEqual([]); // name is mappable
  });

  it('preview validates rows: valid / warning / error, nothing dropped', async () => {
    const r = await upload('/imports/customers/preview').field('mappings', JSON.stringify(MAPPINGS));
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(4);
    expect(r.body.valid).toBe(2); // Alpha, Beta
    expect(r.body.warning).toBe(1); // Gamma (bad phone, still importable)
    expect(r.body.error).toBe(1); // missing-name row
  });

  it('import creates customers, reports reconciliation, attributes to the org', async () => {
    const r = await upload('/imports/customers/run').field('mappings', JSON.stringify(MAPPINGS));
    expect(r.status).toBe(201);
    expect(r.body.counts.imported).toBe(3); // Alpha, Beta, Gamma
    expect(r.body.counts.failed).toBe(1); // missing name
    // All imported rows belong to Eclat's organisation.
    const rows = await prisma.party.findMany({ where: { name: { in: NAMES } }, select: { organisationId: true } });
    expect(rows.length).toBe(3);
    expect(rows.every((p) => p.organisationId === 'org_eclat')).toBe(true);
  });

  it('re-running the same file is idempotent — no duplicate customers', async () => {
    const r = await upload('/imports/customers/run').field('mappings', JSON.stringify(MAPPINGS));
    expect(r.status).toBe(201);
    expect(r.body.counts.imported).toBe(0); // nothing new
    // Alpha + Beta match by phone; Gamma has no usable phone and matches by exact
    // name. All three update idempotently rather than creating another row.
    expect(r.body.counts.updated).toBe(3);
    expect(r.body.counts.duplicate).toBe(0);
    const total = await prisma.party.count({ where: { name: { in: NAMES } } });
    expect(total).toBe(3); // still 3, not 6
  });

  it('products import honours metal honesty — missing purity is NEVER assumed 22K', async () => {
    const r = await request(app.getHttpServer())
      .post('/imports/products/run')
      .set(auth())
      .attach('file', Buffer.from(PRODUCTS_CSV), 'products.csv')
      .field('mappings', JSON.stringify(P_MAP));
    expect(r.status).toBe(201);
    expect(r.body.counts.imported).toBe(2);
    const rows = await prisma.product.findMany({ where: { sku: { in: P_SKUS } }, select: { sku: true, metal: true, karat: true, organisationId: true } });
    const bySku = Object.fromEntries(rows.map((p) => [p.sku, p]));
    expect(bySku['ZZP-RING-1'].metal).toBe('gold_22k'); // 22 given -> 22K
    expect(bySku['ZZP-RING-1'].karat).toBe(22);
    expect(bySku['ZZP-CHAIN-2'].metal).toBe('gold_unspecified'); // NO metal/purity -> unspecified, not 22K
    expect(bySku['ZZP-CHAIN-2'].karat).toBe(0);
    expect(rows.every((p) => p.organisationId === 'org_eclat')).toBe(true);
  });

  it('XLSX import behaves exactly like CSV (same discovery + import)', async () => {
    const buf = await xlsxBuffer(
      ['Customer Name', 'Mobile', 'Email', 'City'],
      [['ZZXlsx One', '9876511111', 'x1@zz.test', 'Rajkot']],
    );
    const disc = await request(app.getHttpServer())
      .post('/imports/customers/discover').set(auth()).attach('file', buf, 'customers.xlsx');
    expect(disc.status).toBe(201);
    expect(disc.body.rowCount).toBe(1);
    expect(Object.fromEntries(disc.body.suggestions.map((s: any) => [s.sourceColumn, s.canonicalField]))['Mobile']).toBe('phone');

    const run = await request(app.getHttpServer())
      .post('/imports/customers/run').set(auth()).attach('file', buf, 'customers.xlsx').field('mappings', JSON.stringify(MAPPINGS));
    expect(run.status).toBe(201);
    expect(run.body.counts.imported).toBe(1);
    const p = await prisma.party.findFirst({ where: { name: 'ZZXlsx One' }, select: { phone: true, organisationId: true } });
    expect(p?.phone).toBe('9876511111');
    expect(p?.organisationId).toBe('org_eclat');
  });

  it('provides a downloadable template marking required and recommended fields', async () => {
    const r = await request(app.getHttpServer()).get('/imports/customers/template').set(auth());
    expect(r.status).toBe(200);
    expect(r.text).toContain('Customer Name*'); // required
    expect(r.text).toContain('Phone (recommended)'); // recommended
  });

  it('lists file upload plus profile-driven BUSY, Tally and ODBC agents', async () => {
    const r = await request(app.getHttpServer()).get('/integration/connectors').set(auth());
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.map((c: any) => [c.sourceSystem, c]));
    expect(byId['csv'].status).toBe('connected');
    expect(byId['tally'].status).toBe('connected');
    expect(byId['tally'].capabilities.supportsProducts).toBe(true);
    expect(byId['busy'].status).toBe('connected');
    expect(byId['busy'].capabilities.supportsCustomers).toBe(true);
    expect(byId['busy'].capabilities.supportsProducts).toBe(true);
    expect(byId['busy'].capabilities.supportsStock).toBe(false);
    expect(byId['odbc'].entities).toEqual(['customers', 'products', 'stores']);
    expect(byId['gati'].capabilities.supportsStock).toBe(true);
    expect(byId['gati'].capabilities.supportsPayments).toBe(false);
    expect(byId['gati'].entities).toContain('ledger');
    expect(byId['gati'].entities).not.toContain('payments');
  });

  it('exposes every on-premise ERP as an outbound push agent', async () => {
    const r = await request(app.getHttpServer())
      .get('/integration/connectors/runtime')
      .set(auth());
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.map((c: any) => [c.sourceSystem, c]));
    expect(byId.tally.runnable).toBe(false);
    expect(byId.tally.intakeMode).toBe('push');
    expect(byId.busy).toMatchObject({
      intakeMode: 'push',
      runnable: false,
      entities: ['customers', 'products'],
    });
    expect(byId.busy.fileImportFallback).toMatchObject({ sourceSystem: 'busy' });
    expect(byId.busy.status).toBe('not_configured');
    expect(byId.busy.notRunnableReason).toContain('No BUSY Connect agent is enrolled');
    expect(byId.odbc).toMatchObject({ intakeMode: 'push', runnable: false });
  });

  it('lists BUSY as available without allowing an inert cloud connection row', async () => {
    const catalogue = await request(app.getHttpServer())
      .get('/integrations-registry/providers')
      .set(auth());
    expect(catalogue.status).toBe(200);
    const busy = catalogue.body.providers.find((provider: any) => provider.code === 'busy');
    expect(busy).toMatchObject({
      available: true,
      credentialScope: 'on_premise',
      entities: ['customers', 'products'],
      blockedReason: null,
    });

    const create = await request(app.getHttpServer())
      .post('/integrations-registry')
      .set(auth())
      .send({ providerCode: 'busy', name: 'Wrong setup path' });
    expect(create.status).toBe(400);
    expect(create.body.message).toContain('Enrol it from Data & Imports');
  });

  it('enrols Tally and generic ODBC as narrow machine principals', async () => {
    for (const [sourceSystem, name] of [
      ['tally', CONNECT_AGENT_NAMES[0]],
      ['odbc', CONNECT_AGENT_NAMES[1]],
    ] as const) {
      const enrolled = await request(app.getHttpServer())
        .post('/integration/connect/agents')
        .set(auth())
        .send({ sourceSystem, name });
      expect(enrolled.status).toBe(201);
      expect(enrolled.body.agent).toMatchObject({ sourceSystem, name, status: 'enrolled' });
      expect(enrolled.body.token).toMatch(/^cxa_/);
      expect(enrolled.body.agent.token).toBeUndefined();
      agentTokens[sourceSystem] = enrolled.body.token;

      if (sourceSystem === 'tally') {
        const callerControlled = await request(app.getHttpServer())
          .post(`/integration/connect/agents/${enrolled.body.agent.id}/config`)
          .set(auth())
          .send({ config: { enabled: true, configRevision: 'caller-chosen' } });
        expect(callerControlled.status).toBe(400);
        expect(callerControlled.body.message).toMatch(/server-controlled/i);
      }

      const configured = await request(app.getHttpServer())
        .post(`/integration/connect/agents/${enrolled.body.agent.id}/config`)
        .set(auth())
        .send({
          config: {
            enabled: true,
            expectedProfileHash: MACHINE_PROFILE_HASH,
            expectedSourceInstanceHash: MACHINE_SOURCE_INSTANCE_HASH,
          },
        });
      expect(configured.status).toBe(201);
      const firstRevision = configured.body.config.configRevision;
      expect(firstRevision).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const replaced = await request(app.getHttpServer())
        .post(`/integration/connect/agents/${enrolled.body.agent.id}/config`)
        .set(auth())
        .send({
          config: {
            enabled: true,
            expectedProfileHash: MACHINE_PROFILE_HASH,
            expectedSourceInstanceHash: MACHINE_SOURCE_INSTANCE_HASH,
          },
        });
      expect(replaced.status).toBe(201);
      expect(replaced.body.config.configRevision).not.toBe(firstRevision);
      agentConfigRevisions[sourceSystem] = replaced.body.config.configRevision;
    }
  });

  it('machine dry-run is zero-write and a committed runKey replays one receipt', async () => {
    const csv = `External ID,Customer Name\n${MACHINE_CUSTOMER_CODE},${MACHINE_CUSTOMER}`;
    const readTallyLiveness = () =>
      prisma.connectAgent.findFirstOrThrow({
        where: {
          organisationId: 'org_eclat',
          sourceSystem: 'tally',
          name: CONNECT_AGENT_NAMES[0],
        },
        select: {
          status: true,
          lastSeenAt: true,
          lastSyncAt: true,
          lastError: true,
          agentVersion: true,
          hostname: true,
          os: true,
          lastStats: true,
          updatedAt: true,
        },
      });
    const beforeBatches = await prisma.importBatch.count({
      where: { organisationId: 'org_eclat', runKey: 'c'.repeat(64) },
    });
    const enrolledRuntime = await request(app.getHttpServer())
      .get('/integration/connectors/runtime')
      .set(auth());
    expect(
      enrolledRuntime.body.find((source: any) => source.sourceSystem === 'tally').status,
    ).toBe('needs_attention');
    const beforeHeartbeat = await readTallyLiveness();
    expect(beforeHeartbeat).toMatchObject({
      status: 'enrolled',
      lastSeenAt: null,
      agentVersion: null,
    });
    const heartbeat = await request(app.getHttpServer())
      .post('/integration/connect/heartbeat')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .send({ status: 'active', agentVersion: '0.3.0' });
    expect(heartbeat.status).toBe(201);
    const afterHeartbeat = await readTallyLiveness();
    expect(afterHeartbeat).toMatchObject({ status: 'active', agentVersion: '0.3.0' });
    expect(afterHeartbeat.lastSeenAt).toBeInstanceOf(Date);
    expect(afterHeartbeat.lastSeenAt?.getTime()).toBeGreaterThan(
      beforeHeartbeat.updatedAt.getTime(),
    );
    expect(afterHeartbeat.updatedAt.getTime()).toBeGreaterThan(
      beforeHeartbeat.updatedAt.getTime(),
    );
    const activeRuntime = await request(app.getHttpServer())
      .get('/integration/connectors/runtime')
      .set(auth());
    expect(
      activeRuntime.body.find((source: any) => source.sourceSystem === 'tally').status,
    ).toBe('needs_attention'); // healthy heartbeat alone cannot replace the approved source pin
    const identity = await request(app.getHttpServer())
      .get('/integration/connect/me')
      .set({ Authorization: `Bearer ${agentTokens.tally}` });
    expect(identity.status).toBe(200);
    expect(identity.body).toMatchObject({
      sourceSystem: 'tally',
      protocolVersion: 1,
      minimumAgentVersion: '0.3.0',
      enabled: true,
      expectedProfileHash: MACHINE_PROFILE_HASH,
      expectedSourceInstanceHash: MACHINE_SOURCE_INSTANCE_HASH,
      configRevision: agentConfigRevisions.tally,
    });
    // Identity is a control-plane read: authenticating the machine must not
    // make an offline agent look alive or rewrite any liveness/status field.
    expect(await readTallyLiveness()).toEqual(afterHeartbeat);

    const dryRun = await request(app.getHttpServer())
      .post('/imports/customers/preview')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .attach('file', Buffer.from(csv), 'tally-machine-customers.csv')
      .field('mappings', JSON.stringify(MACHINE_CUSTOMER_MAP))
      .field('sourceSystem', 'tally')
      .field('profileId', 'tally-machine-test')
      .field('profileHash', MACHINE_PROFILE_HASH)
      .field('sourceInstanceHash', MACHINE_SOURCE_INSTANCE_HASH);
    expect(dryRun.status).toBe(201);
    expect(dryRun.body).toMatchObject({ total: 1, error: 0 });
    // Preview validates data but is not a check-in and remains literally
    // zero-write for the ConnectAgent row as well as imported business data.
    expect(await readTallyLiveness()).toEqual(afterHeartbeat);
    expect(await prisma.party.count({ where: { organisationId: 'org_eclat', code: MACHINE_CUSTOMER_CODE } })).toBe(0);
    expect(await prisma.importBatch.count({ where: { organisationId: 'org_eclat', runKey: 'c'.repeat(64) } })).toBe(beforeBatches);
    expect(await prisma.connectAgent.findFirst({
      where: { organisationId: 'org_eclat', sourceSystem: 'tally' },
      select: { sourceInstanceHash: true },
    })).toEqual({ sourceInstanceHash: null });

    const missingRevision = await request(app.getHttpServer())
      .post('/imports/customers/run')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .attach('file', Buffer.from(csv), 'tally-machine-customers.csv')
      .field('mappings', JSON.stringify(MACHINE_CUSTOMER_MAP))
      .field('sourceSystem', 'tally')
      .field('runKey', 'a'.repeat(64))
      .field('profileId', 'tally-machine-test')
      .field('profileHash', MACHINE_PROFILE_HASH)
      .field('sourceInstanceHash', MACHINE_SOURCE_INSTANCE_HASH);
    expect(missingRevision.status).toBe(400);
    expect(missingRevision.body.message).toMatch(/configRevision is required/i);

    const staleRevision = await request(app.getHttpServer())
      .post('/imports/customers/run')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .attach('file', Buffer.from(csv), 'tally-machine-customers.csv')
      .field('mappings', JSON.stringify(MACHINE_CUSTOMER_MAP))
      .field('sourceSystem', 'tally')
      .field('runKey', 'b'.repeat(64))
      .field('profileId', 'tally-machine-test')
      .field('profileHash', MACHINE_PROFILE_HASH)
      .field('sourceInstanceHash', MACHINE_SOURCE_INSTANCE_HASH)
      .field('configRevision', 'stale-server-revision');
    expect(staleRevision.status).toBe(409);
    expect(staleRevision.body.message).toMatch(/configuration changed/i);

    const run = () => request(app.getHttpServer())
      .post('/imports/customers/run')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .attach('file', Buffer.from(csv), 'tally-machine-customers.csv')
      .field('mappings', JSON.stringify(MACHINE_CUSTOMER_MAP))
      .field('sourceSystem', 'tally')
      .field('runKey', 'c'.repeat(64))
      .field('profileId', 'tally-machine-test')
      .field('profileHash', MACHINE_PROFILE_HASH)
      .field('sourceInstanceHash', MACHINE_SOURCE_INSTANCE_HASH)
      .field('configRevision', agentConfigRevisions.tally);
    const first = await run();
    const replay = await run();
    expect(first.status).toBe(201);
    expect(first.body.counts.imported).toBe(1);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ batchId: first.body.batchId, replayed: true });
    expect(await prisma.importBatch.findUnique({
      where: { id: first.body.batchId },
      select: { configRevision: true },
    })).toEqual({ configRevision: agentConfigRevisions.tally });
    expect(await prisma.importBatch.count({ where: { organisationId: 'org_eclat', runKey: 'c'.repeat(64) } })).toBe(1);
    const machineAudit = await prisma.auditLog.findFirst({
      where: {
        organisationId: 'org_eclat',
        action: 'import.run',
        entityType: 'ImportBatch',
        entityId: first.body.batchId,
      },
      select: { actorId: true, machineActorId: true, actorName: true },
    });
    expect(machineAudit).toEqual({
      actorId: null,
      machineActorId: expect.any(String),
      actorName: CONNECT_AGENT_NAMES[0],
    });
    expect(await prisma.auditLog.count({
      where: {
        organisationId: 'org_eclat',
        action: 'import.run',
        entityId: first.body.batchId,
      },
    })).toBe(1); // replay is a read of the original receipt, not a second action
    expect(await prisma.party.count({ where: { organisationId: 'org_eclat', code: MACHINE_CUSTOMER_CODE } })).toBe(1);
    expect(await prisma.connectAgent.findFirst({
      where: { organisationId: 'org_eclat', sourceSystem: 'tally' },
      select: { sourceInstanceHash: true },
    })).toEqual({ sourceInstanceHash: MACHINE_SOURCE_INSTANCE_HASH });
    const pinnedRuntime = await request(app.getHttpServer())
      .get('/integration/connectors/runtime')
      .set(auth());
    expect(
      pinnedRuntime.body.find((source: any) => source.sourceSystem === 'tally').status,
    ).toBe('connected');
    const afterCommittedRun = await readTallyLiveness();
    const { updatedAt: _heartbeatUpdatedAt, ...heartbeatFields } = afterHeartbeat;
    const { updatedAt: _runUpdatedAt, ...runFields } = afterCommittedRun;
    expect(runFields).toEqual(heartbeatFields);

    const repointed = await request(app.getHttpServer())
      .post('/imports/customers/preview')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .attach('file', Buffer.from(csv), 'tally-machine-customers.csv')
      .field('mappings', JSON.stringify(MACHINE_CUSTOMER_MAP))
      .field('sourceSystem', 'tally')
      .field('profileId', 'tally-machine-test')
      .field('profileHash', MACHINE_PROFILE_HASH)
      .field('sourceInstanceHash', '9'.repeat(64));
    expect(repointed.status).toBe(409);
    expect(repointed.body.message).toMatch(/head-office-approved descriptor hash/i);
    const machineParty = await prisma.party.findFirstOrThrow({
      where: { organisationId: 'org_eclat', code: MACHINE_CUSTOMER_CODE },
      select: { id: true },
    });
    const provenance = await request(app.getHttpServer())
      .get(`/integration/connectors/provenance/party/${machineParty.id}`)
      .set(auth());
    expect(provenance.status).toBe(200);
    expect(provenance.body).toMatchObject({
      sourceSystem: 'tally',
      description: 'Synced from TALLY through CaratOS Connect.',
    });
  });

  it('updates a code-only customer and keeps a generic product material neutral', async () => {
    const updatedCsv = `External ID,Customer Name\n${MACHINE_CUSTOMER_CODE},${MACHINE_CUSTOMER_UPDATED}`;
    const update = await request(app.getHttpServer())
      .post('/imports/customers/run')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .attach('file', Buffer.from(updatedCsv), 'tally-machine-customers-updated.csv')
      .field('mappings', JSON.stringify(MACHINE_CUSTOMER_MAP))
      .field('sourceSystem', 'tally')
      .field('runKey', 'd'.repeat(64))
      .field('profileId', 'tally-machine-test')
      .field('profileHash', MACHINE_PROFILE_HASH)
      .field('sourceInstanceHash', MACHINE_SOURCE_INSTANCE_HASH)
      .field('configRevision', agentConfigRevisions.tally);
    expect(update.status).toBe(201);
    expect(update.body.counts.updated).toBe(1);
    expect(await prisma.party.findFirst({
      where: { organisationId: 'org_eclat', code: MACHINE_CUSTOMER_CODE },
      select: { name: true },
    })).toEqual({ name: MACHINE_CUSTOMER_UPDATED });

    const productCsv = `External ID,Item Name,Material,Category,UOM\n${MACHINE_PRODUCT_SKU},Steel Bolt,Steel,Fastener,pcs`;
    const product = await request(app.getHttpServer())
      .post('/imports/products/run')
      .set({ Authorization: `Bearer ${agentTokens.tally}` })
      .attach('file', Buffer.from(productCsv), 'tally-machine-products.csv')
      .field('mappings', JSON.stringify(MACHINE_PRODUCT_MAP))
      .field('sourceSystem', 'tally')
      .field('runKey', 'e'.repeat(64))
      .field('profileId', 'tally-machine-test')
      .field('profileHash', MACHINE_PROFILE_HASH)
      .field('sourceInstanceHash', MACHINE_SOURCE_INSTANCE_HASH)
      .field('configRevision', agentConfigRevisions.tally);
    expect(product.status).toBe(201);
    expect(product.body.counts.imported).toBe(1);
    expect(await prisma.product.findFirst({
      where: { organisationId: 'org_eclat', sku: MACHINE_PRODUCT_SKU },
      select: { metal: true, materialLabel: true, categoryLabel: true, unitOfMeasure: true },
    })).toEqual({
      metal: 'unspecified',
      materialLabel: 'Steel',
      categoryLabel: 'Fastener',
      unitOfMeasure: 'pcs',
    });
  });

  it('retains Tally as provenance when importing a manually exported CSV', async () => {
    const r = await request(app.getHttpServer())
      .post('/imports/customers/run')
      .set(auth())
      .attach('file', Buffer.from(TALLY_CSV), TALLY_FILE)
      .field('mappings', JSON.stringify(TALLY_MAPPINGS))
      .field('sourceSystem', 'tally');
    expect(r.status).toBe(201);
    expect(r.body.sourceSystem).toBe('tally');
    expect(r.body.counts.imported).toBe(1);
    const batch = await prisma.importBatch.findUnique({
      where: { id: r.body.batchId },
      select: { organisationId: true, sourceSystem: true, fileName: true },
    });
    expect(batch).toEqual({
      organisationId: 'org_eclat',
      sourceSystem: 'tally',
      fileName: TALLY_FILE,
    });
    const party = await prisma.party.findFirst({
      where: { organisationId: 'org_eclat', name: TALLY_CUSTOMER },
      select: { code: true },
    });
    expect(party?.code).toBe('tally:ledger-guid-1');
  });

  it('rejects document uploads instead of attempting to parse binary data as CSV', async () => {
    const r = await request(app.getHttpServer())
      .post('/imports/customers/discover')
      .set(auth())
      .attach('file', Buffer.from('%PDF-1.7 fake fixture'), 'customers.pdf');
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('reference documents');
  });

  it('rejects an invented source and ambiguous duplicate field mappings', async () => {
    const badSource = await request(app.getHttpServer())
      .post('/imports/customers/run')
      .set(auth())
      .attach('file', Buffer.from(TALLY_CSV), TALLY_FILE)
      .field('mappings', JSON.stringify(MAPPINGS))
      .field('sourceSystem', 'made-up-erp');
    expect(badSource.status).toBe(400);
    expect(badSource.body.message).toContain('Unsupported file source');

    const duplicateMapping = await request(app.getHttpServer())
      .post('/imports/customers/preview')
      .set(auth())
      .attach('file', Buffer.from(TALLY_CSV), TALLY_FILE)
      .field(
        'mappings',
        JSON.stringify([
          { sourceColumn: 'Customer Name', canonicalField: 'name' },
          { sourceColumn: 'Mobile', canonicalField: 'name' },
        ]),
      );
    expect(duplicateMapping.status).toBe(400);
    expect(duplicateMapping.body.message).toContain('mapped from more than one column');
  });
});

async function cleanup(prisma: PrismaService) {
  await prisma.auditLog.deleteMany({
    where: {
      organisationId: 'org_eclat',
      action: 'import.run',
      actorName: { in: CONNECT_AGENT_NAMES },
    },
  });
  await prisma.connectAgent.deleteMany({ where: { organisationId: 'org_eclat', name: { in: CONNECT_AGENT_NAMES } } });
  await prisma.importBatch.deleteMany({
    where: {
      organisationId: 'org_eclat',
      OR: [
        { fileName: { in: ['customers.csv', 'customers.xlsx', 'products.csv', TALLY_FILE] } },
        { runKey: { in: ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)] } },
      ],
    },
  });
  await prisma.party.deleteMany({ where: { name: { in: [...NAMES, 'ZZXlsx One', TALLY_CUSTOMER, MACHINE_CUSTOMER, MACHINE_CUSTOMER_UPDATED] } } });
  await prisma.product.deleteMany({ where: { sku: { in: [...P_SKUS, MACHINE_PRODUCT_SKU] } } });
}
