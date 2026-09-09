import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SyncService } from '../src/sync/sync.service';

/**
 * CaratOS Phase B1 — the two data-safety defects, proven from the outside.
 *
 * DEFECT 1 (data loss). `purgeDemo` is the documented go-live operation: it
 * clears seeded demo data once a client's real data has arrived. Its rule was
 * "a row with no legacyId came from the seed, so delete it". That was true until
 * the file-import engine shipped — an imported customer has no legacyId either.
 * So the purge deleted every customer and product a client had uploaded from
 * their own spreadsheet, and the counts still added up.
 *
 * This spec builds exactly that situation: one seeded customer, one imported
 * customer, one connector-synced customer, then runs the purge and checks which
 * of the three survive. The imported one MUST.
 *
 * DEFECT 2 (cross-tenant read). `GET /scheduler/runs` took no user and filtered
 * on nothing, so any manager could read every tenant's job history.
 *
 * Org D is this spec's own tenant so it can run beside the other isolation specs.
 */
const PASSWORD = 'password123';

const D = {
  org: 'org_safety_d',
  store: 'store_safety_d',
  slug: 'safety-d',
  ho: 'ho.d@safety-d.local',
  batch: 'batch_safety_d',
};

describe('Data safety: purge provenance + scheduler scoping (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sync: SyncService;
  let hoToken: string;
  let hoUser: { id: string };

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    sync = app.get(SyncService);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: D.org, name: 'Safety Test D', slug: D.slug } });
    await prisma.store.create({
      data: { id: D.store, name: 'SAFETY-D Store', city: 'Testville', organisationId: D.org },
    });
    const ho = await prisma.user.create({
      data: {
        email: D.ho, name: 'HO D', role: 'head_office', passwordHash: hash,
        isActive: true, approvalStatus: 'approved', organisationId: D.org,
      },
    });
    hoUser = { id: ho.id };

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: D.ho, password: PASSWORD });
    expect(login.status).toBe(201);
    hoToken = login.body.token;
  });

  afterAll(async () => {
    await teardown(prisma);
    await app?.close();
  });

  describe('purgeDemo must not delete file-imported data', () => {
    beforeAll(async () => {
      // The three kinds of row that can coexist at go-live.
      await prisma.importBatch.create({
        data: {
          id: D.batch,
          organisationId: D.org,
          sourceSystem: 'csv',
          entity: 'customers',
          fileName: 'client-customers.csv',
          status: 'completed',
          discovered: 1,
          imported: 1,
        },
      });

      await prisma.party.createMany({
        data: [
          // (a) Seeded demo — no provenance at all. SHOULD be deleted.
          { id: 'party_d_demo', organisationId: D.org, storeId: D.store, name: 'SAFETY-D Demo Customer' },
          // (b) Uploaded by the client from a spreadsheet. MUST SURVIVE.
          { id: 'party_d_import', organisationId: D.org, storeId: D.store, name: 'SAFETY-D Imported Customer', importBatchId: D.batch },
          // (c) Pulled by the connector. Already survived before this fix.
          { id: 'party_d_sync', organisationId: D.org, storeId: D.store, name: 'SAFETY-D Synced Customer', legacyId: 'SAFETY-D-LEG-1' },
        ],
      });
      await prisma.product.createMany({
        data: [
          { id: 'prod_d_demo', organisationId: D.org, storeId: D.store, sku: 'SAFETY-D-DEMO', name: 'Demo item', metal: 'gold_22k', embedding: [] },
          { id: 'prod_d_import', organisationId: D.org, storeId: D.store, sku: 'SAFETY-D-IMPORT', name: 'Imported item', metal: 'gold_22k', embedding: [], importBatchId: D.batch },
        ],
      });
    });

    it('counts imported rows as real client data, so the purge is allowed to run', async () => {
      // The "is there real data?" gate used to look only at legacyId. A client
      // who imported by spreadsheet and never ran the connector would have been
      // told there was nothing to switch over to.
      const dry = await sync.purgeDemo({ ...actor(hoUser.id) } as never, undefined);
      expect((dry as { dryRun: boolean }).dryRun).toBe(true);
      const counts = (dry as { realDataFound: Record<string, number> }).realDataFound;
      // 2 parties (imported + synced) and 1 product (imported) are client data.
      expect(counts.parties).toBeGreaterThanOrEqual(2);
      expect(counts.products).toBeGreaterThanOrEqual(1);
    });

    it('the dry run does not offer to delete the imported rows', async () => {
      const dry = (await sync.purgeDemo({ ...actor(hoUser.id) } as never, undefined)) as {
        wouldDelete: Record<string, number>;
      };
      // Exactly one demo party and one demo product — never the imported ones.
      expect(dry.wouldDelete.party).toBe(1);
      expect(dry.wouldDelete.product).toBe(1);
    });

    it('ARMED: deletes the seeded row and keeps the imported one', async () => {
      await sync.purgeDemo({ ...actor(hoUser.id) } as never, 'DELETE DEMO DATA');

      const survivors = await prisma.party.findMany({
        where: { organisationId: D.org },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const ids = survivors.map((s) => s.id);

      // The regression this whole spec exists for.
      expect(ids).toContain('party_d_import');
      expect(ids).toContain('party_d_sync');
      expect(ids).not.toContain('party_d_demo');

      const products = await prisma.product.findMany({
        where: { organisationId: D.org },
        select: { id: true },
      });
      expect(products.map((p) => p.id)).toEqual(['prod_d_import']);
    });

    it('keeps a store that was created by a spreadsheet import', async () => {
      const imported = await prisma.store.create({
        data: {
          id: 'store_d_imported',
          organisationId: D.org,
          name: 'SAFETY-D Imported Branch',
          city: 'Testville',
          importBatchId: D.batch,
        },
      });
      await sync.purgeDemo({ ...actor(hoUser.id) } as never, 'DELETE DEMO DATA');
      const still = await prisma.store.findUnique({ where: { id: imported.id } });
      expect(still).not.toBeNull();
    });
  });

  describe('GET /scheduler/runs is bounded to the caller organisation', () => {
    beforeAll(async () => {
      await prisma.scheduledJobRun.createMany({
        data: [
          { organisationId: D.org, job: 'safety.d.job', scope: D.store, runKey: 'safety-d-1', startedAt: new Date(), status: 'ok' },
          // Another tenant's run, and a platform run with no tenant at all.
          { organisationId: 'org_eclat', job: 'safety.other.job', scope: 'other', runKey: 'safety-other-1', startedAt: new Date(), status: 'ok' },
          { organisationId: null, job: 'safety.platform.job', scope: 'global', runKey: 'safety-platform-1', startedAt: new Date(), status: 'ok' },
        ],
      });
    });

    it('returns only this organisation runs, and no platform-wide ones', async () => {
      const r = await request(app.getHttpServer()).get('/scheduler/runs').set(auth(hoToken));
      expect(r.status).toBe(200);
      const jobs = r.body.map((x: { job: string }) => x.job);
      expect(jobs).toContain('safety.d.job');
      expect(jobs).not.toContain('safety.other.job');
      expect(jobs).not.toContain('safety.platform.job');
    });

    it('still refuses an unauthenticated caller', async () => {
      const r = await request(app.getHttpServer()).get('/scheduler/runs');
      expect(r.status).toBe(401);
    });
  });

  describe('background job queue', () => {
    it('deduplicates an enqueue while the same work is still pending', async () => {
      const jobs = app.get(
        (await import('../src/jobs/jobs.service')).JobsService,
      );
      jobs.register('safety.test.noop', async () => ({ ok: true }));

      const key = `${D.org}:safety-test-1`;
      const first = await jobs.enqueue({ kind: 'safety.test.noop', payload: {}, organisationId: D.org, idempotencyKey: key });
      const second = await jobs.enqueue({ kind: 'safety.test.noop', payload: {}, organisationId: D.org, idempotencyKey: key });

      expect(second.deduplicated).toBe(true);
      expect(second.id).toBe(first.id);

      const outcome = await jobs.drain(5);
      expect(outcome.succeeded).toBeGreaterThanOrEqual(1);

      const done = await prisma.jobTask.findUnique({ where: { id: first.id } });
      expect(done?.status).toBe('succeeded');
    });

    it('refuses to queue work no handler can run', async () => {
      const jobs = app.get((await import('../src/jobs/jobs.service')).JobsService);
      await expect(
        jobs.enqueue({ kind: 'safety.test.nonexistent', payload: {}, organisationId: D.org }),
      ).rejects.toThrow(/No handler registered/);
    });
  });
});

