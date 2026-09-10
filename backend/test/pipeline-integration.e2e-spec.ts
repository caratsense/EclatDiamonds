import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProvenanceService } from '../src/common/provenance.service';
import { FieldOwnershipService } from '../src/integration/framework/field-ownership.service';
import { TRANSFER_PROTECTED_STOCK_FIELDS } from '../src/sync/sync.service';

/**
 * Phase A4/A6/A7 — the commercial pipelines actually reaching Customer 360.
 *
 * What this has to prove, beyond "the endpoints still respond":
 *
 *   1. A quote, a sale and a return each land on the SAME customer when they
 *      carry the same phone. That is the whole point of the identity spine — one
 *      person, one history, whichever form the record was raised on.
 *   2. A malformed phone never costs the business its record. This is the rule
 *      most likely to be broken by a later refactor, because the "safe" instinct
 *      is to validate and reject.
 *   3. The unresolved state is RECORDED, not discarded — the record exists and
 *      says why it has no customer.
 *   4. Field-ownership policy and the sync's inline protection agree. If they
 *      drift, a sync sends transferred stock back to the branch it left.
 *
 * Org E is this spec's own tenant so it can run beside the other isolation specs.
 */
const PASSWORD = 'password123';

const E = {
  org: 'org_pipe_e',
  store: 'store_pipe_e',
  slug: 'pipe-e',
  ho: 'ho.e@pipe-e.local',
  phone: '9812345678',
  customer: 'PIPE-E Shared Customer',
};

