import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MlInferenceService } from '../src/products/ml-inference.service';
import {
  rankCandidates,
  normalizePerSet,
  calibrateCloseness,
  levelFor,
  RankCandidate,
  Weights,
  MatchThresholds,
} from '../src/products/jewelry-ranking.service';

/**
 * Jewelry visual similarity (Module 5). No real models — the inference client is
 * fully mocked. Two layers:
 *   - PURE: the ranking maths (normalization, fusion, calibration, matchLevel,
 *     no-match rule, category-as-signal-not-filter). No DB, no network.
 *   - E2E: the real Nest app with MlInferenceService overridden, asserting the
 *     honesty contract (available:false, SEARCH_ERROR vs NO_CLOSE_MATCH, auth,
 *     real-products-only, feedback persistence, idempotent reindex).
 */

const W: Weights = { dino: 0.5, siglip: 0.4, category: 0.1 };
const T: MatchThresholds = { veryClose: 85, close: 70, similar: 50, weak: 30, minMargin: 5 };
const opts = (extra: Partial<Parameters<typeof rankCandidates>[3]> = {}) => ({
  weights: W,
  thresholds: T,
  limit: 24,
  ...extra,
});

// --------------------------------------------------------------------- PURE
describe('normalizePerSet', () => {
  it('min-max scales to [0,1]', () => {
    expect(normalizePerSet([1, 3, 5])).toEqual([0, 0.5, 1]);
  });
  it('maps an all-equal set (incl. singleton) to 1s, never NaN', () => {
    expect(normalizePerSet([2, 2])).toEqual([1, 1]);
    expect(normalizePerSet([5])).toEqual([1]);
    expect(normalizePerSet([])).toEqual([]);
  });
});

describe('calibrateCloseness', () => {
  it('is a calibrated curve, NOT cosine×100', () => {
    expect(calibrateCloseness(1.0)).toBe(100);
    expect(calibrateCloseness(0.75)).toBe(70);
    expect(calibrateCloseness(0.3)).toBe(0);
    expect(calibrateCloseness(0.5)).not.toBe(50); // the whole point
    expect(calibrateCloseness(0.5)).toBeLessThan(50);
  });
});

describe('levelFor', () => {
  it('maps closeness to the configured bands', () => {
    expect(levelFor(90, T)).toBe('VERY_CLOSE');
    expect(levelFor(72, T)).toBe('CLOSE');
    expect(levelFor(55, T)).toBe('SIMILAR');
    expect(levelFor(35, T)).toBe('WEAK');
    expect(levelFor(10, T)).toBe('NO_CLOSE_MATCH');
  });
});

describe('rankCandidates — fusion & ranking', () => {
  const cands: RankCandidate[] = [
    { productId: 'A', dino: [1, 0, 0], siglip: [1, 0, 0], category: 'ring' },
    { productId: 'B', dino: [0, 1, 0], siglip: [0, 1, 0], category: 'necklace' },
  ];

  it('ranks the true visual match first and returns real ids only', () => {
    const out = rankCandidates([1, 0, 0], [1, 0, 0], cands, opts());
    expect(out.status).toBe('MATCHES_FOUND');
    expect(out.results[0].productId).toBe('A');
    expect(out.results[0].matchLevel).toBe('VERY_CLOSE');
    // B (orthogonal, closeness 0) is below the WEAK floor → not a match.
    expect(out.results.map((r) => r.productId)).toEqual(['A']);
  });

  it('closenessScore is 0-100 and best-first', () => {
    const out = rankCandidates([1, 0, 0], [1, 0, 0], cands, opts());
    expect(out.closenessScore).toBeGreaterThan(0);
    expect(out.closenessScore).toBeLessThanOrEqual(100);
  });

  it('weights steer fusion: DINO-dominant weights follow the DINO vote', () => {
    // A wins on DINO, B wins on SigLIP. dino weight >> siglip → A first.
    const split: RankCandidate[] = [
      { productId: 'A', dino: [1, 0, 0], siglip: [0, 1, 0] },
      { productId: 'B', dino: [0, 1, 0], siglip: [1, 0, 0] },
    ];
    const out = rankCandidates([1, 0, 0], [1, 0, 0], split, {
      weights: { dino: 0.9, siglip: 0.1, category: 0 },
      thresholds: T,
      limit: 24,
    });
    expect(out.results[0].productId).toBe('A');
  });
});