/**
 * purgeDemo takes an AuthUser. It only reads `organisationId`, `id` and `name`,
 * so a minimal principal exercises the real code path without standing up a
 * second HTTP session.
 */
function actor(userId: string) {
  return {
    id: userId,
    name: 'HO D',
    email: D.ho,
    role: 'head_office',
    organisationId: D.org,
    storeIds: [D.store, 'store_d_imported'],
    allStores: true,
  };
}

async function teardown(prisma: PrismaService) {
  await prisma.jobTask.deleteMany({ where: { organisationId: D.org } });
  await prisma.scheduledJobRun.deleteMany({
    where: { runKey: { in: ['safety-d-1', 'safety-other-1', 'safety-platform-1'] } },
  });
  await prisma.auditLog.deleteMany({ where: { organisationId: D.org } });
  await prisma.activityEvent.deleteMany({ where: { organisationId: D.org } });
  await prisma.contactPoint.deleteMany({ where: { organisationId: D.org } });
  await prisma.product.deleteMany({ where: { organisationId: D.org } });
  await prisma.party.deleteMany({ where: { organisationId: D.org } });
  await prisma.importBatch.deleteMany({ where: { organisationId: D.org } });
  await prisma.userStore.deleteMany({ where: { store: { organisationId: D.org } } });
  await prisma.user.deleteMany({ where: { organisationId: D.org } });
  await prisma.store.deleteMany({ where: { organisationId: D.org } });
  await prisma.organisation.deleteMany({ where: { slug: D.slug } });
}