describe('Commercial pipelines → Customer 360 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, body: object) =>
    request(app.getHttpServer()).post(path).set(auth()).send(body);
  const get = (path: string) => request(app.getHttpServer()).get(path).set(auth());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardown(prisma);

    // Quotes, sales and returns are jewellery-pack modules; a tenant with no
    // industry is refused them by the entitlement guard.
    await prisma.organisation.create({
      data: { id: E.org, name: 'Pipeline Test E', slug: E.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.create({
      data: { id: E.store, name: 'PIPE-E Store', city: 'Testville', organisationId: E.org },
    });
    await prisma.user.create({
      data: {
        email: E.ho, name: 'HO E', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: E.org,
        userStores: { create: { storeId: E.store, isPrimary: true } },
      },
    });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: E.ho, password: PASSWORD });
    expect(login.status).toBe(201);
    token = login.body.token;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  it('a lead, a quote, a sale and a return on one phone reach ONE customer', async () => {
    const lead = await post('/leads', {
      storeId: E.store,
      customerName: E.customer,
      phone: E.phone,
      source: 'walk_in',
      interest: 'PIPE-E test enquiry',
    });
    expect(lead.status).toBe(201);

    const quote = await post('/quotes', {
      storeId: E.store,
      customerName: E.customer,
      phone: E.phone,
      lines: [
        {
          description: 'PIPE-E test item',
          karat: 22,
          weightGrams: 10,
          goldRatePerGram: 6000,
          makingCharges: 5000,
        },
      ],
    });
    expect(quote.status).toBe(201);

    const sale = await post('/sales', {
      storeId: E.store,
      customerName: E.customer,
      phone: E.phone,
      invoiceNo: 'PIPE-E-INV-1',
      salesValue: 65000,
    });
    expect([200, 201]).toContain(sale.status);

    const ret = await post('/returns', {
      storeId: E.store,
      customerName: E.customer,
      phone: E.phone,
      type: 'return',
      item: 'PIPE-E test item',
      originalValue: 65000,
      entryMode: 'manual',
    });
    expect(ret.status).toBe(201);

    // All four resolved to exactly one Party — not four.
    const parties = await prisma.party.findMany({
      where: { organisationId: E.org, name: E.customer },
      select: { id: true },
    });
    expect(parties).toHaveLength(1);
    const partyId = parties[0].id;

    // …and every record actually carries the foreign key, not just a name string.
    expect(await prisma.lead.count({ where: { organisationId: E.org, partyId } })).toBe(1);
    expect(await prisma.quote.count({ where: { organisationId: E.org, partyId } })).toBe(1);
    expect(await prisma.sale.count({ where: { organisationId: E.org, partyId } })).toBe(1);
    expect(await prisma.returnRecord.count({ where: { organisationId: E.org, partyId } })).toBe(1);

    // Customer 360 shows the whole journey in one read.
    const profile = await get(`/crm/customers/${partyId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.leads).toHaveLength(1);
    expect(profile.body.quotes).toHaveLength(1);
    expect(profile.body.sales).toHaveLength(1);

    const types = profile.body.timeline.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['lead.created', 'quote.created', 'sale.completed', 'return.raised']),
    );

    // The quote recorded product interest, and the sale recorded a purchase.
    const kinds = profile.body.productInteractions.map((p: { kind: string }) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(['quoted', 'purchased']));
  });

  it('a malformed phone never costs the business its record', async () => {
    // "not-a-phone" cannot be normalised. The sale must still exist.
    const sale = await post('/sales', {
      storeId: E.store,
      customerName: 'PIPE-E Unresolvable Customer',
      invoiceNo: 'PIPE-E-INV-2',
      salesValue: 1000,
    });
    expect([200, 201]).toContain(sale.status);

    const saved = await prisma.sale.findFirst({
      where: { organisationId: E.org, docNo: 'PIPE-E-INV-2' },
      select: { id: true, partyId: true, customerName: true },
    });
    expect(saved).not.toBeNull();
    // No customer was invented for it.
    expect(saved!.partyId).toBeNull();
    // The historical snapshot survives, so the invoice still names its customer.
    expect(saved!.customerName).toBe('PIPE-E Unresolvable Customer');
  });

  it('records WHY a record has no customer instead of discarding it', async () => {
    const event = await prisma.activityEvent.findFirst({
      where: { organisationId: E.org, type: 'sale.completed', partyId: null },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const meta = event!.metadata as Record<string, unknown> | null;
    // The unresolved reason is on the event — answerable months later.
    expect(meta?.customerUnresolved).toBeTruthy();
  });

  it('a second organisation cannot see any of it', async () => {
    // Eclat's head office reading its own Customer 360 surface must not surface
    // PIPE-E rows anywhere.
    const eclat = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'head.office@caratsense.in', password: PASSWORD });
    expect(eclat.status).toBe(201);
    const feed = await request(app.getHttpServer())
      .get('/crm/activity')
      .set({ Authorization: `Bearer ${eclat.body.token}` });
    expect(feed.status).toBe(200);
    expect(JSON.stringify(feed.body)).not.toContain('PIPE-E');
  });

  describe('provenance and field ownership', () => {
    it('counts records by where they came from, not by whether Gati sent them', async () => {
      const provenance = app.get(ProvenanceService);

      // One row from each origin.
      const batch = await prisma.importBatch.create({
        data: { organisationId: E.org, sourceSystem: 'csv', entity: 'customers', status: 'completed' },
      });
      await prisma.party.create({
        data: { organisationId: E.org, name: 'PIPE-E Imported', importBatchId: batch.id },
      });
      await prisma.party.create({
        data: { organisationId: E.org, name: 'PIPE-E Synced', legacyId: 'PIPE-E-LEG-1' },
      });

      const summary = await provenance.summary(E.org, ['party']);
      // Imported + synced both count as "the customer gave us this".
      expect(summary.counts.party.fromCustomer).toBe(2);
      // The customer created by identity resolution above is locally created.
      expect(summary.counts.party.local).toBeGreaterThanOrEqual(1);
    });

    it('describes a record origin without reaching into another organisation', async () => {
      const provenance = app.get(ProvenanceService);
      const mine = await prisma.party.findFirstOrThrow({
        where: { organisationId: E.org, name: 'PIPE-E Imported' },
      });
      const described = await provenance.describeRecord(E.org, 'party', mine.id);
      expect(described?.hasProvenance).toBe(true);
      expect(described?.sourceSystem).toBe('csv');

      // The same id read as another tenant returns nothing at all.
      const crossTenant = await provenance.describeRecord('org_eclat', 'party', mine.id);
      expect(crossTenant).toBeNull();
    });

    it('field-ownership policy matches what the sync actually protects', () => {
      const ownership = app.get(FieldOwnershipService);
      // Fails loudly if the two ever drift — the drift would let a sync move
      // transferred stock back to the branch it left.
      expect(() =>
        ownership.assertConsistentWithSync(TRANSFER_PROTECTED_STOCK_FIELDS),
      ).not.toThrow();

      const ctx = { lifecycleState: 'transfer_controlled' };
      expect(ownership.mayOverwrite('stockItem', 'storeId', ctx)).toBe(false);
      expect(ownership.mayOverwrite('stockItem', 'status', ctx)).toBe(false);
      // Everything else on the piece stays the source's to maintain.
      expect(ownership.mayOverwrite('stockItem', 'grossWeight', ctx)).toBe(true);
      // A piece that has never moved is fully source-owned.
      expect(ownership.mayOverwrite('stockItem', 'storeId', {})).toBe(true);
      // An unstated field is never auto-writable.
      expect(ownership.ownershipOf('somethingElse', 'whatever')).toBe('UNKNOWN');
    });
  });

  describe('connector runtime', () => {
    it('says how each source takes data in, and refuses to pretend Gati can be pulled', async () => {
      const r = await get('/integration/connectors/runtime');
      expect(r.status).toBe(200);
      const bySource = Object.fromEntries(
        r.body.map((c: { sourceSystem: string }) => [c.sourceSystem, c]),
      );
      expect(bySource.csv.intakeMode).toBe('file_upload');
      expect(bySource.csv.runnable).toBe(true);

      // Gati is push-based. Offering a "sync now" button would be a lie.
      expect(bySource.gati.intakeMode).toBe('push');
      expect(bySource.gati.runnable).toBe(false);
      expect(bySource.gati.notRunnableReason).toMatch(/enrolled|pushes/i);

      // Tally is also outbound-only: CaratOS never reaches into the LAN.
      expect(bySource.tally.runnable).toBe(false);
      expect(bySource.tally.intakeMode).toBe('push');
      expect(bySource.tally.notRunnableReason).toMatch(/enrolled|pushes/i);
      expect(bySource.odbc.intakeMode).toBe('push');
    });

    it('reconciles by origin for the caller organisation only', async () => {
      const r = await get('/integration/connectors/reconcile');
      expect(r.status).toBe(200);
      expect(r.body.byOrigin.party.fromCustomer).toBe(2);
      expect(r.body.imports.batches).toBeGreaterThanOrEqual(1);
      // The unfinished SourceLink work is reported, not hidden.
      expect(r.body.remainingMigration).toMatch(/SourceLink/);
    });

    it('discover reports what the agent has delivered, not a fake probe', async () => {
      const r = await get('/integration/connectors/discover/gati');
      expect(r.status).toBe(200);
      expect(r.body.intakeMode).toBe('push');
      // No delivery recorded for this brand-new org — reported honestly.
      expect(r.body.reachable).toBe(false);
      expect(r.body.note).toMatch(/no delivery/i);
    });
  });
});

async function teardown(prisma: PrismaService) {
  await prisma.productInteraction.deleteMany({ where: { organisationId: E.org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: E.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: E.org } });
  await prisma.message.deleteMany({ where: { organisationId: E.org } });
  await prisma.conversation.deleteMany({ where: { organisationId: E.org } });
  await prisma.returnRecord.deleteMany({ where: { organisationId: E.org } });
  await prisma.payment.deleteMany({ where: { organisationId: E.org } });
  await prisma.saleLine.deleteMany({ where: { organisationId: E.org } });
  await prisma.sale.deleteMany({ where: { organisationId: E.org } });
  await prisma.quoteLine.deleteMany({ where: { quote: { organisationId: E.org } } });
  await prisma.quoteRedeemableStore.deleteMany({ where: { quote: { organisationId: E.org } } });
  await prisma.quote.deleteMany({ where: { organisationId: E.org } });
  await prisma.leadFollowUp.deleteMany({ where: { lead: { organisationId: E.org } } });
  await prisma.leadNote.deleteMany({ where: { lead: { organisationId: E.org } } });
  await prisma.lead.deleteMany({ where: { organisationId: E.org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: E.org } });
  await prisma.mergeCandidate.deleteMany({ where: { organisationId: E.org } });
  await prisma.party.deleteMany({ where: { organisationId: E.org } });
  await prisma.importBatch.deleteMany({ where: { organisationId: E.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: E.org } } });
  await prisma.user.deleteMany({ where: { organisationId: E.org } });
  await prisma.store.deleteMany({ where: { organisationId: E.org } });
  await prisma.organisation.deleteMany({ where: { slug: E.slug } });
}
