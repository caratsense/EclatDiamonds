import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JobsService } from '../src/jobs/jobs.service';
import { StorageService } from '../src/storage/storage.service';
import { MlInferenceService } from '../src/products/ml-inference.service';
import { CatalogueIndexService, EMBED_JOB, THUMB_JOB } from '../src/products/catalogue-index.service';
import { orderImages, OrderableImage } from '../src/catalogue/image-order';

/**
 * Durable catalogue indexing + the search that reads it (Module 5,
 * docs/modules/05-catalogue-sources.md "Index + search"). Synthetic only: a
 * local HTTP server stands in for the image hosts, MlInferenceService is
 * mocked, and the queue is driven with JobsService.drain().
 */

// ---------------------------------------------------------------- image order
describe('image order (pure)', () => {
  const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);
  const img = (id: string, source: string, extra: Partial<OrderableImage> = {}): OrderableImage => ({
    id,
    source,
    pinnedPrimary: false,
    status: 'active',
    sourceOrder: 0,
    createdAt: at(0),
    ...extra,
  });

  it('pin > CAD > website (source order) > manual > inventory > other', () => {
    const out = orderImages([
      img('other', 'other'),
      img('inv', 'inventory'),
      img('manual', 'manual', { createdAt: at(1) }),
      img('web2', 'website', { sourceOrder: 2 }),
      img('web1', 'website', { sourceOrder: 1 }),
      img('cad', 'gati_cad'),
      img('pinned', 'manual', { pinnedPrimary: true, createdAt: at(9) }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['pinned', 'cad', 'web1', 'web2', 'manual', 'inv', 'other']);
  });

  it('without a pin the CAD leads', () => {
    expect(orderImages([img('web', 'website'), img('cad', 'gati_cad')])[0].id).toBe('cad');
  });

  it('a CAD whose download or decode died falls back behind the first website photo', () => {
    const dead = img('cad', 'gati_cad', { embeddingStatus: 'dead', embeddingError: 'download failed: HTTP 404' });
    expect(orderImages([dead, img('web', 'website')]).map((i) => i.id)).toEqual(['web', 'cad']);
    const undecodable = img('cad', 'gati_cad', { embeddingStatus: 'dead', embeddingError: 'decode failed: cannot identify image' });
    expect(orderImages([undecodable, img('web', 'website')])[0].id).toBe('web');
  });

  it('a CAD that died for a reason unrelated to the picture (inference down) keeps its place', () => {
    const cad = img('cad', 'gati_cad', { embeddingStatus: 'dead', embeddingError: 'inference failed: HTTP 502' });
    expect(orderImages([img('web', 'website'), cad])[0].id).toBe('cad');
  });

  it('tombstoned pictures are not ordered at all', () => {
    expect(orderImages([img('cad', 'gati_cad', { status: 'tombstoned' }), img('web', 'website')]).map((i) => i.id)).toEqual(['web']);
  });
});

// ------------------------------------------------------------------------ e2e
const PASSWORD = 'password123';
const REP = 'priya.rep@caratsense.in'; // salesperson, Surat — Main
const HO = 'head.office@caratsense.in';
const ORG = 'org_eclat';
const SURAT = 'surat-main';
const DIM = 8;
const e = (i: number, j?: number, w = 0.3) => {
  const v = Array(DIM).fill(0);
  v[i] = 1;
  if (j != null) v[j] = w;
  return v;
};

/** JPEG magic + a vector marker the mock inference reads back out. */
const jpegWith = (vec: number[], salt = '') =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`|VEC:${vec.join(',')}|${salt}`)]);

let release: (() => void) | null = null;
const mock = {
  available: true,
  versions: { dino: 'd1', siglip: 's1', preprocessing: 'pp1' },
  indexCalls: 0,
  searchCalls: 0,
  searchVec: e(0),
  /** When set, searches wait here — to hold slots open for the 429 test. */
  gate: null as Promise<void> | null,
  async currentVersions() {
    return this.versions;
  },
  cachedVersions() {
    return this.versions;
  },
  async embedBatch(items: { id: string; bytes: Buffer; mime: string }[], opts: { thumbnailPx?: number } = {}) {
    if (opts.thumbnailPx) {
      this.indexCalls++;
      const ok = items.filter((i) => /VEC:/.test(i.bytes.toString('latin1')));
      return {
        results: ok.map((i) => {
          const v = /VEC:([-\d.,]+)\|/.exec(i.bytes.toString('latin1'))![1].split(',').map(Number);
          return {
            id: i.id,
            dino: v,
            siglip: v,
            views: [],
            thumb: { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), mime: 'image/jpeg' },
            width: 800,
            height: 600,
          };
        }),
        errors: items.filter((i) => !ok.includes(i)).map((i) => ({ id: i.id, error: 'cannot identify image file' })),
        timings: {},
        wallMs: 1,
      };
    }
    this.searchCalls++;
    if (this.gate) await this.gate;
    return {
      results: items.map((i) => ({ id: i.id, dino: this.searchVec, siglip: this.searchVec, views: [] })),
      errors: [],
      timings: { decode: 1, detect: 1, dino: 1, siglip: 1 },
      wallMs: 5,
    };
  },
};