describe('rankCandidates — category is a SIGNAL, not a filter', () => {
  it('a wrong category guess never drops the true visual match', () => {
    const cands: RankCandidate[] = [
      { productId: 'true', dino: [1, 0, 0], siglip: [1, 0, 0], category: 'ring' },
      { productId: 'wrongcat', dino: [0, 1, 0], siglip: [0, 1, 0], category: 'necklace' },
    ];
    // Query category is 'necklace' — WRONG for the true (ring) match.
    const out = rankCandidates([1, 0, 0], [1, 0, 0], cands, opts({ queryCategory: 'necklace' }));
    // True match is still present and still first; category only nudges, never filters.
    expect(out.results.map((r) => r.productId)).toContain('true');
    expect(out.results[0].productId).toBe('true');
  });
});

describe('rankCandidates — no-match is a real outcome (not an error)', () => {
  it('empty candidate set → NO_CLOSE_MATCH, empty results', () => {
    const out = rankCandidates([1, 0, 0], [1, 0, 0], [], opts());
    expect(out.status).toBe('NO_CLOSE_MATCH');
    expect(out.results).toEqual([]);
  });

  it('best below the absolute floor → NO_CLOSE_MATCH', () => {
    const cands: RankCandidate[] = [
      { productId: 'A', dino: [0, 1, 0], siglip: [0, 1, 0] },
      { productId: 'B', dino: [0, 0, 1], siglip: [0, 0, 1] },
    ];
    const out = rankCandidates([1, 0, 0], [1, 0, 0], cands, opts());
    expect(out.status).toBe('NO_CLOSE_MATCH');
    expect(out.results).toEqual([]);
  });

  it('moderate but ambiguous (below CLOSE AND low margin) → NO_CLOSE_MATCH', () => {
    // Two near-identical moderate matches: closeness in (WEAK, CLOSE), margin < 5.
    const cands: RankCandidate[] = [
      { productId: 'A', dino: [0.6, 0.6, 0], siglip: [0.6, 0.6, 0] },
      { productId: 'B', dino: [0.61, 0.6, 0], siglip: [0.6, 0.61, 0] },
    ];
    const out = rankCandidates([1, 0, 0], [1, 0, 0], cands, opts());
    expect(out.closenessScore).toBeGreaterThan(T.weak);
    expect(out.closenessScore).toBeLessThan(T.close);
    expect(out.status).toBe('NO_CLOSE_MATCH');
  });
});

// ---------------------------------------------------------------------- E2E
const PASSWORD = 'password123';
const REP = 'priya.rep@caratsense.in'; // salesperson, Surat — Main
const HO = 'head.office@caratsense.in';
const SURAT = 'surat-main';

// Mutable mock of the inference client — flip fields per test.
const mockInference = {
  _available: true,
  embedResult: null as any,
  versions: { dino: 'd1', siglip: 's1', preprocessing: 'pp1' },
  get available() {
    return this._available;
  },
  async embed() {
    return this.embedResult;
  },
  async embedBatch(items: { id: string; bytes: Buffer; mime: string }[]) {
    return {
      results: items.map((i) => ({ id: i.id, dino: [1, 0, 0], siglip: [1, 0, 0], imageHash: 'h' })),
      errors: [] as { id: string; error: string }[],
    };
  },
  async currentVersions() {
    return this.versions;
  },
};

