import { AuthUser } from '../src/common/auth-user';
import {
  AiImageSearchService,
  cosineSimilarity,
  rankByEmbedding,
  metadataPrefilter,
} from '../src/products/ai-image-search.service';
import { parseEmbedding } from '../src/products/image-embedding.service';

/**
 * AI visual search (Module 5). No live embedding API — every provider call is a
 * fake here. Pins the honesty guarantees the task requires:
 *   - no provider  → available:false, NOT fabricated results
 *   - threshold    → below-cutoff candidates dropped, no-match is explicit
 *   - provenance   → results are only real catalogue products (real ids)
 *   - ranking      → best cosine first
 * and the pure vector maths those guarantees rest on.
 */

const HO: AuthUser = {
  id: 'u1',
  name: 'HO',
  email: 'ho@x.com',
  role: 'head_office',
  storeIds: [],
  allStores: true,
};

const IMG = { buffer: Buffer.from('fake-jpeg-bytes'), mimetype: 'image/jpeg' };

// Synthetic catalogue: each product carries a 3-d "embedding" so we can reason
// about cosine similarity by hand. None of these are real, that's the point —
// the test asserts the service only ever hands back rows it was given.
const CATALOGUE = [
  { id: 'p-exact', sku: 'A', name: 'Exact', category: 'ring', embedding: [1, 0, 0], price: 1 },
  { id: 'p-near', sku: 'B', name: 'Near', category: 'ring', embedding: [0.9, 0.1, 0], price: 2 },
  { id: 'p-far', sku: 'C', name: 'Far', category: 'ring', embedding: [0, 1, 0], price: 3 },
];

function makeService(opts: {
  providerAvailable: boolean;
  taggerKey?: string;
  query?: number[] | null;
  candidates?: any[];
}) {
  const config = {
    get: (k: string) => (k === 'ANTHROPIC_API_KEY' ? opts.taggerKey : undefined),
  };
  const prisma = {
    product: {
      findMany: async () => opts.candidates ?? CATALOGUE,
      update: async () => ({}),
    },
  };
  const scope = { assertStoreAllowed: () => undefined };
  const storage = {};
  const embeddings = {
    available: opts.providerAvailable,
    embedImage: async () => (opts.query === undefined ? [1, 0, 0] : opts.query),
  };
  return new AiImageSearchService(
    config as any,
    prisma as any,
    scope as any,
    storage as any,
    embeddings as any,
  );
}

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });
  it('is 0 on shape mismatch or a zero vector (never NaN)', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('rankByEmbedding', () => {
  it('keeps only >= threshold and sorts best-first', () => {
    const out = rankByEmbedding([1, 0, 0], CATALOGUE, 0.7, 24);
    expect(out.map((x) => x.p.id)).toEqual(['p-exact', 'p-near']); // p-far (sim 0) dropped
    expect(out[0].s).toBeGreaterThan(out[1].s);
  });
  it('returns empty when nothing clears the threshold', () => {
    expect(rankByEmbedding([0, 0, 1], CATALOGUE, 0.7, 24)).toEqual([]);
  });
});

describe('metadataPrefilter', () => {
  it('narrows to the detected category when some candidate matches', () => {
    const cands = [{ category: 'ring' }, { category: 'necklace' }];
    expect(metadataPrefilter(cands, { category: 'ring', keywords: [] })).toEqual([{ category: 'ring' }]);
  });
  it('does NOT hide everything on a mis-detection (returns full pool)', () => {
    const cands = [{ category: 'ring' }, { category: 'necklace' }];
    expect(metadataPrefilter(cands, { category: 'bangle', keywords: [] })).toEqual(cands);
  });
});

describe('parseEmbedding', () => {
  it('reads { embedding }, OpenAI-style { data }, and a bare array', () => {
    expect(parseEmbedding({ embedding: [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(parseEmbedding({ data: [{ embedding: [4, 5] }] })).toEqual([4, 5]);
    expect(parseEmbedding([6, 7])).toEqual([6, 7]);
  });
  it('rejects empty / non-finite rather than fabricating', () => {
    expect(parseEmbedding({})).toBeNull();
    expect(parseEmbedding({ embedding: [] })).toBeNull();
    expect(parseEmbedding({ embedding: [1, 'x', 3] })).toBeNull();
  });
});

describe('AiImageSearchService.search', () => {
  it('no provider, no tagger → available:false, aiUsed:false, NO fabricated results', async () => {
    const svc = makeService({ providerAvailable: false });
    const res: any = await svc.search(HO, IMG);
    expect(res.available).toBe(false);
    expect(res.visualMatch).toBe(false);
    expect(res.aiUsed).toBe(false);
    expect(res.results).toEqual([]);
    expect(res.reason).toMatch(/unavailable/i);
  });

  it('provider present, query below threshold everywhere → explicit no-match', async () => {
    const svc = makeService({ providerAvailable: true, query: [0, 0, 1] });
    const res: any = await svc.search(HO, IMG);
    expect(res.available).toBe(true);
    expect(res.visualMatch).toBe(true);
    expect(res.results).toEqual([]);
    expect(res.reason).toMatch(/match/i);
  });

  it('provider present, real matches → results only from catalogue, ranked, real similarity', async () => {
    const svc = makeService({ providerAvailable: true, query: [1, 0, 0] });
    const res: any = await svc.search(HO, IMG);
    expect(res.visualMatch).toBe(true);
    // Only rows we supplied; never an invented SKU.
    expect(res.results.map((r: any) => r.id)).toEqual(['p-exact', 'p-near']);
    expect(res.results.every((r: any) => CATALOGUE.some((c) => c.id === r.id))).toBe(true);
    // Best first, and the score is the true cosine — not floored/faked.
    expect(res.results[0].similarity).toBeCloseTo(1, 3);
    expect(res.results[0].similarity).toBeGreaterThan(res.results[1].similarity);
  });

  it('provider configured but embed call fails → graceful, not fabricated', async () => {
    const svc = makeService({ providerAvailable: true, query: null });
    const res: any = await svc.search(HO, IMG);
    expect(res.available).toBe(true);
    expect(res.visualMatch).toBe(false);
    expect(res.results).toEqual([]);
  });

  it('rejects a non-image upload (400)', async () => {
    const svc = makeService({ providerAvailable: true });
    await expect(
      svc.search(HO, { buffer: Buffer.from('x'), mimetype: 'application/pdf' }),
    ).rejects.toThrow(/not an image/i);
  });

  it('rejects an empty upload (400)', async () => {
    const svc = makeService({ providerAvailable: true });
    await expect(svc.search(HO, undefined)).rejects.toThrow(/No image/i);
  });
});

describe('AiImageSearchService.reindex', () => {
  it('no embedding provider → available:false, nothing embedded', async () => {
    const svc = makeService({ providerAvailable: false });
    const res: any = await svc.reindex(HO, undefined);
    expect(res.available).toBe(false);
    expect(res.embedded).toBe(0);
  });

  it('idempotent: skips products that already carry an embedding', async () => {
    const svc = makeService({
      providerAvailable: true,
      candidates: [{ id: 'p1', imageUrl: '/uploads/products/p1.jpg', embedding: [1, 2, 3] }],
    });
    const res: any = await svc.reindex(HO, undefined);
    expect(res.available).toBe(true);
    expect(res.skipped).toBe(1);
    expect(res.embedded).toBe(0);
  });
});
