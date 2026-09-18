import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MlInferenceService } from '../src/products/ml-inference.service';
import {
  rankCandidates,
  normalizePerSet,
  calibrateCloseness,
  levelFor,
  RankCandidate,
  Weights,
  MatchThresholds,
  topK,
  unitOf,
} from '../src/products/jewelry-ranking.service';

/**
 * Jewelry visual similarity (Module 5). No real models — the inference client is
 * fully mocked. Two layers:
 *   - PURE: the ranking maths (normalization, fusion, calibration, matchLevel,
 *     no-match rule, category-as-signal-not-filter). No DB, no network.
 *   - E2E: the real Nest app with MlInferenceService overridden, asserting the
 *     honesty contract (available:false, SEARCH_ERROR vs NO_CLOSE_MATCH, auth,
 *     real-products-only, matched-picture fields, feedback, empty-index preflight).
 * Indexing itself (queue, leases, failures) is in catalogue-index.e2e-spec.ts.
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

describe('rankCandidates — several angles of one design', () => {
  // The index holds a row per PHOTOGRAPH, so the same design arrives several
  // times. What must come back is one hit per design, scored on its best view.
  const threeAngles: RankCandidate[] = [
    { productId: 'pendant', dino: [1, 0, 0], siglip: [1, 0, 0], category: 'pendant' }, // front
    { productId: 'pendant', dino: [0.9, 0.1, 0], siglip: [0.9, 0.1, 0], category: 'pendant' }, // side
    { productId: 'pendant', dino: [0.7, 0.7, 0], siglip: [0.7, 0.7, 0], category: 'pendant' }, // on hand
    { productId: 'other', dino: [0, 0, 1], siglip: [0, 0, 1], category: 'ring' },
  ];

  it('collapses angles into one result, keeping the best-matching view', () => {
    const out = rankCandidates([1, 0, 0], [1, 0, 0], threeAngles, opts());
    expect(out.status).toBe('MATCHES_FOUND');
    expect(out.results.filter((r) => r.productId === 'pendant')).toHaveLength(1);
    // Ranked on the front view (an exact match), not dragged down by the others.
    expect(out.results[0].productId).toBe('pendant');
    expect(out.results[0].matchLevel).toBe('VERY_CLOSE');
  });

  it('names the picture that won for each design', () => {
    const withIds = threeAngles.map((c, i) => ({ ...c, imageId: `img-${i}` }));
    const out = rankCandidates([1, 0, 0], [1, 0, 0], withIds, opts());
    expect(out.results[0].imageId).toBe('img-0'); // the front view
  });

  it('ranks are contiguous from 1 after the collapse', () => {
    const out = rankCandidates([1, 0, 0], [1, 0, 0], threeAngles, opts());
    expect(out.results.map((r) => r.rank)).toEqual(
      out.results.map((_, i) => i + 1),
    );
  });

  it('the no-match margin compares designs, never two angles of one design', () => {
    // Two near-identical views of the SAME piece, both middling. Before the
    // collapse the top two rows were the same design, the gap between them was
    // ~0, and a genuine single match was thrown away as "ambiguous".
    const twoViews: RankCandidate[] = [
      { productId: 'only', dino: [0.8, 0.6, 0], siglip: [0.8, 0.6, 0], category: 'ring' },
      { productId: 'only', dino: [0.81, 0.59, 0], siglip: [0.81, 0.59, 0], category: 'ring' },
    ];
    const out = rankCandidates([1, 0, 0], [1, 0, 0], twoViews, opts());
    expect(out.status).toBe('MATCHES_FOUND');
    expect(out.results).toHaveLength(1);
  });
});

describe('rankCandidates — fast path', () => {
  it('topK keeps the k largest, best first, ties in input order', () => {
    expect(topK([0.1, 0.9, 0.5, 0.9, 0.2], 3)).toEqual([1, 3, 2]);
    expect(topK([1, 2], 5)).toEqual([1, 0]);
  });

  it('pre-normalised candidates rank exactly like raw ones', () => {
    const raw: RankCandidate[] = [
      { productId: 'A', dino: [3, 1, 0], siglip: [2, 2, 1] },
      { productId: 'B', dino: [0, 5, 1], siglip: [0, 1, 4] },
      { productId: 'C', dino: [2, 0, 0.5], siglip: [1, 0, 0] },
    ];
    const unit = raw.map((c) => ({ ...c, dino: unitOf(c.dino), siglip: unitOf(c.siglip), unit: true }));
    const q = [1, 0.2, 0];
    expect(rankCandidates(q, q, unit, opts())).toEqual(rankCandidates(q, q, raw, opts()));
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

/**
 * Mutable mock of the inference client — flip fields per test. `embedResult`
 * is what every search photo embeds to (null = the call fails).
 */
