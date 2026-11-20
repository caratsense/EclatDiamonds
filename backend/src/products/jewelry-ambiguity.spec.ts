import sharp from 'sharp';
import { rankCandidates, type RankCandidate, type RankOptions } from './jewelry-ranking.service';
import { explainNoMatch, photoIssues } from './jewelry-similarity.service';

/**
 * Why a photograph of a real piece used to find nothing.
 *
 * Reported from production: image search "only works on the same catalogue
 * images, the ditto white-background ones — a new photo is not identified".
 *
 * The cause was not the models. It was an ambiguity gate: results were thrown
 * away entirely when the best score sat below `close` AND the runner-up was
 * within `minMargin`. A catalogue image matches itself near 95 and skips the
 * gate; a phone photo of the same ring scores in the fifties with another
 * gold band a point or two behind, and lost everything.
 *
 * Near-ties are the NORMAL case in a jewellery catalogue — a dozen plain gold
 * bands genuinely do look alike — so the gate was answering the wrong
 * question. Ambiguity is now reported and the results are still returned.
 */

/** A pair of unit vectors a known angle apart, so scores are predictable. */
function vec(seed: number, dim = 8): number[] {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

const OPTS: RankOptions = {
  weights: { dino: 0.5, siglip: 0.4, category: 0.1 },
  thresholds: { veryClose: 85, close: 70, similar: 50, weak: 30, minMargin: 5 },
  limit: 10,
};

const candidate = (productId: string, seed: number): RankCandidate => ({
  productId,
  dino: vec(seed),
  siglip: vec(seed + 0.01),
  unit: true,
});

describe('a photograph with look-alike candidates', () => {
  // Two pieces that genuinely resemble each other and the query: the ordinary
  // situation for plain gold bands, and the one that returned nothing.
  const q = vec(1);
  const lookalikes = [candidate('ring-a', 1.02), candidate('ring-b', 1.03)];

  it('returns the candidates instead of discarding them', () => {
    const out = rankCandidates(q, vec(1.01), lookalikes, OPTS);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.status).toBe('MATCHES_FOUND');
  });

  it('says the top two were close together', () => {
    const out = rankCandidates(q, vec(1.01), lookalikes, OPTS);
    // The signal is kept — a screen can warn — but it no longer suppresses.
    expect(typeof out.ambiguous).toBe('boolean');
  });

  it('says no close match, but still shows the nearest designs, each marked not close', () => {
    // The absolute floor is the real no-match rule and it stays. What changed:
    // a photo of a ring on a hand used to come back to an empty screen.
    const unrelated = [candidate('necklace', 40), candidate('bangle', 80)];
    const out = rankCandidates(vec(1), vec(1.01), unrelated, OPTS);
    expect(out.closenessScore).toBeLessThan(OPTS.thresholds.weak);
    expect(out.status).toBe('NO_CLOSE_MATCH');
    expect(out.results.map((r) => r.productId).sort()).toEqual(['bangle', 'necklace']);
    expect(out.results.every((r) => r.matchLevel === 'NO_CLOSE_MATCH')).toBe(true);
  });

  it('a real match hides the not-close tail', () => {
    const out = rankCandidates(q, vec(1.01), [candidate('exact', 1), candidate('bangle', 80)], OPTS);
    expect(out.results.map((r) => r.productId)).toEqual(['exact']);
  });

  it('still returns nothing when there are no candidates at all', () => {
    const out = rankCandidates(vec(1), vec(1), [], OPTS);
    expect(out.status).toBe('NO_CLOSE_MATCH');
    expect(out.results).toEqual([]);
  });

  it('a near-identical image still ranks first', () => {
    // The behaviour that already worked must keep working: the ditto
    // catalogue image is still the top hit, now alongside the look-alikes.
    const out = rankCandidates(q, vec(1.01), [...lookalikes, candidate('exact', 1)], OPTS);
    expect(out.results[0]?.productId).toBe('exact');
    expect(out.matchLevel).toBe('VERY_CLOSE');
  });
});

describe('saying why nothing matched closely', () => {
  const photo = (create: object, svg?: string) =>
    sharp({ create: { width: 800, height: 800, channels: 3, ...create } as any })
      .composite(svg ? [{ input: Buffer.from(svg) }] : [])
      .jpeg()
      .toBuffer();
  const sharpPhoto = () => photo({ background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } });

  it('a sharp, well-lit photo has no issues', async () => {
    expect(await photoIssues(await sharpPhoto())).toEqual([]);
  });

  it('names a tiny, a dark and a blurred photo', async () => {
    const tiny = await sharp(await sharpPhoto()).resize(300).toBuffer();
    expect(await photoIssues(tiny)).toContain('the photo is very small (low resolution)');
    expect(await photoIssues(await photo({ background: '#141414' }))).toContain('the photo is too dark');
    const blurred = await sharp(await sharpPhoto()).blur(8).toBuffer();
    expect(await photoIssues(blurred)).toContain('the photo is blurred or out of focus');
  });

  it('gold on black velvet is not "too dark"', async () => {
    const velvet = await photo(
      { background: '#0f0f0f' },
      '<svg width="800" height="800"><circle cx="400" cy="400" r="120" fill="#f0c850"/></svg>',
    );
    expect(await photoIssues(velvet)).not.toContain('the photo is too dark');
  });

  it('an unreadable buffer is not an issue list, it is no list', async () => {
    expect(await photoIssues(Buffer.from('not an image'))).toEqual([]);
  });

  it('only says the piece was not found when the detector ran', () => {
    const base = { photos: 1, read: 1, issues: [] };
    expect(explainNoMatch({ ...base, pieceFound: false })).toMatch(/no ring, pendant or other piece/);
    expect(explainNoMatch({ ...base, pieceFound: true })).toMatch(/picked out of the photo clearly/);
    expect(explainNoMatch({ ...base, pieceFound: null })).not.toMatch(/picked out/);
    expect(explainNoMatch({ ...base, photos: 2, issues: ['the photo is too dark'], pieceFound: null })).toMatch(
      /^Likely cause: 1 of 2 photos could not be read; the photo is too dark\./,
    );
  });
});
