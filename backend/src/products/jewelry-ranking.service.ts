import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cosineSimilarity } from './ai-image-search.service';

/**
 * Centralised, configurable ranking for jewelry visual similarity (Module 5).
 *
 * All tuning knobs are PROVISIONAL — they have NOT been validated against a
 * labelled jewelry set. Adjust via env once SimilaritySearchFeedback accrues.
 *
 * Pipeline (see rankCandidates):
 *   1. two-stage recall — top-N by DINO cosine ∪ top-N by SigLIP cosine
 *   2. normalize each model's RAW cosine PER candidate set (never add raw dino+siglip)
 *   3. fuse normalized scores with weights + a category-AGREEMENT boost
 *      (category is a signal, NOT a hard filter: a wrong category guess can never
 *       drop the true match)
 *   4. a calibrated closenessScore 0-100 (NOT cosine×100) from the ABSOLUTE
 *      per-candidate similarity, then a matchLevel + a score-margin no-match rule.
 */

export const RANKING_VERSION = 'jewelry-rank-v1';
export const RECALL_PER_MODEL = 40;

export type MatchLevel = 'VERY_CLOSE' | 'CLOSE' | 'SIMILAR' | 'WEAK' | 'NO_CLOSE_MATCH';

export interface Weights {
  dino: number;
  siglip: number;
  category: number;
}

export interface MatchThresholds {
  /** closenessScore floors (0-100). */
  veryClose: number;
  close: number;
  similar: number;
  weak: number;
  /** min gap (closeness points) top1 must lead top2 by to count as a match when
   *  top1 is below the `close` floor. */
  minMargin: number;
}

/**
 * One indexed PHOTOGRAPH. A design shot from several angles contributes one
 * candidate per angle, all carrying the same `productId`; {@link rankCandidates}
 * scores each view independently and then keeps the design’s best one.
 */
export interface RankCandidate {
  productId: string;
  dino: ArrayLike<number>;
  siglip: ArrayLike<number>;
  category?: string | null;
  /** The ProductImage this vector came from, so a hit can say which picture matched. */
  imageId?: string | null;
  /** Both vectors are already unit length: cosine is a plain dot product. */
  unit?: boolean;
}

export interface RankedHit {
  productId: string;
  /** The design's best-matching picture. */
  imageId?: string | null;
  rank: number;
  closenessScore: number;
  matchLevel: MatchLevel;
}

export interface RankOutcome {
  status: 'MATCHES_FOUND' | 'NO_CLOSE_MATCH';
  matchLevel: MatchLevel;
  closenessScore: number;
  results: RankedHit[];
}

export interface RankOptions {
  weights: Weights;
  thresholds: MatchThresholds;
  limit: number;
  queryCategory?: string | null;
}

// --- pure helpers (exported for unit tests — no DB, no network) --------------

/** `v` scaled to unit length (a zero vector stays zero). */
export function unitOf(v: ArrayLike<number>): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const k = s ? 1 / Math.sqrt(s) : 0;
  return Float32Array.from(v as ArrayLike<number>, (x) => x * k);
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/**
 * Indices of the k largest values, largest first; ties keep input order
 * (what a stable full sort would give), in one pass instead of a sort of n.
 */
export function topK(xs: ArrayLike<number>, k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (out.length === k && x <= xs[out[k - 1]]) continue;
    let j = out.length;
    while (j > 0 && xs[out[j - 1]] < x) j--;
    out.splice(j, 0, i);
    if (out.length > k) out.pop();
  }
  return out;
}

/** Min-max normalize to [0,1] within the set. All-equal (incl. singletons) -> 1. */
export function normalizePerSet(values: number[]): number[] {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * Calibrated closeness 0-100 from an ABSOLUTE cosine (~[0,1] for real jewelry).
 * Deliberately NOT cosine×100: piecewise-linear anchors that keep a genuinely
 * strong visual match in the 90s and push a lukewarm one well down, so the score
 * a salesperson reads means "how close", not "raw dot product".
 * ponytail: fixed anchor curve; re-fit from SimilaritySearchFeedback when enough
 * labels exist (upgrade = replace this table, nothing else).
 */
export function calibrateCloseness(absSim: number): number {
  const anchors: [number, number][] = [
    [0.3, 0],
    [0.55, 40],
    [0.75, 70],
    [0.9, 90],
    [1.0, 100],
  ];
  if (absSim <= anchors[0][0]) return 0;
  if (absSim >= 1) return 100;
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (absSim <= x2) {
      const t = (absSim - x1) / (x2 - x1);
      return Math.round(y1 + t * (y2 - y1));
    }
  }
  return 100;
}

export function levelFor(closeness: number, t: MatchThresholds): MatchLevel {
  if (closeness >= t.veryClose) return 'VERY_CLOSE';
  if (closeness >= t.close) return 'CLOSE';
  if (closeness >= t.similar) return 'SIMILAR';
  if (closeness >= t.weak) return 'WEAK';
  return 'NO_CLOSE_MATCH';
}

/**
 * The full ranking pipeline as a pure function. `candidates` are the store-scoped
 * embeddings; everything else is config. Returns an explicit NO_CLOSE_MATCH
 * outcome (empty results) that is distinct from an upstream SEARCH_ERROR.
 */
