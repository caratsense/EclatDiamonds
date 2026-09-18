import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WebsiteCatalogueClient, parsePage } from '../src/catalogue/website/website-catalogue.client';
import { normaliseCode, normalizeWebsiteProduct, payloadHash } from '../src/catalogue/website/website-normalizer';

/**
 * The website normaliser is PURE and LOSSLESS, and the client is read-only and
 * allow-listed. No database, no network: the fetch is a stub.
 */
const golden = () => JSON.parse(readFileSync(join(__dirname, 'fixtures/website/11871RG.json'), 'utf8'));

describe('website normaliser (pure)', () => {
  it('keeps everything in the golden 11871RG payload, trimmed and labelled', () => {
    const n = normalizeWebsiteProduct(golden());
    expect(n.productCode).toBe('11871RG');
    expect(n.externalId).toBe('000000000000000000011871');
    expect(n.listing.marketingName).toBe("3ct Round Regent Solitaire Men's Ring");
    expect(n.listing.categories).toEqual(['Solitaires', 'Rings']);
    expect(n.listing.subCategories).toEqual(['Engagement Rings', 'Daily Wear', 'Rings', "All Men's Ring"]);
    expect(n.listing.features).toEqual(['LATEST DESIGNS']);
    expect(n.listing.tags).toEqual(['MODERN ROYALTY', 'ANNIVERSARY COLLECTION', 'RING SOLITAIRE']);
    expect(n.listing.countries).toEqual(['IN', 'US']);
    expect(n.listing.seo).toMatchObject({ metaTitle: "3ct Round Regent Solitaire Men's Ring" });
    // No variant _id in the live feed: the key is metal|karat|diamond, normalised.
    expect(n.variants.map((v) => v.sourceKey)).toEqual(['GOLD|9KT|LABGROWN', 'GOLD|14KT|LABGROWN', 'GOLD|18KT|LABGROWN']);
    expect(n.sizes).toHaveLength(13);
    expect(n.sizes[0]).toBe('IND 6');
    expect(n.sizes[12]).toBe('IND 18');

    expect(n.variants.map((v) => [v.karat, v.metal])).toEqual([
      [9, 'gold_9k'],
      [14, 'gold_14k'],
      [18, 'gold_18k'],
    ]);
    expect(n.variants.map((v) => [v.goldWeight, v.diamondWeight, v.totalWeight, v.price])).toEqual([
      [6.7, 3.08, 9.78, 155392.1],
      [7.66, 3.08, 10.74, 186758.6],
      [8.7, 3.08, 11.78, 219264.2],
    ]);
    for (const v of n.variants) {
      expect(v.bom).toHaveLength(2);
      expect(v.bom[1]).toMatchObject({ isDiamond: true, unit: 'gram', weight: 3.08 });
      expect(v.bom[0].rawMaterialId).toMatch(/^fakeraw-gold/);
    }

    const kinds = (k: string) => n.prices.filter((p) => p.kind === k);
    expect(kinds('indicative')).toEqual([{ kind: 'indicative', amount: 185000, variantKey: '', currency: 'INR' }]);
    expect(kinds('min_variant')[0].amount).toBe(155392.1);
    expect(kinds('natural_diamond')[0].amount).toBe(3900000);
    expect(kinds('variant').map((p) => p.amount)).toEqual([155392.1, 186758.6, 219264.2]);
    expect(kinds('variant_with_margin')).toHaveLength(3);

    // 9 placements, 8 distinct pictures: one URL is reused by two colours.
    expect(n.images).toHaveLength(9);
    expect(new Set(n.images.map((i) => i.url)).size).toBe(8);
    expect([...new Set(n.images.map((i) => i.colour))]).toEqual(['Rose Gold', 'White Gold', 'Yellow Gold']);
    const shared = n.images.filter((i) => i.url.endsWith('side-shared.jpg'));
    // `color` is the colour name; the variantType-level `shape` is kept.
    expect(n.images.every((i) => i.shape === 'Round')).toBe(true);
    expect(shared.map((i) => [i.colour, i.order, i.globalOrder])).toEqual([
      ['Rose Gold', 1, 1],
      ['White Gold', 1, 1],
    ]);
  });

  it('reports spec vs BOM disagreements as conflicts and corrects nothing', () => {
    const n = normalizeWebsiteProduct(golden());
    const spec = n.conflicts.filter((c) => c.kind === 'spec_mismatch');
    expect(spec).toHaveLength(1);
    expect(spec[0].detail).toMatchObject({ field: 'metal_weight', karat: 18, spec: 8.07, bom: 8.7 });
    const unit = n.conflicts.filter((c) => c.kind === 'unit_mismatch');
    expect(unit).toHaveLength(1);
    expect(unit[0].detail).toMatchObject({ field: 'diamond_unit', spec: 'ct' });
    // The values stay exactly as the source sent them.
    expect(n.variants[2].goldWeight).toBe(8.7);
    expect(n.variants[2].bom[1].unit).toBe('gram');
    expect(n.listing.specifications).toContain('8.07 g (18KT)');
  });

  it('is deterministic and the hash ignores key order', () => {
    const a = golden();
    expect(payloadHash(a)).toBe(payloadHash(golden()));
    expect(normalizeWebsiteProduct(a)).toEqual(normalizeWebsiteProduct(golden()));
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(payloadHash(reordered)).toBe(payloadHash(a));
    expect(payloadHash({ ...a, indicativePrice: 1 })).not.toBe(payloadHash(a));
  });

  it('never guesses 18K: 9KT/14KT map to their own metal, unknown is unspecified', () => {
    const n = normalizeWebsiteProduct({
      productCode: 'X1',
      variants: [{ karat: '9KT' }, { karat: '14 kt' }, { karat: 'Rose' }, { karat: '10K', metalType: 'Gold' }, { metalType: 'Platinum' }],
    });
    expect(n.variants.map((v) => v.metal)).toEqual(['gold_9k', 'gold_14k', 'gold_unspecified', 'gold_10k', 'platinum']);
  });

  it('refuses a payload without a code', () => {
    expect(() => normalizeWebsiteProduct({ name: 'x' })).toThrow(/productCode/);
    expect(() => normalizeWebsiteProduct(null)).toThrow();
  });

  it('normalises codes for the join the same way on both sides', () => {
    expect(normaliseCode(' 11871-rg ')).toBe('11871RG');
    expect(normaliseCode('11871_R.G/')).toBe('11871RG');
  });
});