describe('Jewelry similarity search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const IMG = Buffer.from('fake-jpeg-bytes');
  // Seeded embedding rows (cleaned up in afterAll).
  const EMB_A = 'p-001';
  const EMB_B = 'p-002';
  const REINDEX_PRODUCT = 'test-sim-reindex';
  /** Written by the test itself: uploads/ is gitignored, so a clean checkout has no catalogue images. */
  const REINDEX_IMAGE = 'catalogue/test-sim-reindex.png';
  const ONE_PIXEL_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  async function login(email: string) {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
    return res.body.token as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MlInferenceService)
      .useValue(mockInference)
      .compile();

    app = moduleRef.createNestApplication();
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

    tokens.rep = await login(REP);
    tokens.ho = await login(HO);

    // Clean slate + seed two embeddings in Surat scope: A aligned to the query, B orthogonal.
    await prisma.similaritySearchFeedback.deleteMany({});
    await prisma.productEmbedding.deleteMany({});
    await prisma.productEmbedding.createMany({
      data: [
        {
          productId: EMB_A,
          storeId: SURAT,
          organisationId: 'org_eclat',
          dinoEmbedding: [1, 0, 0],
          siglipEmbedding: [1, 0, 0],
          imageHash: 'seed-a',
          preprocessingVersion: 'pp1',
          dinoModelVersion: 'd1',
          siglipModelVersion: 's1',
        },
        {
          productId: EMB_B,
          storeId: SURAT,
          organisationId: 'org_eclat',
          dinoEmbedding: [0, 1, 0],
          siglipEmbedding: [0, 1, 0],
          imageHash: 'seed-b',
          preprocessingVersion: 'pp1',
          dinoModelVersion: 'd1',
          siglipModelVersion: 's1',
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.similaritySearchFeedback.deleteMany({});
    await prisma.productEmbedding.deleteMany({});
    await prisma.product.deleteMany({ where: { id: REINDEX_PRODUCT } });
    if (app) rmSync(join(app.get(StorageService).baseDir, REINDEX_IMAGE), { force: true });
    await app?.close();
  });

  function post(path: string, token?: string) {
    const r = request(app.getHttpServer()).post(path);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  }

  it('requires auth', async () => {
    const res = await post('/products/jewelry/similarity-search')
      .attach('file', IMG, { filename: 'q.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('valid image → MATCHES_FOUND, results only real catalogue products', async () => {
    mockInference._available = true;
    mockInference.embedResult = { dino: [1, 0, 0], siglip: [1, 0, 0] };
    const res = await post('/products/jewelry/similarity-search', tokens.rep)
      .attach('file', IMG, { filename: 'q.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('MATCHES_FOUND');
    expect(res.body.available).toBe(true);
    expect(typeof res.body.queryId).toBe('string');
    // Only the aligned product; every id is a real seeded catalogue product.
    expect(res.body.results.map((r: any) => r.productId)).toEqual([EMB_A]);
    const dbNames = await prisma.product.findMany({
      where: { id: { in: res.body.results.map((r: any) => r.productId) } },
      select: { id: true, name: true },
    });
    expect(res.body.results[0].productName).toBe(dbNames[0].name);
    expect(res.body.results[0].matchLevel).toBe('VERY_CLOSE');
    // Display fields the unified UI needs are present (sku + store, closeness).
    expect(res.body.results[0]).toHaveProperty('sku');
    expect(res.body.results[0]).toHaveProperty('storeName');
    expect(typeof res.body.results[0].closenessScore).toBe('number');
    // At most the TOP 10 closest, ordered closest-first by real similarity.
    expect(res.body.results.length).toBeLessThanOrEqual(10);
    // No raw vectors leaked.
    expect(res.body.results[0].dino).toBeUndefined();
    expect(res.body.results[0].siglipEmbedding).toBeUndefined();
  });

  it('search is organisation-scoped — another org’s indexed product never leaks', async () => {
    mockInference._available = true;
    mockInference.embedResult = { dino: [1, 0, 0], siglip: [1, 0, 0] };
    // A separate organisation with an embedding aligned to the query. It must
    // NEVER surface for an Eclat user, even though it is a "perfect" visual match.
    await prisma.organisation.upsert({
      where: { id: 'org_jsim_b' },
      update: {},
      create: { id: 'org_jsim_b', name: 'JSim B', slug: 'jsim-b' },
    });
    await prisma.store.upsert({
      where: { id: 'store_jsim_b' },
      update: {},
      create: { id: 'store_jsim_b', name: 'JSim B Store', city: 'Testville', organisationId: 'org_jsim_b' },
    });
    await prisma.product.upsert({
      where: { id: 'p-jsim-b' },
      update: {},
      create: { id: 'p-jsim-b', sku: 'JSIM-B-1', name: 'JSim B Ring', metal: 'gold_22k', organisationId: 'org_jsim_b', storeId: 'store_jsim_b', embedding: [] },
    });
    await prisma.productEmbedding.create({
      data: {
        productId: 'p-jsim-b',
        organisationId: 'org_jsim_b',
        storeId: 'store_jsim_b',
        dinoEmbedding: [1, 0, 0],
        siglipEmbedding: [1, 0, 0],
        dinoModelVersion: 'x',
        siglipModelVersion: 'x',
        preprocessingVersion: 'x',
        imageHash: 'jsimb',
      },
    });

    const res = await post('/products/jewelry/similarity-search', tokens.rep)
      .attach('file', IMG, { filename: 'q.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    const ids = res.body.results.map((r: any) => r.productId);
    expect(ids).not.toContain('p-jsim-b'); // the other org's product is invisible
    expect(ids).toContain(EMB_A); // own-org match still found

    await prisma.productEmbedding.deleteMany({ where: { organisationId: 'org_jsim_b' } });
    await prisma.product.deleteMany({ where: { organisationId: 'org_jsim_b' } });
    await prisma.store.deleteMany({ where: { organisationId: 'org_jsim_b' } });
    await prisma.organisation.deleteMany({ where: { id: 'org_jsim_b' } });
  });

  it('inference unavailable → available:false (never fabricates)', async () => {
    mockInference._available = false;
    const res = await post('/products/jewelry/similarity-search', tokens.rep)
      .attach('file', IMG, { filename: 'q.jpg', contentType: 'image/jpeg' });
    mockInference._available = true;
    expect(res.status).toBe(201);
    expect(res.body.available).toBe(false);
    expect(res.body.results).toEqual([]);
  });

  it('provider failure → SEARCH_ERROR (distinct from NO_CLOSE_MATCH)', async () => {
    mockInference._available = true;
    mockInference.embedResult = null; // embed failed / timed out
    const res = await post('/products/jewelry/similarity-search', tokens.rep)
      .attach('file', IMG, { filename: 'q.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SEARCH_ERROR');
    expect(res.body.available).toBe(true);
    expect(res.body.results).toEqual([]);
  });

  it('catalogue not embedded → NOT_INDEXED (distinct from NO_CLOSE_MATCH)', async () => {
    mockInference._available = true;
    mockInference.embedResult = { dino: [1, 0, 0], siglip: [1, 0, 0] };
    // Clear the visual index; the catalogue products themselves still exist.
    await prisma.productEmbedding.deleteMany({});
    const res = await post('/products/jewelry/similarity-search', tokens.rep)
      .attach('file', IMG, { filename: 'q.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.available).toBe(true);
    expect(res.body.status).toBe('NOT_INDEXED'); // NOT the same as "nothing matched"
    expect(res.body.results).toEqual([]);
    expect(String(res.body.reason)).toMatch(/index/i);
  });

  it('feedback persists', async () => {
    const dto = { queryId: 'q-test-1', productId: EMB_A, rank: 1, feedback: 'very_close' };
    const res = await post('/products/jewelry/similarity-feedback', tokens.rep).send(dto);
    expect(res.status).toBe(201);
    const row = await prisma.similaritySearchFeedback.findFirst({ where: { queryId: 'q-test-1' } });
    expect(row).toBeTruthy();
    expect(row!.productId).toBe(EMB_A);
    expect(row!.feedback).toBe('very_close');
  });

  it('reindex (HO) is idempotent: embeds once, skips on unchanged hash', async () => {
    // A test product whose image is a real local file under uploads/.
    const imagePath = join(app.get(StorageService).baseDir, REINDEX_IMAGE);
    mkdirSync(join(imagePath, '..'), { recursive: true });
    writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG, 'base64'));
    await prisma.product.upsert({
      where: { id: REINDEX_PRODUCT },
      create: {
        id: REINDEX_PRODUCT,
        sku: 'SIM-REIDX-1',
        name: 'Sim Reindex Test',
        metal: 'gold_22k',
        storeId: SURAT,
        organisationId: 'org_eclat',
        imageUrl: `/uploads/${REINDEX_IMAGE}`,
      },
      update: { imageUrl: `/uploads/${REINDEX_IMAGE}` },
    });

    const first = await post(`/products/embeddings/reindex?force=1&productId=${REINDEX_PRODUCT}`, tokens.ho);
    expect(first.status).toBe(201);
    expect(first.body.available).toBe(true);
    expect(first.body.embedded).toBe(1);

    const second = await post(`/products/embeddings/reindex?productId=${REINDEX_PRODUCT}`, tokens.ho);
    expect(second.status).toBe(201);
    expect(second.body.skipped).toBe(1);
    expect(second.body.embedded).toBe(0);
  });

  it('reindex is HO-gated (salesperson forbidden)', async () => {
    const res = await post('/products/embeddings/reindex', tokens.rep);
    expect(res.status).toBe(403);
  });
});