export function rankCandidates(
  queryDino: ArrayLike<number>,
  querySiglip: ArrayLike<number>,
  candidates: RankCandidate[],
  opts: RankOptions,
): RankOutcome {
  const { weights: w, thresholds: t } = opts;
  if (!candidates.length) {
    return { status: 'NO_CLOSE_MATCH', matchLevel: 'NO_CLOSE_MATCH', closenessScore: 0, results: [] };
  }

  // 1. raw cosines per model — a dot product when both sides are unit length.
  const n = candidates.length;
  const qd = unitOf(queryDino);
  const qs = unitOf(querySiglip);
  const rd = new Float64Array(n);
  const rs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    rd[i] = c.unit ? dot(qd, c.dino) : cosineSimilarity(queryDino, c.dino);
    rs[i] = c.unit ? dot(qs, c.siglip) : cosineSimilarity(querySiglip, c.siglip);
  }

  // 2. two-stage recall: union of top-N by each model (DINO's first).
  const poolIdx = [...new Set([...topK(rd, RECALL_PER_MODEL), ...topK(rs, RECALL_PER_MODEL)])];
  const pool = poolIdx.map((i) => ({ c: candidates[i], rawDino: rd[i], rawSiglip: rs[i] }));

  // 3. normalize each model's raw cosine PER candidate set.
  const nDino = normalizePerSet(pool.map((x) => x.rawDino));
  const nSiglip = normalizePerSet(pool.map((x) => x.rawSiglip));
  const wSum = w.dino + w.siglip + w.category || 1;
  const absW = w.dino + w.siglip || 1;

  const scored = pool.map((x, i) => {
    const catAgree = opts.queryCategory && x.c.category === opts.queryCategory ? 1 : 0;
    // fused (ranking order): normalized + weights + category boost.
    const fused = (w.dino * nDino[i] + w.siglip * nSiglip[i] + w.category * catAgree) / wSum;
    // absolute (closeness): weighted RAW cosine, category-free so a wrong category
    // guess never lowers how "close" the true match reads.
    const absSim = (w.dino * x.rawDino + w.siglip * x.rawSiglip) / absW;
    return { productId: x.c.productId, imageId: x.c.imageId ?? null, fused, closeness: calibrateCloseness(absSim) };
  });

  // 4. sort by fused (ranking), tie-break by closeness.
  scored.sort((a, b) => b.fused - a.fused || b.closeness - a.closeness);

  // 4b. one hit per DESIGN, on its best-matching angle.
  //
  // The index holds a row per photograph, so a ring shot front/side/on-hand
  // appears three times. Left alone, a top-10 of three well-photographed
  // designs would show the same three rings over and over, and the
  // no-match margin below would compare an angle against another angle of the
  // same piece and read a near-zero gap as "ambiguous". The list is already
  // sorted best-first, so the first row of each design is the one to keep.
  const seen = new Set<string>();
  const byDesign = scored.filter((x) => {
    if (seen.has(x.productId)) return false;
    seen.add(x.productId);
    return true;
  });

  const best = byDesign[0];
  const second = byDesign[1];
  const margin = best.closeness - (second?.closeness ?? 0);

  // No-match: absolute floor OR ambiguous (not clearly close AND no standout).
  const noMatch =
    best.closeness < t.weak || (best.closeness < t.close && margin < t.minMargin);
  if (noMatch) {
    return {
      status: 'NO_CLOSE_MATCH',
      matchLevel: 'NO_CLOSE_MATCH',
      closenessScore: best.closeness,
      results: [],
    };
  }

  // Only return actual matches (>= WEAK floor); a closeness-0 tail is not a "match".
  const results: RankedHit[] = byDesign
    .filter((s) => s.closeness >= t.weak)
    .slice(0, opts.limit)
    .map((s, i) => ({
      productId: s.productId,
      imageId: s.imageId,
      rank: i + 1,
      closenessScore: s.closeness,
      matchLevel: levelFor(s.closeness, t),
    }));

  return {
    status: 'MATCHES_FOUND',
    matchLevel: results[0].matchLevel,
    closenessScore: results[0].closenessScore,
    results,
  };
}

@Injectable()
export class JewelryRankingService {
  constructor(private readonly config: ConfigService) {}

  private num(key: string, def: number): number {
    const v = Number(this.config.get<string>(key));
    return Number.isFinite(v) && v >= 0 ? v : def;
  }

  /** PROVISIONAL default weights — DINO structure-led, SigLIP semantics, small category nudge. */
  get weights(): Weights {
    return {
      dino: this.num('SIM_DINO_WEIGHT', 0.5),
      siglip: this.num('SIM_SIGLIP_WEIGHT', 0.4),
      category: this.num('SIM_CATEGORY_WEIGHT', 0.1),
    };
  }

  /** PROVISIONAL matchLevel thresholds + no-match margin. */
  get thresholds(): MatchThresholds {
    return {
      veryClose: this.num('SIM_THRESHOLD_VERY_CLOSE', 85),
      close: this.num('SIM_THRESHOLD_CLOSE', 70),
      similar: this.num('SIM_THRESHOLD_SIMILAR', 50),
      weak: this.num('SIM_THRESHOLD_WEAK', 30),
      minMargin: this.num('SIM_MIN_MARGIN', 5),
    };
  }

  rank(
    queryDino: ArrayLike<number>,
    querySiglip: ArrayLike<number>,
    candidates: RankCandidate[],
    opts: { limit: number; queryCategory?: string | null },
  ): RankOutcome {
    return rankCandidates(queryDino, querySiglip, candidates, {
      weights: this.weights,
      thresholds: this.thresholds,
      limit: opts.limit,
      queryCategory: opts.queryCategory,
    });
  }
}
