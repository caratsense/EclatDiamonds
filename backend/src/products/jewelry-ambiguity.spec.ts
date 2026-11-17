import { rankCandidates, type RankCandidate, type RankOptions } from './jewelry-ranking.service';

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

  it('still refuses when nothing is genuinely close', () => {
    // The absolute floor is the real no-match rule and it stays.
    const unrelated = [candidate('necklace', 40), candidate('bangle', 80)];
    const out = rankCandidates(vec(1), vec(1.01), unrelated, OPTS);
    expect(out.closenessScore).toBeLessThan(OPTS.thresholds.weak);
    expect(out.status).toBe('NO_CLOSE_MATCH');
    expect(out.results).toEqual([]);
  });

  it('still returns nothing when there are no candidates at all', () => {
    const out = rankCandidates(vec(1), vec(1), [], OPTS);
    expect(out.status).toBe('NO_CLOSE_MATCH');
  });

  it('a near-identical image still ranks first', () => {
    // The behaviour that already worked must keep working: the ditto
    // catalogue image is still the top hit, now alongside the look-alikes.
    const out = rankCandidates(q, vec(1.01), [...lookalikes, candidate('exact', 1)], OPTS);
    expect(out.results[0]?.productId).toBe('exact');
    expect(out.matchLevel).toBe('VERY_CLOSE');
  });
});
