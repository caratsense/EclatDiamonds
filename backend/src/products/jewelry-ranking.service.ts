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
  dino: number[];
  siglip: number[];
  category?: string | null;
}

export interface RankedHit {
  productId: string;
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
  queryDino: number[],
  querySiglip: number[],
  candidates: RankCandidate[],
  opts: RankOptions,
): RankOutcome {
  const { weights: w, thresholds: t } = opts;
  if (!candidates.length) {
    return { status: 'NO_CLOSE_MATCH', matchLevel: 'NO_CLOSE_MATCH', closenessScore: 0, results: [] };
  }

  // 1. raw cosines per model.
  const raw = candidates.map((c) => ({
    c,
    rawDino: cosineSimilarity(queryDino, c.dino),
    rawSiglip: cosineSimilarity(querySiglip, c.siglip),
  }));

  // 2. two-stage recall: union of top-N by each model.
  const byDino = [...raw].sort((a, b) => b.rawDino - a.rawDino).slice(0, RECALL_PER_MODEL);
  const bySiglip = [...raw].sort((a, b) => b.rawSiglip - a.rawSiglip).slice(0, RECALL_PER_MODEL);
  const pool = [...new Set([...byDino, ...bySiglip])];

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
    return { productId: x.c.productId, fused, closeness: calibrateCloseness(absSim) };
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
    queryDino: number[],
    querySiglip: number[],
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