const mockInference = {
  _available: true,
  embedResult: null as any,
  batchCalls: 0,
  versions: { dino: 'd1', siglip: 's1', preprocessing: 'pp1' },
  get available() {
    return this._available;
  },
  async embedBatch(items: { id: string; bytes: Buffer; mime: string }[]) {
    this.batchCalls++;
    if (!this.embedResult) throw new Error('HTTP 502: inference down');
    return {
      results: items.map((i) => ({ id: i.id, views: [], ...this.embedResult })),
      errors: [],
      timings: { decode: 1, detect: 2, dino: 3, siglip: 4 },
      wallMs: 12,
    };
  },
  async currentVersions() {
    return this.versions;
  },
  cachedVersions() {
    return this.versions;
  },
};

/** A distinct, sniffable JPEG each call — identical bytes would hit the query cache. */
let shotNo = 0;
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jsim-shot-${shotNo++}-padding`)]);

describe('Jewelry similarity search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const EMB_A = 'p-001';
  const EMB_B = 'p-002';
  const IMG_A = 'jsim-img-a';
  const IMG_B = 'jsim-img-b';

  async function login(email: string) {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });
    return res.body.token as string;
  }

  beforeAll(async () => {
    process.env.SCHEDULER_ENABLED = 'false';
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

    // Clean slate + two indexed gallery pictures in Surat scope: A aligned to
    // the query, B orthogonal.
    await prisma.similaritySearchFeedback.deleteMany({});
    await prisma.productEmbedding.deleteMany({});
    await prisma.productImage.deleteMany({ where: { id: { in: [IMG_A, IMG_B] } } });
    await prisma.productImage.createMany({
      data: [
        { id: IMG_A, organisationId: 'org_eclat', productId: EMB_A, url: '/uploads/jsim-a.jpg', source: 'website', angle: 'front', embeddingStatus: 'indexed' },
        { id: IMG_B, organisationId: 'org_eclat', productId: EMB_B, url: '/uploads/jsim-b.jpg', source: 'gati_cad', embeddingStatus: 'indexed' },
      ],
    });
    await prisma.productImageAssociation.create({
      data: { organisationId: 'org_eclat', imageId: IMG_A, source: 'website', colour: 'rose' },
    });
    const row = (productId: string, productImageId: string, v: number[], imageHash: string) => ({
      productId,
      productImageId,
      storeId: SURAT,
      organisationId: 'org_eclat',
      dinoEmbedding: v,
      siglipEmbedding: v,
      imageHash,
      preprocessingVersion: 'pp1',
      dinoModelVersion: 'd1',
      siglipModelVersion: 's1',
    });
    await prisma.productEmbedding.createMany({
      data: [row(EMB_A, IMG_A, [1, 0, 0], 'seed-a'), row(EMB_B, IMG_B, [0, 1, 0], 'seed-b')],
    });
  });

  afterAll(async () => {
    await prisma.similaritySearchFeedback.deleteMany({});
    await prisma.productEmbedding.deleteMany({});
    await prisma.productImage.deleteMany({ where: { id: { in: [IMG_A, IMG_B] } } });
    await app?.close();
    delete process.env.SCHEDULER_ENABLED;
  });

  function post(path: string, token?: string) {
    const r = request(app.getHttpServer()).post(path);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  }
  const search = (token = tokens.rep) =>
    post('/products/jewelry/similarity-search', token).attach('file', jpeg(), { filename: 'q.jpg', contentType: 'image/jpeg' });

  it('requires auth', async () => {
    const res = await post('/products/jewelry/similarity-search').attach('file', jpeg(), {
      filename: 'q.jpg',
      contentType: 'image/jpeg',
    });
    expect(res.status).toBe(401);
  });

  it('refuses bytes that are not an image, whatever the content-type says', async () => {
    const res = await post('/products/jewelry/similarity-search', tokens.rep).attach('file', Buffer.from('<svg/> not a photo'), {
      filename: 'q.jpg',
      contentType: 'image/jpeg',
    });
    expect(res.status).toBe(400);
  });

  it('valid image → MATCHES_FOUND with the matched picture, only real catalogue products', async () => {
    mockInference._available = true;
    mockInference.embedResult = { dino: [1, 0, 0], siglip: [1, 0, 0] };
    const res = await search();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('MATCHES_FOUND');
    expect(res.body.available).toBe(true);
    expect(typeof res.body.queryId).toBe('string');
    expect(res.body.results.map((r: any) => r.productId)).toEqual([EMB_A]);
    const db = await prisma.product.findUniqueOrThrow({ where: { id: EMB_A }, select: { name: true, imageUrl: true } });
    const hit = res.body.results[0];
    expect(hit.productName).toBe(db.name);
    expect(hit.matchLevel).toBe('VERY_CLOSE');
    expect(hit).toHaveProperty('sku');
    expect(hit).toHaveProperty('storeName');
    expect(typeof hit.closenessScore).toBe('number');
    // Which picture matched, and where it came from.
    expect(hit.matchedImageId).toBe(IMG_A);
    expect(hit.matchedImageUrl).toBe('/uploads/jsim-a.jpg');
    expect(hit.matchedImageSource).toBe('website');
    expect(hit.matchedColour).toBe('rose');
    expect(hit.matchedAngle).toBe('front');
    expect(hit.heroImageUrl).toBe(db.imageUrl ?? null);
    // No raw vectors leaked.
    expect(hit.dino).toBeUndefined();
    expect(hit.siglipEmbedding).toBeUndefined();
    // Per-stage timings travel as a header, not in the body.
    expect(res.headers['server-timing']).toMatch(/dino;dur=\d+/);
    expect(res.headers['server-timing']).toMatch(/total;dur=\d+/);
  });

  it('search is organisation-scoped — another org’s indexed picture never leaks', async () => {
    mockInference.embedResult = { dino: [1, 0, 0], siglip: [1, 0, 0] };
    await prisma.organisation.upsert({ where: { id: 'org_jsim_b' }, update: {}, create: { id: 'org_jsim_b', name: 'JSim B', slug: 'jsim-b' } });
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
    const img = await prisma.productImage.create({
      data: { organisationId: 'org_jsim_b', productId: 'p-jsim-b', url: '/uploads/b.jpg', embeddingStatus: 'indexed' },
    });
    await prisma.productEmbedding.create({
      data: {
        productId: 'p-jsim-b',
        productImageId: img.id,
        organisationId: 'org_jsim_b',
        storeId: 'store_jsim_b',
        dinoEmbedding: [1, 0, 0],
        siglipEmbedding: [1, 0, 0],
        imageHash: 'jsimb',
      },
    });

    const res = await search();
    expect(res.status).toBe(201);
    const ids = res.body.results.map((r: any) => r.productId);
    expect(ids).not.toContain('p-jsim-b');
    expect(ids).toContain(EMB_A);

    await prisma.productEmbedding.deleteMany({ where: { organisationId: 'org_jsim_b' } });
    await prisma.productImage.deleteMany({ where: { organisationId: 'org_jsim_b' } });
    await prisma.product.deleteMany({ where: { organisationId: 'org_jsim_b' } });
    await prisma.store.deleteMany({ where: { organisationId: 'org_jsim_b' } });
    await prisma.organisation.deleteMany({ where: { id: 'org_jsim_b' } });
  });

  it('a piece detected in the photo finds the design its whole frame does not', async () => {
    mockInference.embedResult = { dino: [0, 0, 1], siglip: [0, 0, 1], views: [{ dino: [1, 0, 0], siglip: [1, 0, 0] }] };
    const res = await search();
    expect(res.body.status).toBe('MATCHES_FOUND');
    expect(res.body.results[0].productId).toBe(EMB_A);

    mockInference.embedResult = { dino: [0, 0, 1], siglip: [0, 0, 1] };
    const whole = await search();
    expect(whole.body.status).toBe('NO_CLOSE_MATCH');
  });

  it('inference unavailable → available:false (never fabricates)', async () => {
    mockInference._available = false;
    const res = await search();
    mockInference._available = true;
    expect(res.status).toBe(201);
    expect(res.body.available).toBe(false);
    expect(res.body.results).toEqual([]);
  });

  it('provider failure → SEARCH_ERROR (distinct from NO_CLOSE_MATCH)', async () => {
    mockInference.embedResult = null;
    const res = await search();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SEARCH_ERROR');
    expect(res.body.available).toBe(true);
    expect(res.body.results).toEqual([]);
  });

  it('feedback persists', async () => {
    const dto = { queryId: 'q-test-1', productId: EMB_A, rank: 1, feedback: 'very_close' };
    const res = await post('/products/jewelry/similarity-feedback', tokens.rep).send(dto);
    expect(res.status).toBe(201);
    const row = await prisma.similaritySearchFeedback.findFirst({ where: { queryId: 'q-test-1' } });
    expect(row!.productId).toBe(EMB_A);
    expect(row!.feedback).toBe('very_close');
  });

  it('nothing indexed → CATALOGUE_INDEX_BUILD_REQUIRED with coverage, without calling inference', async () => {
    mockInference.embedResult = { dino: [1, 0, 0], siglip: [1, 0, 0] };
    await prisma.productEmbedding.deleteMany({});
    const before = mockInference.batchCalls;
    const res = await search();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CATALOGUE_INDEX_BUILD_REQUIRED');
    expect(res.body.coverage).toEqual(
      expect.objectContaining({ indexed: expect.any(Number), total: expect.any(Number), queued: expect.any(Number), failed: expect.any(Number) }),
    );
    expect(res.body.results).toEqual([]);
    expect(mockInference.batchCalls).toBe(before);
  });

  it('rebuild and its status are head-office only; status is counts from the database', async () => {
    expect((await post('/products/embeddings/reindex', tokens.rep)).status).toBe(403);
    const rep = await request(app.getHttpServer()).get('/products/embeddings/reindex').set('Authorization', `Bearer ${tokens.rep}`);
    expect(rep.status).toBe(403);

    const status = await request(app.getHttpServer()).get('/products/embeddings/reindex').set('Authorization', `Bearer ${tokens.ho}`);
    expect(status.status).toBe(200);
    expect(typeof status.body.running).toBe('boolean');
    expect(typeof status.body.total).toBe('number');
    expect(status.body.counts).toEqual(expect.objectContaining({ indexed: expect.any(Number), dead: expect.any(Number) }));
    // p50/p95 per stage from the searches above.
    expect(status.body.searchMetrics.stages.total.p95).toBeGreaterThanOrEqual(0);
  });
});