describe('website client (stubbed fetch, never the live site)', () => {
  const config = { get: (k: string) => (k === 'WEBSITE_CATALOGUE_ALLOWED_HOSTS' ? 'apis.eclatdiamonds.in' : undefined) } as any;

  it('parses the envelopes the feed has used', () => {
    expect(parsePage({ data: [{ a: 1 }], total: 5, totalPages: 1 })).toEqual({ products: [{ a: 1 }], total: 5, totalPages: 1 });
    expect(parsePage({ data: { products: [], pagination: { total: 7, totalPages: 2 } } })).toEqual({ products: [], total: 7, totalPages: 2 });
    expect(parsePage({ data: { docs: [1], totalDocs: 1 } }).total).toBe(1);
    expect(() => parsePage({ nothing: true })).toThrow(/no product list/);
  });

  it('only talks https to an allow-listed host, never follows redirects, retries 5xx', async () => {
    const client = new WebsiteCatalogueClient(config);
    client.retryBaseMs = 0;
    const calls: { url: string; init: RequestInit }[] = [];
    let answers: Response[] = [];
    client.fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answers.shift()!;
    }) as any;

    await expect(client.fetchPage('https://evil.example.com/api', 't', 1)).rejects.toThrow(/not allow-listed/);
    await expect(client.fetchPage('http://apis.eclatdiamonds.in/api', 't', 1)).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);

    answers = [new Response('x', { status: 503 }), new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 })];
    await expect(client.fetchPage('https://apis.eclatdiamonds.in/api/', 'secret-token', 3)).resolves.toMatchObject({ total: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://apis.eclatdiamonds.in/api/products?page=3&limit=100');
    expect(calls[0].init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');

    calls.length = 0;
    answers = [new Response('', { status: 302, headers: { location: 'https://elsewhere.example.com' } })];
    await expect(client.fetchPage('https://apis.eclatdiamonds.in/api', 't', 1)).rejects.toThrow(/redirected/);
    expect(calls).toHaveLength(1);

    answers = [new Response('', { status: 401 })];
    const err = await client.fetchPage('https://apis.eclatdiamonds.in/api', 'secret-token', 1).catch((e) => e);
    expect(String(err.message)).toMatch(/HTTP 401/);
    expect(String(err.message)).not.toContain('secret-token');
  });
});
