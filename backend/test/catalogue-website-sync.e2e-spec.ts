import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PrismaService } from '../src/prisma/prisma.service';
import type { WebsiteCatalogueService } from '../src/catalogue/website/website-catalogue.service';
import type { SyncService } from '../src/sync/sync.service';

/**
 * Lossless website catalogue sync, end to end against a real database.
 *
 * THE WEBSITE IS A STUB. `WebsiteCatalogueClient.fetchImpl` is replaced by an
 * in-memory catalogue that paginates like the real feed; nothing here can reach
 * the live site. Picture indexing is a spy (the index agent owns the worker).
 *
 * Golden product 11871RG (test/fixtures/website/11871RG.json) plus the negative
 * controls from docs/modules/05-catalogue-sources.md that belong to the sync.
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = '1';
process.env.SCHEDULER_ENABLED = 'false';
delete process.env.WEBSITE_CATALOGUE_ALLOWED_HOSTS;

jest.setTimeout(240_000);

const PASSWORD = 'password123';
const TOKEN = 'svc-website-token-DO-NOT-LEAK-7f3a91';
const BASE = 'https://apis.eclatdiamonds.in/api';
const A = { org: 'org_catweb_a', slug: 'catweb-a', store: 'store_catweb_a', ho: 'ho@catweb-a.local', mgr: 'mgr@catweb-a.local' };
const B = { org: 'org_catweb_b', slug: 'catweb-b', store: 'store_catweb_b', ho: 'ho@catweb-b.local' };
const CAD_URL = 'https://r2.example.com/cad/11871RG.jpg';

const golden = () => JSON.parse(readFileSync(join(__dirname, 'fixtures/website/11871RG.json'), 'utf8'));
const simple = (i: number, extra: Record<string, unknown> = {}) => ({
  _id: `sim-${i}`,
  productCode: `SIM-${String(i).padStart(3, '0')}`,
  name: `Simple design ${i}`,
  category: [{ name: 'Rings' }],
  indicativePrice: 1000 + i,
  variants: [{ _id: `simv-${i}`, metalType: 'Gold', karat: '14KT', price: 1000 + i }],
  ...extra,
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    const where = { organisationId: org };
    await prisma.productImageAssociation.deleteMany({ where });
    await prisma.productPrice.deleteMany({ where });
    await prisma.productOption.deleteMany({ where });
    await prisma.productVariant.deleteMany({ where });
    await prisma.productWebsiteListing.deleteMany({ where });
    await prisma.productImage.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.externalProductSnapshot.deleteMany({ where });
    await prisma.catalogueSyncRun.deleteMany({ where });
    await prisma.catalogueConflict.deleteMany({ where });
    await prisma.jobTask.deleteMany({ where });
    await prisma.integrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where });
    await prisma.store.deleteMany({ where });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Website catalogue sync (e2e, stubbed website)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let website: WebsiteCatalogueService;
  let syncService: SyncService;
  const enqueued: { org: string; ids: string[] }[] = [];
  let hoA = '';
  let mgrA = '';
  let hoB = '';
  let gatiId = '';

  // ── the stub website ──────────────────────────────────────────────────────
  const site = { products: [] as unknown[], failPage: null as number | null, requests: [] as string[], auth: [] as string[] };
  const fakeFetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    site.requests.push(url);
    site.auth.push((init.headers as Record<string, string>).Authorization);
    if (u.hostname !== 'apis.eclatdiamonds.in') throw new Error('test attempted a non-stub host');
    const page = Number(u.searchParams.get('page'));
    const limit = Number(u.searchParams.get('limit'));
    if (page === site.failPage) return new Response('upstream down', { status: 503 });
    const data = site.products.slice((page - 1) * limit, page * limit);
    const total = site.products.length;
    return new Response(JSON.stringify({ data, total, totalPages: Math.max(1, Math.ceil(total / limit)) }), { status: 200 });
  };

  // Everything the process prints while syncing: the token and payloads must never appear.
  const printed: string[] = [];
  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function sync(token: string, body: Record<string, unknown>, org = A.org) {
    const res = await request(server()).post('/catalogue-integration/website/sync').set(auth(token)).send(body);
    expect(res.status).toBe(201);
    const job = await prisma.jobTask.findUniqueOrThrow({ where: { id: res.body.jobId } });
    const p = job.payload as { runId: string; claim: string };
    await website.execute(org, p.runId, new Date(p.claim));
    await prisma.jobTask.update({ where: { id: job.id }, data: { status: 'succeeded' } });
    return prisma.catalogueSyncRun.findUniqueOrThrow({ where: { id: p.runId } });
  }
  const listing = (productId: string) => prisma.productWebsiteListing.findUnique({ where: { productId } });
  const activeWebsiteImages = (productId: string) =>
    prisma.productImage.findMany({ where: { productId, source: 'website', status: 'active' }, orderBy: { sortOrder: 'asc' } });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const { WebsiteCatalogueService: W } = await import('../src/catalogue/website/website-catalogue.service');
    const { WebsiteCatalogueClient: C } = await import('../src/catalogue/website/website-catalogue.client');
    const { CatalogueIndexService: I } = await import('../src/products/catalogue-index.service');
    const { SyncService: S } = await import('../src/sync/sync.service');

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(I)
      .useValue({
        enqueue: async (org: string, ids: string[]) => {
          enqueued.push({ org, ids });
          return ids.length;
        },
        counts: async () => ({}),
        currentVersion: async () => null,
        rebuild: async () => ({ queued: 0, total: 0, purged: 0 }),
      })
      .compile();
    app = mod.createNestApplication();
    // Everything the application logs goes through here as well as the console.
    const capture = (...a: unknown[]) => {
      printed.push(a.map(String).join(' '));
    };
    app.useLogger({ log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    prisma = app.get(P);
    website = app.get(W);
    syncService = app.get(S);
    const client = app.get(C);
    client.fetchImpl = fakeFetch as never;
    client.retryBaseMs = 0;
    client.attempts = 2;
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const t of [A, B]) {
      await prisma.organisation.create({ data: { id: t.org, name: t.slug, slug: t.slug, industryPackCode: 'jewellery' } });
      await prisma.store.create({ data: { id: t.store, name: `${t.slug} main`, city: 'Surat', organisationId: t.org, timezone: 'Asia/Kolkata' } });
    }
    for (const [id, email, org, store, role] of [
      ['u_catweb_ho', A.ho, A.org, A.store, 'head_office'],
      ['u_catweb_mgr', A.mgr, A.org, A.store, 'store_manager'],
      ['u_catweb_ho_b', B.ho, B.org, B.store, 'head_office'],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: org,
          userStores: { create: { storeId: store, isPrimary: true } },
        },
      });
    }
    const login = async (email: string) =>
      (await request(server()).post('/auth/login').send({ email, password: PASSWORD }).expect(201)).body.token as string;
    hoA = await login(A.ho);
    mgrA = await login(A.mgr);
    hoB = await login(B.ho);

    // The Gati design 11871RG, with its CAD and its own tag price, in BOTH tenants.
    for (const org of [A.org, B.org]) {
      const p = await prisma.product.create({
        data: {
          organisationId: org,
          legacyId: `G-11871-${org}`,
          sku: '11871RG-050-G-18KT-YG-LG',
          name: 'GATI ITEM 11871RG',
          styleNumber: '11871RG',
          category: 'ring',
          metal: 'gold_18k',
          karat: 18,
          price: 123456,
          weightGrams: 8.07,
          hsn: '71131930',
          composition: { source: 'gati', lines: [{ item: 'Gold 18KT', kind: 'metal', weight: 8.07, unit: 'g' }] },
          gatiSyncedAt: new Date('2026-09-01T00:00:00Z'),
        },
      });
      await prisma.productImage.create({
        data: { organisationId: org, productId: p.id, url: CAD_URL, source: 'gati_cad', sourceUrl: CAD_URL, isPrimary: true },
      });
      await prisma.productPrice.create({ data: { organisationId: org, productId: p.id, source: 'gati', kind: 'gati_tag', amount: 199999 } });
      if (org === A.org) gatiId = p.id;
    }

  });

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    await app?.close();
  });

  // ── credential ──────────────────────────────────────────────────────────
  describe('credential', () => {
    it('is head-office only, allow-listed, and never echoed', async () => {
      await request(server())
        .post('/catalogue-integration/website/credential')
        .set(auth(mgrA))
        .send({ token: TOKEN, baseUrl: BASE })
        .expect(403);
      const bad = await request(server())
        .post('/catalogue-integration/website/credential')
        .set(auth(hoA))
        .send({ token: TOKEN, baseUrl: 'https://evil.example.com/api' });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(bad.body)).not.toContain(TOKEN);

      const ok = await request(server())
        .post('/catalogue-integration/website/credential')
        .set(auth(hoA))
        .send({ token: TOKEN, baseUrl: BASE })
        .expect(201);
      expect(ok.body).toEqual({ configured: true });

      const cred = await prisma.integrationCredential.findFirstOrThrow({ where: { organisationId: A.org, kind: 'service_token' } });
      expect(cred.ciphertext).not.toContain(TOKEN);
      expect(cred.ciphertext.startsWith('aad1:')).toBe(true);
      const audit = await prisma.auditLog.findMany({ where: { organisationId: A.org } });
      expect(JSON.stringify(audit)).not.toContain(TOKEN);

      const health = await request(server()).get('/catalogue-integration/health').set(auth(hoA)).expect(200);
      expect(health.body.website.configured).toBe(true);
      expect(health.body.website.host).toBe('apis.eclatdiamonds.in');
      expect(JSON.stringify(health.body)).not.toContain(TOKEN);
    });
  });

  // ── golden 11871RG ──────────────────────────────────────────────────────
  describe('golden 11871RG', () => {
    it('dry run previews the create and writes nothing', async () => {
      site.products = [golden()];
      const run = await sync(hoA, { mode: 'full', dryRun: true });
      expect(run).toMatchObject({ status: 'done', dryRun: true, expected: 1, created: 1 });
      const preview = (run.detail as { preview: { productCode: string; action: string; match: string; changes: string[] }[] }).preview;
      expect(preview[0]).toMatchObject({ productCode: '11871RG', action: 'created', match: 'gati' });
      expect(preview[0].changes).toEqual(expect.arrayContaining(['product.websiteCode', 'listing.created', 'variants +3', 'sizes +13', 'images +8']));
      expect(await prisma.productWebsiteListing.count({ where: { organisationId: A.org } })).toBe(0);
      expect(await prisma.externalProductSnapshot.count({ where: { organisationId: A.org } })).toBe(0);
      expect(await prisma.productVariant.count({ where: { organisationId: A.org } })).toBe(0);
      expect(site.auth.every((h) => h === `Bearer ${TOKEN}`)).toBe(true);
    });

    it('full run joins the Gati design and stores everything, labelled', async () => {
      enqueued.length = 0;
      const run = await sync(hoA, { mode: 'full' });
      expect(run).toMatchObject({ status: 'done', expected: 1, received: 1, created: 1, conflicted: 1, failed: 0 });

      // Joined to A's Gati design; Gati-owned fields untouched.
      const p = await prisma.product.findUniqueOrThrow({ where: { id: gatiId } });
      expect(p).toMatchObject({ websiteCode: '11871RG', name: 'GATI ITEM 11871RG', sku: '11871RG-050-G-18KT-YG-LG', metal: 'gold_18k', karat: 18, hsn: '71131930' });
      expect(Number(p.price)).toBe(123456);
      expect((p.composition as { source: string }).source).toBe('gati');
      expect(p.websiteSyncedAt).toBeTruthy();
      expect(await prisma.product.count({ where: { organisationId: A.org, legacyId: { startsWith: 'WEB-' } } })).toBe(0);
      // B's identical Gati design was not touched.
      expect(await prisma.product.findFirstOrThrow({ where: { organisationId: B.org } })).toMatchObject({ websiteCode: null });

      const l = await listing(gatiId);
      expect(l).toMatchObject({
        productCode: '11871RG',
        marketingName: "3ct Round Regent Solitaire Men's Ring",
        categories: ['Solitaires', 'Rings'],
        subCategories: ['Engagement Rings', 'Daily Wear', 'Rings', "All Men's Ring"],
        features: ['LATEST DESIGNS'],
        tags: ['MODERN ROYALTY', 'ANNIVERSARY COLLECTION', 'RING SOLITAIRE'],
        countries: ['IN', 'US'],
        isActive: true,
        isDeleted: false,
      });
      expect(l!.specifications).toContain('approx 8.07 g (18KT)');

      // Both sources' prices, each with its kind.
      const prices = await prisma.productPrice.findMany({ where: { productId: gatiId } });
      const one = (kind: string) => prices.filter((x) => x.kind === kind).map((x) => Number(x.amount));
      expect(one('indicative')).toEqual([185000]);
      expect(one('min_variant')).toEqual([155392.1]);
      expect(one('natural_diamond')).toEqual([3900000]);
      expect(one('variant').sort((a, b) => a - b)).toEqual([155392.1, 186758.6, 219264.2]);
      expect(one('variant_with_margin')).toHaveLength(3);
      expect(one('gati_tag')).toEqual([199999]);

      const variants = await prisma.productVariant.findMany({ where: { productId: gatiId }, orderBy: { karat: 'asc' } });
      expect(variants.map((v) => [v.karat, v.metal, Number(v.goldWeight), Number(v.diamondWeight), Number(v.totalWeight), Number(v.price)])).toEqual([
        [9, 'gold_9k', 6.7, 3.08, 9.78, 155392.1],
        [14, 'gold_14k', 7.66, 3.08, 10.74, 186758.6],
        [18, 'gold_18k', 8.7, 3.08, 11.78, 219264.2],
      ]);
      const minVariant = prices.find((x) => x.kind === 'variant' && Number(x.amount) === 155392.1)!;
      expect(minVariant.variantKey).toBe(variants[0].id);
      for (const v of variants) {
        const bom = v.bom as { rawMaterialId: string; materialName: string; unit: string; isDiamond: boolean }[];
        expect(bom).toHaveLength(2);
        expect(bom[0].rawMaterialId).toMatch(/^fakeraw-gold-/);
        expect(bom[1]).toMatchObject({ isDiamond: true, unit: 'gram', rawMaterialId: 'fakeraw-lgd-round' });
      }

      const sizes = await prisma.productOption.findMany({ where: { productId: gatiId, kind: 'size' }, orderBy: { sortOrder: 'asc' } });
      expect(sizes).toHaveLength(13);
      expect([sizes[0].value, sizes[12].value]).toEqual(['IND 6', 'IND 18']);

      // 8 pictures, 9 placements, 3 colours; the CAD first, website after.
      const web = await activeWebsiteImages(gatiId);
      expect(web).toHaveLength(8);
      const assoc = await prisma.productImageAssociation.findMany({ where: { image: { productId: gatiId }, tombstonedAt: null } });
      expect(assoc).toHaveLength(9);
      expect(new Set(assoc.map((a) => a.colour))).toEqual(new Set(['Rose Gold', 'White Gold', 'Yellow Gold']));
      const shared = web.find((i) => i.sourceUrl!.endsWith('side-shared.jpg'))!;
      expect(assoc.filter((a) => a.imageId === shared.id).map((a) => a.colour).sort()).toEqual(['Rose Gold', 'White Gold']);
      const all = await prisma.productImage.findMany({ where: { productId: gatiId, status: 'active' }, orderBy: { sortOrder: 'asc' } });
      expect(all[0]).toMatchObject({ source: 'gati_cad', isPrimary: true, sortOrder: 0 });
      expect(all.slice(1).every((i) => i.source === 'website' && !i.isPrimary)).toBe(true);
      expect(all[1].sourceUrl).toBe('https://cdn.example.com/products/11871RG/rose-front.jpg');
      expect(p.imageUrl).toBe(CAD_URL);

      // Spec/BOM disagreements preserved as conflicts, values uncorrected.
      const conflicts = await prisma.catalogueConflict.findMany({ where: { organisationId: A.org, productId: gatiId, status: 'open' } });
      expect(conflicts.map((c) => c.kind).sort()).toEqual(['spec_mismatch', 'unit_mismatch']);
      expect(Number(variants[2].goldWeight)).toBe(8.7);

      // Snapshot verbatim; new pictures queued for indexing for A only.
      const snap = await prisma.externalProductSnapshot.findFirstOrThrow({ where: { organisationId: A.org } });
      expect((snap.payload as { name: string }).name).toBe(golden().name);
      expect(snap.productId).toBe(gatiId);
      expect(enqueued).toEqual([{ org: A.org, ids: expect.arrayContaining(web.map((i) => i.id)) }]);
      expect(run.imagesQueued).toBe(8);
    });

    it('a replayed run is a no-op', async () => {
      enqueued.length = 0;
      const before = await prisma.productImage.count({ where: { productId: gatiId } });
      const run = await sync(hoA, { mode: 'full' });
      expect(run).toMatchObject({ status: 'done', unchanged: 1, created: 0, updated: 0 });
      expect(await prisma.productImage.count({ where: { productId: gatiId } })).toBe(before);
      expect(await prisma.productImageAssociation.count({ where: { image: { productId: gatiId } } })).toBe(9);
      expect(enqueued).toEqual([]);
    });

    it('a removed website picture is tombstoned; a repeated URL stays one picture', async () => {
      enqueued.length = 0;
      const g = golden();
      g.variantType[2].shapes[0].images.pop(); // yellow-hand.jpg
      site.products = [g];
      const run = await sync(hoA, { mode: 'full' });
      expect(run.status).toBe('done');
      const gone = await prisma.productImage.findFirstOrThrow({ where: { productId: gatiId, sourceUrl: { endsWith: 'yellow-hand.jpg' } } });
      expect(gone.status).toBe('tombstoned');
      expect(await activeWebsiteImages(gatiId)).toHaveLength(7);
      expect(await prisma.productImageAssociation.count({ where: { image: { productId: gatiId }, tombstonedAt: null } })).toBe(8);
      // The tombstoned picture is handed to the index to be purged.
      expect(enqueued.flatMap((e) => e.ids)).toContain(gone.id);
      expect((await prisma.productImage.findFirstOrThrow({ where: { productId: gatiId, source: 'gati_cad' } })).isPrimary).toBe(true);
    });

    it('byte-identical pictures under different URLs become one, with both placements', async () => {
      const rose = await prisma.productImage.findFirstOrThrow({ where: { productId: gatiId, sourceUrl: { endsWith: 'rose-front.jpg' } } });
      const white = await prisma.productImage.findFirstOrThrow({ where: { productId: gatiId, sourceUrl: { endsWith: 'white-front.jpg' } } });
      // What the index worker records after downloading both.
      await prisma.productImage.updateMany({ where: { id: { in: [rose.id, white.id] } }, data: { contentHash: 'sha-identical' } });
      const g = golden();
      g.variantType[2].shapes[0].images.pop();
      g.updatedAt = '2026-09-02T00:00:00.000Z';
      site.products = [g];
      for (let i = 0; i < 2; i++) {
        const run = await sync(hoA, { mode: 'full' });
        expect(run.status).toBe('done');
        expect((await prisma.productImage.findUniqueOrThrow({ where: { id: white.id } })).status).toBe('tombstoned');
        const onRose = await prisma.productImageAssociation.findMany({ where: { imageId: rose.id, tombstonedAt: null } });
        expect(onRose.map((a) => a.colour).sort()).toEqual(['Rose Gold', 'White Gold']);
        expect(await activeWebsiteImages(gatiId)).toHaveLength(6);
        g.updatedAt = '2026-09-03T00:00:00.000Z';
      }
    });
  });

  // ── pagination, partial runs, resume, restart ───────────────────────────
  describe('runs', () => {
    const catalogue = () => [...Array.from({ length: 104 }, (_, i) => simple(i)), golden()];

    it('a missing page makes the run partial and tombstones nothing; resume completes it', async () => {
      site.products = catalogue();
      site.failPage = 2;
      const partial = await sync(hoA, { mode: 'full' });
      expect(partial).toMatchObject({ status: 'partial', nextPage: 2, received: 100, expected: 105, tombstoned: 0 });
      expect(partial.lastError).toMatch(/Page 2/);
      // The golden design is on page 2: nothing about it was tombstoned.
      expect((await listing(gatiId))!.tombstonedAt).toBeNull();
      expect(await prisma.externalProductSnapshot.count({ where: { organisationId: A.org, goneAt: { not: null } } })).toBe(0);

      site.failPage = null;
      const resumed = await sync(hoA, { mode: 'resume' });
      expect(resumed.id).toBe(partial.id);
      expect(resumed).toMatchObject({ status: 'done', mode: 'resume', received: 105, expected: 105, nextPage: 3 });
      expect(await prisma.productWebsiteListing.count({ where: { organisationId: A.org, tombstonedAt: null } })).toBe(105);
    });

    it('a restart mid-sync resumes from the next page; the dead worker cannot write', async () => {
      const res = await request(server()).post('/catalogue-integration/website/sync').set(auth(hoA)).send({ mode: 'full' }).expect(201);
      const job = await prisma.jobTask.findUniqueOrThrow({ where: { id: res.body.jobId } });
      await prisma.jobTask.update({ where: { id: job.id }, data: { status: 'succeeded' } });
      const { runId, claim } = job.payload as { runId: string; claim: string };
      // The worker processed page 1 and died: the run says "running" but has gone quiet.
      const quiet = new Date(Date.now() - 20 * 60_000);
      await prisma.catalogueSyncRun.update({ where: { id: runId }, data: { nextPage: 2, heartbeatAt: quiet } });
      await prisma.externalProductSnapshot.updateMany({
        where: { organisationId: A.org, externalId: { in: Array.from({ length: 100 }, (_, i) => `sim-${i}`) } },
        data: { syncRunId: runId },
      });

      // A fresh runner may not start over it while it looks alive…
      await prisma.catalogueSyncRun.update({ where: { id: runId }, data: { heartbeatAt: new Date() } });
      await request(server()).post('/catalogue-integration/website/sync').set(auth(hoA)).send({ mode: 'full' }).expect(409);
      await prisma.catalogueSyncRun.update({ where: { id: runId }, data: { heartbeatAt: quiet } });

      // …but once stale, resume takes it over and finishes from page 2.
      site.requests.length = 0;
      const resumed = await sync(hoA, { mode: 'resume' });
      expect(resumed).toMatchObject({ id: runId, status: 'done', mode: 'resume' });
      expect(site.requests.every((u) => !u.includes('page=1&'))).toBe(true);
      // The original worker waking up is fenced out.
      await expect(website.execute(A.org, runId, new Date(claim))).resolves.toEqual({ skipped: 'run is owned by another worker' });
    });

    it('a design removed from the site is tombstoned; unpublished/deleted ones are flagged', async () => {
      const products = catalogue().filter((p) => (p as { productCode: string }).productCode !== 'SIM-000');
      products[0] = simple(1, { isActive: false });
      products[1] = simple(2, { isDeleted: true });
      site.products = products;
      const run = await sync(hoA, { mode: 'full' });
      expect(run).toMatchObject({ status: 'done', tombstoned: 1, expected: 104 });
      const gone = await prisma.product.findFirstOrThrow({ where: { organisationId: A.org, legacyId: 'WEB-SIM-000' } });
      expect((await listing(gone.id))!.tombstonedAt).not.toBeNull();
      expect((await prisma.externalProductSnapshot.findFirstOrThrow({ where: { organisationId: A.org, externalId: 'sim-0' } })).goneAt).not.toBeNull();
      const off = await prisma.product.findFirstOrThrow({ where: { organisationId: A.org, legacyId: 'WEB-SIM-001' } });
      expect(await listing(off.id)).toMatchObject({ isActive: false, tombstonedAt: null });
      const del = await prisma.product.findFirstOrThrow({ where: { organisationId: A.org, legacyId: 'WEB-SIM-002' } });
      expect(await listing(del.id)).toMatchObject({ isDeleted: true, tombstonedAt: null });
      // The Gati design is still listed.
      expect((await listing(gatiId))!.tombstonedAt).toBeNull();
    });

    it('the daily schedule queues one run per configured organisation, and it runs', async () => {
      process.env.SCHEDULER_ENABLED = 'true';
      try {
        expect(await website.scheduleDaily()).toBe(1);
        expect(await website.scheduleDaily()).toBe(1); // idempotent: same key, deduplicated
      } finally {
        process.env.SCHEDULER_ENABLED = 'false';
      }
      const jobs = await prisma.jobTask.findMany({ where: { kind: 'catalogue.website_sync', idempotencyKey: { contains: 'daily-' } } });
      expect(jobs.map((j) => j.organisationId)).toEqual([A.org]);
      const out = await (website as unknown as { runJob: (p: unknown, c: unknown) => Promise<unknown> }).runJob({}, { organisationId: A.org });
      expect(out).toEqual({ status: 'done' });
      await prisma.jobTask.updateMany({ where: { id: { in: jobs.map((j) => j.id) } }, data: { status: 'succeeded' } });
    });
  });

  // ── the join ─────────────────────────────────────────────────────────────
  describe('website ↔ Gati join', () => {
    it('no match: a website-only design with a gati_match_none conflict and its own metal', async () => {
      const onlyWeb = await prisma.product.findFirstOrThrow({ where: { organisationId: A.org, legacyId: 'WEB-SIM-003' } });
      expect(onlyWeb).toMatchObject({ name: 'Simple design 3', websiteCode: 'SIM-003', metal: 'gold_14k', karat: 14, category: 'ring' });
      const c = await prisma.catalogueConflict.findFirstOrThrow({ where: { organisationId: A.org, kind: 'gati_match_none', key: 'website:SIM003' } });
      expect(c.status).toBe('open');
    });

    it('ambiguous: nothing guessed, one website-only design, head office links it', async () => {
      const mk = (legacyId: string, styleNumber: string) =>
        prisma.product.create({
          data: { organisationId: A.org, legacyId, sku: `${legacyId}-SKU`, name: legacyId, styleNumber, metal: 'gold_22k', karat: 22, price: 777 },
        });
      const g1 = await mk('G-AMB-1', 'AMB01');
      await mk('G-AMB-2', 'amb 01');
      site.products = [...site.products, simple(900, { productCode: 'AMB-01', _id: 'amb-1' })];
      for (let i = 0; i < 2; i++) {
        const run = await sync(hoA, { mode: 'full' });
        expect(run.status).toBe('done');
      }
      const webOnly = await prisma.product.findMany({ where: { organisationId: A.org, legacyId: 'WEB-AMB-01' } });
      expect(webOnly).toHaveLength(1);
      const conflict = await prisma.catalogueConflict.findFirstOrThrow({ where: { organisationId: A.org, kind: 'gati_match_ambiguous' } });
      expect((conflict.detail as { candidates: unknown[] }).candidates).toHaveLength(2);
      expect(await prisma.product.count({ where: { organisationId: A.org, websiteCode: 'AMB-01' } })).toBe(1);

      const listed = await request(server()).get('/catalogue-integration/conflicts?status=open&kind=gati_match_ambiguous').set(auth(hoA)).expect(200);
      expect(listed.body.map((c: { id: string }) => c.id)).toEqual([conflict.id]);

      await request(server())
        .patch(`/catalogue-integration/conflicts/${conflict.id}`)
        .set(auth(hoA))
        .send({ status: 'resolved', resolution: { productId: g1.id } })
        .expect(200);
      const linked = await prisma.product.findUniqueOrThrow({ where: { id: g1.id } });
      expect(linked).toMatchObject({ websiteCode: 'AMB-01', name: 'G-AMB-1', metal: 'gold_22k', karat: 22 });
      expect(Number(linked.price)).toBe(777);
      expect(await listing(g1.id)).toMatchObject({ productCode: 'AMB-01' });
      expect(await prisma.product.count({ where: { organisationId: A.org, legacyId: 'WEB-AMB-01' } })).toBe(0);

      // The link holds on the next run.
      await sync(hoA, { mode: 'full' });
      expect(await listing(g1.id)).toMatchObject({ productCode: 'AMB-01', tombstonedAt: null });
      expect(await prisma.product.count({ where: { organisationId: A.org, legacyId: 'WEB-AMB-01' } })).toBe(0);
    });
  });

  // ── shop-PC path ─────────────────────────────────────────────────────────
  describe('POST /sync/website/raw', () => {
    it('refuses a person (machine ingestion only)', async () => {
      await request(server()).post('/sync/website/raw').set(auth(hoA)).send({ products: [] }).expect(403);
    });

    it('runs the same normalise/persist; a replayed page is idempotent; final closes the run', async () => {
      const inTx = <T>(fn: (tx: never) => Promise<T>) => prisma.$transaction((tx) => fn(tx as never), { timeout: 120_000 });
      const first = await inTx((tx) => website.ingestRawBatch(tx, A.org, { products: [golden()], expected: 2 }));
      expect(first).toMatchObject({ entity: 'website-raw', received: 1, upserted: 1, skipped: 0, status: 'running' });
      const replay = await inTx((tx) => website.ingestRawBatch(tx, A.org, { runId: first.runId, products: [golden()] }));
      expect(replay).toMatchObject({ received: 1, upserted: 1, runReceived: 1 });
      const bad = await inTx((tx) =>
        website.ingestRawBatch(tx, A.org, { runId: first.runId, products: [{ name: 'no code' }, simple(3)] }),
      );
      expect(bad).toMatchObject({ received: 2, upserted: 1, skipped: 1, failed: 1 });
      // The agent read everything but the distinct count is short of the total? Partial, no tombstones.
      const closed = await inTx((tx) =>
        website.ingestRawBatch(tx, A.org, { runId: first.runId, products: [], final: true, complete: false }),
      );
      expect(closed).toMatchObject({ status: 'partial', tombstoned: 0 });
      expect(await prisma.productWebsiteListing.count({ where: { organisationId: A.org, tombstonedAt: { not: null } } })).toBe(1);
      expect(await prisma.catalogueConflict.count({ where: { organisationId: A.org, kind: 'normalization_error' } })).toBe(1);
    });
  });

  // ── the old website path ─────────────────────────────────────────────────
  it('the old website import maps 9KT/14KT to their own metals, never 18K', async () => {
    await syncService.syncWebsiteProducts(A.org, [
      { productCode: 'OLD9', name: 'Old 9', karat: 9, imageUrl: 'https://cdn.example.com/old9.jpg' },
      { productCode: 'OLD14', name: 'Old 14', karat: 14 },
      { productCode: 'OLDX', name: 'Old unknown' },
    ]);
    const metals = await prisma.product.findMany({
      where: { organisationId: A.org, legacyId: { in: ['WEB-OLD9', 'WEB-OLD14', 'WEB-OLDX'] } },
      select: { legacyId: true, metal: true },
      orderBy: { legacyId: 'asc' },
    });
    expect(metals).toEqual([
      { legacyId: 'WEB-OLD14', metal: 'gold_14k' },
      { legacyId: 'WEB-OLD9', metal: 'gold_9k' },
      { legacyId: 'WEB-OLDX', metal: 'gold_unspecified' },
    ]);
    const img = await prisma.productImage.findFirstOrThrow({ where: { organisationId: A.org, url: 'https://cdn.example.com/old9.jpg' } });
    expect(img).toMatchObject({ source: 'website', sourceUrl: 'https://cdn.example.com/old9.jpg', isPrimary: true });
  });

  // ── isolation and secrecy ────────────────────────────────────────────────
  it('another tenant sees none of the runs, conflicts, snapshots or credential', async () => {
    const runs = await request(server()).get('/catalogue-integration/runs').set(auth(hoB)).expect(200);
    expect(runs.body).toEqual([]);
    const conflicts = await request(server()).get('/catalogue-integration/conflicts').set(auth(hoB)).expect(200);
    expect(conflicts.body).toEqual([]);
    const aConflict = await prisma.catalogueConflict.findFirstOrThrow({ where: { organisationId: A.org } });
    await request(server()).patch(`/catalogue-integration/conflicts/${aConflict.id}`).set(auth(hoB)).send({ status: 'ignored' }).expect(404);
    const health = await request(server()).get('/catalogue-integration/health').set(auth(hoB)).expect(200);
    expect(health.body.website).toMatchObject({ configured: false, lastRun: null, listingsActive: 0 });
    await request(server()).post('/catalogue-integration/website/sync').set(auth(hoB)).send({ mode: 'full' }).expect(400);
    expect(await prisma.externalProductSnapshot.count({ where: { organisationId: B.org } })).toBe(0);
    expect(await prisma.productWebsiteListing.count({ where: { organisationId: B.org } })).toBe(0);
    await request(server()).get('/catalogue-integration/runs').set(auth(mgrA)).expect(403);

    const aRuns = await request(server()).get('/catalogue-integration/runs').set(auth(hoA)).expect(200);
    expect(aRuns.body.length).toBeGreaterThan(3);
    expect(JSON.stringify(aRuns.body)).not.toContain(TOKEN);
  });

  it('connects to the public feed without a token and sends no Authorization header', async () => {
    await request(server()).post('/catalogue-integration/website/credential').set(auth(hoB)).send({ baseUrl: BASE }).expect(201);
    expect(await prisma.integrationCredential.count({ where: { organisationId: B.org } })).toBe(0);
    const health = await request(server()).get('/catalogue-integration/health').set(auth(hoB)).expect(200);
    expect(health.body.website).toMatchObject({ configured: true, tokenStored: false, baseUrl: BASE });

    site.products = [golden()];
    const before = site.auth.length;
    const run = await sync(hoB, { mode: 'full', dryRun: true }, B.org);
    expect(run).toMatchObject({ status: 'done', dryRun: true, expected: 1 });
    expect(site.auth.length).toBeGreaterThan(before);
    expect(site.auth.slice(before).every((h) => h === undefined)).toBe(true);
  });

  it('never printed the credential or a product payload', () => {
    const out = printed.join('');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('fakeraw-gold');
    expect(out).not.toContain('Synthetic test fixture');
  });
});