describe('Catalogue index + search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  let index: CatalogueIndexService;
  let server: Server;
  let base = '';
  const tokens: Record<string, string> = {};
  const P = ['catidx-p1', 'catidx-p2', 'catidx-p3', 'catidx-p4', 'catidx-p5'];
  let flaky = 503;
  let realPng: Buffer | null = null;
  // Its own storage: deleting thumbnails in the shared uploads folder wiped the
  // running local app's real ones.
  const uploadDir = mkdtempSync(join(tmpdir(), 'eclat-catidx-'));

  beforeAll(async () => {
    // A stand-in image host: /v/<csv>/<salt>.jpg -> a picture of that vector.
    server = createServer((req, res) => {
      const m = /^\/v\/([-\d.,]+)\/(.*)$/.exec(req.url ?? '');
      if (m) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(jpegWith(m[1].split(',').map(Number), m[2]));
      }
      if (req.url === '/real.png' && realPng) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(realPng);
      }
      if (req.url === '/flaky.jpg') {
        res.writeHead(flaky);
        return res.end();
      }
      if (req.url === '/svg.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    process.env.SCHEDULER_ENABLED = 'false';
    process.env.SEARCH_MAX_CONCURRENT = '2';
    process.env.RATE_LIMIT_EXPENSIVE = '1000';
    process.env.CATALOGUE_IMAGE_ALLOWED_HOSTS = new URL(base).host;
    process.env.UPLOAD_DIR = uploadDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MlInferenceService)
      .useValue(mock)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    jobs = app.get(JobsService);
    index = app.get(CatalogueIndexService);

    for (const [k, email] of [['rep', REP], ['ho', HO]] as const) {
      tokens[k] = (await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD })).body.token;
    }
    await cleanup();
    for (const id of P) {
      await prisma.product.create({
        data: { id, sku: id.toUpperCase(), name: `Index test ${id}`, metal: 'gold_18k', organisationId: ORG, storeId: SURAT },
      });
    }
  });

  async function cleanup() {
    await prisma.jobTask.deleteMany({ where: { kind: { in: [EMBED_JOB, THUMB_JOB] } } });
    await prisma.productEmbedding.deleteMany({ where: { productId: { in: [...P, 'catidx-b1'] } } });
    await prisma.productImage.deleteMany({ where: { productId: { in: [...P, 'catidx-b1'] } } });
    await prisma.product.deleteMany({ where: { id: { in: [...P, 'catidx-b1'] } } });
    await prisma.store.deleteMany({ where: { organisationId: 'org_catidx_b' } });
    await prisma.organisation.deleteMany({ where: { id: 'org_catidx_b' } });
  }

  afterAll(async () => {
    if (prisma) await cleanup();
    rmSync(uploadDir, { recursive: true, force: true });
    await app?.close();
    await new Promise((r) => server?.close(r));
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.SEARCH_MAX_CONCURRENT;
    delete process.env.RATE_LIMIT_EXPENSIVE;
    delete process.env.CATALOGUE_IMAGE_ALLOWED_HOSTS;
    delete process.env.UPLOAD_DIR;
  });

  const addImage = (productId: string, url: string, extra: Record<string, unknown> = {}) =>
    prisma.productImage.create({ data: { organisationId: ORG, productId, url, ...extra } });
  const vecUrl = (v: number[], salt: string) => `${base}/v/${v.join(',')}/${salt}.jpg`;
  const image = (id: string) => prisma.productImage.findUniqueOrThrow({ where: { id } });
  const search = (bytes: Buffer = jpegWith(e(0), `q${Math.random()}`)) =>
    request(app.getHttpServer())
      .post('/products/jewelry/similarity-search')
      .set('Authorization', `Bearer ${tokens.rep}`)
      .attach('files', bytes, { filename: 'q.jpg', contentType: 'image/jpeg' });

  let img1 = '';

  it('enqueue is idempotent: one job per picture, however often it is asked', async () => {
    img1 = (await addImage(P[0], vecUrl(e(0), 'p1-front'), { source: 'website' })).id;
    expect(await index.enqueue(ORG, [img1])).toBe(1);
    expect(await index.enqueue(ORG, [img1])).toBe(0);
    expect(await index.enqueue(ORG, [img1, img1])).toBe(0);
    expect(await prisma.jobTask.count({ where: { kind: EMBED_JOB, payload: { equals: { imageId: img1 } } } })).toBe(1);
    expect((await image(img1)).embeddingStatus).toBe('queued');
  });

  it('the worker downloads, hashes, thumbnails and embeds; the picture records it', async () => {
    await jobs.drain(10);
    const m = await image(img1);
    expect(m.embeddingStatus).toBe('indexed');
    expect(m.embeddingVersion).toBe('idx1|d1|s1|pp1');
    expect(m.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.thumbUrl).toMatch(/catalogue-thumbs/);
    expect([m.width, m.height]).toEqual([800, 600]);
    const rows = await prisma.productEmbedding.findMany({ where: { productImageId: img1 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].storeId).toBe(SURAT);
    // Indexed at the current version: asking again queues nothing.
    expect(await index.enqueue(ORG, [img1])).toBe(0);
  });

  it('restart-safe: a job whose worker died is reclaimed once its lease is stale', async () => {
    const id = (await addImage(P[1], vecUrl(e(1), 'p2-front'), { source: 'gati_cad' })).id;
    await index.enqueue(ORG, [id]);
    // What a crash mid-job leaves behind.
    await prisma.jobTask.updateMany({
      where: { kind: EMBED_JOB, payload: { equals: { imageId: id } } },
      data: { status: 'running', lockedBy: 'worker-that-died', lockedAt: new Date(Date.now() - 20 * 60_000), attempts: 1 },
    });
    await prisma.productImage.update({ where: { id }, data: { embeddingStatus: 'running' } });
    await jobs.drain(10);
    expect((await image(id)).embeddingStatus).toBe('indexed');
  });

  it('a picture that cannot be fetched is dead at once, with the reason', async () => {
    const missing = (await addImage(P[4], `${base}/nope.jpg`, { source: 'gati_cad' })).id;
    const svg = (await addImage(P[4], `${base}/svg.jpg`, { source: 'website', sourceOrder: 1 })).id;
    const foreign = (await addImage(P[4], 'https://attacker.example.net/x.jpg', { source: 'website', sourceOrder: 2 })).id;
    await index.enqueue(ORG, [missing, svg, foreign]);
    await jobs.drain(10);
    expect(await image(missing)).toEqual(expect.objectContaining({ embeddingStatus: 'dead', embeddingError: expect.stringMatching(/HTTP 404/) }));
    expect(await image(svg)).toEqual(expect.objectContaining({ embeddingStatus: 'dead', embeddingError: expect.stringMatching(/not an image/) }));
    expect(await image(foreign)).toEqual(
      expect.objectContaining({ embeddingStatus: 'dead', embeddingError: expect.stringMatching(/host not allowed/) }),
    );
  });

  it('a transient failure is retried with backoff, then dead after the last attempt', async () => {
    flaky = 503;
    const id = (await addImage(P[4], `${base}/flaky.jpg`, { source: 'manual' })).id;
    await index.enqueue(ORG, [id]);
    await jobs.drain(10);
    expect(await image(id)).toEqual(expect.objectContaining({ embeddingStatus: 'failed', embeddingError: expect.stringMatching(/HTTP 503/) }));
    const job = await prisma.jobTask.findFirstOrThrow({ where: { kind: EMBED_JOB, payload: { equals: { imageId: id } } } });
    expect(job.status).toBe('pending');
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    // Fast-forward to the last attempt.
    await prisma.jobTask.update({ where: { id: job.id }, data: { attempts: 4, runAt: new Date(Date.now() - 1000) } });
    await jobs.drain(10);
    expect((await image(id)).embeddingStatus).toBe('dead');
    expect((await prisma.jobTask.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('dead');
  });

  it('the same bytes twice in one design are one picture', async () => {
    const a = (await addImage(P[3], vecUrl(e(3), 'same'), { source: 'gati_cad' })).id;
    const b = (await addImage(P[3], vecUrl(e(3), 'same'), { source: 'website' })).id;
    await index.enqueue(ORG, [a]);
    await jobs.drain(10);
    await index.enqueue(ORG, [b]);
    await jobs.drain(10);
    expect((await image(a)).status).toBe('active');
    expect(await image(b)).toEqual(expect.objectContaining({ status: 'tombstoned', embeddingError: `duplicate of ${a}` }));
    expect(await prisma.productEmbedding.count({ where: { productId: P[3] } })).toBe(1);
  });

  it('one result per design, naming the picture that matched (its source, colour and angle)', async () => {
    // Design 3 carries a CAD (e3) and a website shot close to e2.
    const web = (await addImage(P[2], vecUrl(e(2, 5), 'p3-web'), { source: 'website', angle: 'side' })).id;
    await prisma.productImageAssociation.create({ data: { organisationId: ORG, imageId: web, source: 'website', colour: 'yellow' } });
    const cad = (await addImage(P[2], vecUrl(e(2), 'p3-cad'), { source: 'gati_cad' })).id;
    await index.enqueue(ORG, [web, cad]);
    await jobs.drain(10);

    mock.searchVec = e(2);
    const res = await search();
    expect(res.status).toBe(201);
    const hits = res.body.results.filter((r: any) => r.productId === P[2]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual(expect.objectContaining({ matchedImageId: cad, matchedImageSource: 'gati_cad', matchedColour: null }));

    mock.searchVec = e(2, 5);
    const viaWeb = (await search()).body.results.find((r: any) => r.productId === P[2]);
    expect(viaWeb).toEqual(
      expect.objectContaining({ matchedImageId: web, matchedImageSource: 'website', matchedColour: 'yellow', matchedAngle: 'side' }),
    );
  });

  it('a cached query photo skips inference', async () => {
    mock.searchVec = e(0);
    const bytes = jpegWith(e(0), 'cached-query');
    await search(bytes);
    const before = mock.searchCalls;
    const again = await search(bytes);
    expect(again.status).toBe(201);
    expect(mock.searchCalls).toBe(before);
    expect(again.headers['server-timing']).toMatch(/cache;desc="1\/1 hit"/);
    expect(again.body.results[0].productId).toBe(P[0]);
  });

  it('searches beyond the concurrency limit get 429 with Retry-After', async () => {
    mock.searchVec = e(0);
    mock.gate = new Promise<void>((r) => (release = r));
    const before = mock.searchCalls;
    const held = [search().then((r) => r), search().then((r) => r)];
    for (let i = 0; i < 100 && mock.searchCalls < before + 2; i++) await new Promise((r) => setTimeout(r, 20));
    const third = await search();
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    release!();
    mock.gate = null;
    for (const r of await Promise.all(held)) expect(r.status).toBe(201);
  });

  it('a tombstoned picture is never a candidate, and its vectors go', async () => {
    mock.searchVec = e(0);
    expect((await search()).body.results[0]?.productId).toBe(P[0]);
    // The source stops publishing it; the vectors are still there for a moment.
    await prisma.productImage.update({ where: { id: img1 }, data: { status: 'tombstoned', tombstonedAt: new Date() } });
    const ids = (await search()).body.results.map((r: any) => r.productId);
    expect(ids).not.toContain(P[0]);
    // Nobody tells the index (the syncs tombstone directly): the sweep's
    // cleanup drops the rows anyway.
    expect(await index.purgeTombstoned()).toBeGreaterThanOrEqual(1);
    expect(await prisma.productEmbedding.count({ where: { productImageId: img1 } })).toBe(0);
    expect((await image(img1)).embeddingStatus).toBe('skipped');
    // Told about one directly, enqueue does the same.
    const cad = await prisma.productImage.findFirstOrThrow({ where: { productId: P[3], status: 'active' } });
    await prisma.productImage.update({ where: { id: cad.id }, data: { status: 'tombstoned' } });
    expect(await index.enqueue(ORG, [cad.id])).toBe(0);
    expect(await prisma.productEmbedding.count({ where: { productImageId: cad.id } })).toBe(0);
  });

  it('a model or pipeline change re-queues what was indexed under the old one', async () => {
    const cadId = (await prisma.productImage.findFirstOrThrow({ where: { productId: P[1] } })).id;
    mock.versions = { ...mock.versions, preprocessing: 'pp2' };
    try {
      const res = await request(app.getHttpServer())
        .post(`/products/embeddings/reindex?productId=${P[1]}`)
        .set('Authorization', `Bearer ${tokens.ho}`);
      expect(res.status).toBe(201);
      expect(res.body.queued).toBe(1);
      expect((await image(cadId)).embeddingStatus).toBe('queued');
      await jobs.drain(10);
      expect((await image(cadId)).embeddingVersion).toBe('idx1|d1|s1|pp2');
      const rows = await prisma.productEmbedding.findMany({ where: { productImageId: cadId } });
      expect(rows.map((r) => r.preprocessingVersion)).toEqual(['pp2']);
    } finally {
      mock.versions = { ...mock.versions, preprocessing: 'pp1' };
    }
  });

  it('status is counts from the database', async () => {
    const res = await request(app.getHttpServer()).get('/products/embeddings/reindex').set('Authorization', `Bearer ${tokens.ho}`);
    expect(res.status).toBe(200);
    const db = await prisma.productImage.count({ where: { organisationId: ORG, status: 'active', embeddingStatus: 'dead' } });
    expect(res.body.counts.dead).toBe(db);
    expect(res.body.result.failed).toBeGreaterThanOrEqual(db);
  });

  it('cross-tenant: another organisation’s pictures are neither queued nor candidates', async () => {
    await prisma.organisation.create({ data: { id: 'org_catidx_b', name: 'CatIdx B', slug: 'catidx-b' } });
    await prisma.store.create({ data: { id: 'store_catidx_b', name: 'B', city: 'X', organisationId: 'org_catidx_b' } });
    await prisma.product.create({
      data: { id: 'catidx-b1', sku: 'CATIDX-B1', name: 'B ring', metal: 'gold_18k', organisationId: 'org_catidx_b', storeId: 'store_catidx_b' },
    });
    const b = await prisma.productImage.create({
      data: { organisationId: 'org_catidx_b', productId: 'catidx-b1', url: vecUrl(e(6), 'b'), embeddingStatus: 'indexed' },
    });
    await prisma.productEmbedding.create({
      data: {
        organisationId: 'org_catidx_b',
        productId: 'catidx-b1',
        productImageId: b.id,
        storeId: 'store_catidx_b',
        dinoEmbedding: e(6),
        siglipEmbedding: e(6),
        imageHash: 'b',
      },
    });
    // Queued under the wrong organisation: ignored.
    expect(await index.enqueue(ORG, [b.id])).toBe(0);
    expect(await prisma.jobTask.count({ where: { kind: EMBED_JOB, payload: { equals: { imageId: b.id } } } })).toBe(0);
    // A perfect match in another organisation is never a result.
    mock.searchVec = e(6);
    const res = await search();
    expect(res.body.results.map((r: any) => r.productId)).not.toContain('catidx-b1');
  });

  it('a 400 px grid thumbnail is made ahead of indexing, even with no inference service', async () => {
    // A 3000 px original, like the website's, so the resize is real.
    realPng = await sharp({ create: { width: 3000, height: 2250, channels: 3, background: '#c9a227' } }).png().toBuffer();
    const id = (await addImage(P[4], `${base}/real.png`, { source: 'website' })).id;
    mock.available = false;
    process.env.SCHEDULER_ENABLED = 'true';
    const thumbJobs = () => prisma.jobTask.count({ where: { kind: THUMB_JOB, payload: { equals: { imageId: id } } } });
    try {
      await index.sweep();
      expect(await thumbJobs()).toBe(1);
      // Behind messages and imports (default 0), ahead of indexing.
      const tj = await prisma.jobTask.findFirstOrThrow({ where: { kind: THUMB_JOB, payload: { equals: { imageId: id } } } });
      const ej = await prisma.jobTask.findFirstOrThrow({ where: { kind: EMBED_JOB } });
      expect(tj.priority).toBeLessThan(0);
      expect(tj.priority).toBeGreaterThan(ej.priority);
      await index.sweep(); // asking again queues nothing new
      expect(await thumbJobs()).toBe(1);
    } finally {
      process.env.SCHEDULER_ENABLED = 'false';
      mock.available = true;
    }

    await jobs.drain(50);
    const m = await image(id);
    expect(m.thumbUrl).toMatch(/catalogue-thumbs\/.*-grid\.webp$/);
    const file = join(app.get(StorageService).baseDir, ...m.thumbUrl!.replace(/^\/uploads\//, '').split('/'));
    const meta = await sharp(readFileSync(file)).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([400, 300]);
  });
});
