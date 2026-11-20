import { BadRequestException, HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { Prisma, ProductCategory, SimilarityFeedback } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { sniffImageMime } from './image-fetch.util';
import { MlInferenceService, DualEmbedding, View } from './ml-inference.service';
import { CatalogueIndexService } from './catalogue-index.service';
import { JewelryRankingService, MatchLevel, RankCandidate, RANKING_VERSION, unitOf } from './jewelry-ranking.service';
import { StampedCache } from './stamped-cache';
import sharp from 'sharp';

/**
 * Photo problems worth naming when a search found nothing close. Checked only
 * on that path, and conservative: a wrong "your photo is blurred" sends the
 * salesperson after the wrong fix.
 * ponytail: thresholds set on phone photos and screenshots, not a labelled
 * jewellery set; re-fit them from NO_CLOSE_MATCH searches if they misfire.
 */
export async function photoIssues(buffer: Buffer): Promise<string[]> {
  try {
    const { width = 0, height = 0 } = await sharp(buffer).metadata();
    // Measured at a fixed size so sharpness compares across photo sizes.
    const grey = await sharp(buffer)
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .toBuffer();
    const { channels, sharpness } = await sharp(grey).stats();
    const issues: string[] = [];
    if (Math.max(width, height) < 500) issues.push('the photo is very small (low resolution)');
    // Gold on black velvet is dark on average too, but it has bright highlights.
    if (channels[0].mean < 45 && channels[0].max < 160) issues.push('the photo is too dark');
    if (sharpness < 0.5) issues.push('the photo is blurred or out of focus');
    return issues;
  } catch {
    return [];
  }
}

/** Why nothing matched closely, in words a salesperson can act on. */
export function explainNoMatch(p: {
  photos: number;
  /** Photos the inference service could read and embed. */
  read: number;
  issues: string[];
  /** Did the detector pick a piece out of any photo? null = cannot tell. */
  pieceFound: boolean | null;
}): string {
  const why = [...p.issues];
  if (p.read < p.photos) why.unshift(`${p.photos - p.read} of ${p.photos} photos could not be read`);
  if (p.pieceFound === false) {
    why.push('no ring, pendant or other piece could be picked out of the photo, so the whole picture (hand and background included) was compared');
  }
  if (why.length) {
    return `Likely cause: ${why.join('; ')}. Retake it closer, in good light, with the piece filling more of the frame. Until then, these are the nearest designs in the catalogue.`;
  }
  return p.pieceFound
    ? 'The piece was picked out of the photo clearly, but nothing in the catalogue looks like it closely. These are the nearest designs we have.'
    : 'Nothing in the catalogue looks like this photo closely. These are the nearest designs we have.';
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Rows per page when loading the vector index into memory. */
const INDEX_PAGE = 1000;
/** The only dimension the ANN index is built for (DINOv2-base / SigLIP 2 base). */
const ANN_DIM = 768;
/** Rows fetched per query vector per model from the ANN index. */
const ANN_K = 50;

/**
 * One indexed vector — a whole photograph, or one piece of jewellery detected
 * in it — packed for ranking.
 */
interface IndexedVector extends RankCandidate {
  storeId: string | null;
  imageId: string;
  /** Where the picture came from: gati_cad, website, manual, inventory, other. */
  source: string;
  dino: Float32Array;
  siglip: Float32Array;
}

/**
 * How many photographs one search may carry: the same piece from up to three
 * sides, scored on its best view against the catalogue's best view.
 */
const MAX_QUERY_IMAGES = 3;

/** One result set is the TOP 10 closest genuine matches (fewer if fewer qualify). */
const DEFAULT_TOP_N = 10;

type Metric =
  | 'search_count'
  | 'search_success'
  | 'search_failure'
  | 'search_no_match'
  | 'search_not_indexed'
  | 'search_rejected'
  | 'cache_hit'
  | 'embedding_failure';

/** Server-Timing stages, in pipeline order. */
const STAGES = ['upload', 'decode', 'detect', 'dino', 'siglip', 'retrieve', 'rank', 'hydrate', 'total'] as const;
type Stage = (typeof STAGES)[number];
const SAMPLE_WINDOW = 500;

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/** Query vectors by sha256 of the uploaded bytes. Insertion order = recency. */
class VectorCache {
  private readonly map = new Map<string, { at: number; v: DualEmbedding }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}
  get(k: string): DualEmbedding | null {
    const e = this.map.get(k);
    if (!e) return null;
    this.map.delete(k);
    if (Date.now() - e.at > this.ttlMs) return null;
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: DualEmbedding) {
    this.map.delete(k);
    this.map.set(k, { at: Date.now(), v });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  get size() {
    return this.map.size;
  }
}

/** Where a search can write response headers (an Express Response fits). */
export interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

/**
 * Jewelry visual similarity (Module 5): orchestrates the DINOv2 + SigLIP 2
 * inference client, the ProductEmbedding index, and the centralised ranker.
 *
 * Honesty contract, identical in spirit to AiImageSearchService:
 *   - no ML_INFERENCE_URL            -> available:false (never fabricates)
 *   - nothing indexed yet            -> CATALOGUE_INDEX_BUILD_REQUIRED, without calling inference
 *   - provider error / no embed      -> SEARCH_ERROR (distinct from NO_CLOSE_MATCH)
 *   - nothing clears thresholds      -> NO_CLOSE_MATCH: the nearest designs, each
 *                                       labelled NO_CLOSE_MATCH, plus a `reason`
 * Results are ALWAYS real store-scoped catalogue products; raw vectors, model
 * internals and credentials are never returned. Query photos are never stored.
 */
@Injectable()
export class JewelrySimilarityService implements OnModuleInit {
  private readonly logger = new Logger(JewelrySimilarityService.name);
  private readonly counters: Record<Metric, number> = {
    search_count: 0,
    search_success: 0,
    search_failure: 0,
    search_no_match: 0,
    search_not_indexed: 0,
    search_rejected: 0,
    cache_hit: 0,
    embedding_failure: 0,
  };
  private readonly samples = new Map<Stage, number[]>();
  // ponytail: per-instance limit and cache; a shared (Redis) one when search runs on several replicas.
  private inFlight = 0;
  private readonly cache: VectorCache;
  /** True when SEARCH_PGVECTOR=1 and the extension + ANN indexes were found at boot. */
  private ann = false;
  /** Whether the inference service's jewellery detector ran on its last call; null until one answers. */
  private detectorOn: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly inference: MlInferenceService,
    private readonly ranking: JewelryRankingService,
    private readonly index: CatalogueIndexService,
    private readonly config: ConfigService,
  ) {
    this.cache = new VectorCache(this.num('SEARCH_CACHE_SIZE', 64), this.num('SEARCH_CACHE_TTL_MS', 10 * 60_000));
  }

  private num(key: string, def: number): number {
    const v = Number(this.config.get<string>(key));
    return Number.isFinite(v) && v > 0 ? v : def;
  }

  async onModuleInit() {
    if (this.config.get<string>('SEARCH_PGVECTOR') === '1') {
      this.ann = await this.detectAnn();
      this.logger.log(
        this.ann
          ? 'visual search retrieval: pgvector ANN'
          : 'SEARCH_PGVECTOR=1 but pgvector / its ANN indexes are missing — using the exact ranker',
      );
    }
    // The exact ranker needs every vector in memory, and reading them takes
    // ~30 s in production. Read them now, behind the boot, so the first search
    // after a deploy does not wait for them. Not in tests, nor where search is
    // off (staging has no inference URL).
    if (!this.ann && this.inference.available && process.env.NODE_ENV !== 'test' && this.config.get<string>('SEARCH_WARM_INDEX') !== '0') {
      void this.warmIndexes();
    }
  }

  /** Every organisation's search vectors, read one organisation after another. */
  private async warmIndexes(): Promise<void> {
    const t = Date.now();
    try {
      const orgs = await this.prisma.productEmbedding.groupBy({
        by: ['organisationId'],
        where: { productImageId: { not: null } },
      });
      for (const o of orgs) await this.orgIndex(o.organisationId);
      this.logger.log(`visual search index ready for ${orgs.length} organisation(s) in ${Date.now() - t} ms`);
    } catch (err) {
      this.logger.warn(`visual search index warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The extension and both HNSW indexes from migration 20260918160000_pgvector_ann_768. */
  async detectAnn(): Promise<boolean> {
    try {
      const [row] = await this.prisma.$queryRaw<{ ok: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
           AND (SELECT count(*) FROM pg_indexes
                 WHERE indexname IN ('ProductEmbedding_dino768_hnsw', 'ProductEmbedding_siglip768_hnsw')) = 2 AS ok`;
      return Boolean(row?.ok);
    } catch {
      return false;
    }
  }

  private bump(m: Metric): void {
    this.counters[m]++;
  }

  private record(stage: Stage, ms: number) {
    const xs = this.samples.get(stage) ?? [];
    xs.push(ms);
    if (xs.length > SAMPLE_WINDOW) xs.shift();
    this.samples.set(stage, xs);
  }

  /** Counters plus p50/p95 per stage over the last {@link SAMPLE_WINDOW} searches. */
  metrics() {
    const stages: Record<string, { p50: number; p95: number; n: number }> = {};
    for (const [k, xs] of this.samples) stages[k] = { p50: percentile(xs, 50), p95: percentile(xs, 95), n: xs.length };
    return {
      counters: { ...this.counters },
      stages,
      inFlight: this.inFlight,
      cacheSize: this.cache.size,
      retrieval: this.ann ? 'pgvector' : 'exact',
    };
  }

  /**
   * Each organisation's vectors, held in memory until its index changes.
   *
   * One row per photograph AND per piece detected in it. Packed as Float32 it
   * is ~60MB for ~10k rows; the stamp (row count + latest write) is one cheap
   * aggregate. Reading every row took 28 s in production (16,108 rows, 20 Nov),
   * and a search used to wait for it after every deploy and every newly indexed
   * photo. Now only the very first read is waited for: when the index changes, a
   * search ranks against the vectors already held while the new ones are read
   * behind it, so a new photo joins the search a moment later. Only rows of a
   * gallery picture are candidates; retired pictures are dropped per search.
   */
  private readonly memIndex = new StampedCache<IndexedVector[]>((organisationId, err) =>
    this.logger.warn(
      `visual search index reload failed for ${organisationId}: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

  private async orgIndex(organisationId: string): Promise<IndexedVector[]> {
    const where: Prisma.ProductEmbeddingWhereInput = { organisationId, productImageId: { not: null } };
    const agg = await this.prisma.productEmbedding.aggregate({
      where,
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    const stamp = `${agg._count._all}:${agg._max.updatedAt?.getTime() ?? 0}`;
    return this.memIndex.get(organisationId, stamp, () => this.readIndex(where));
  }

  /** Every vector the organisation has, page by page. */
  private async readIndex(where: Prisma.ProductEmbeddingWhereInput): Promise<IndexedVector[]> {
    const t = Date.now();
    const vectors: IndexedVector[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.productEmbedding.findMany({
        where,
        orderBy: { id: 'asc' },
        take: INDEX_PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          productId: true,
          productImageId: true,
          storeId: true,
          dinoEmbedding: true,
          siglipEmbedding: true,
          product: { select: { category: true } },
          productImage: { select: { source: true } },
        },
      });
      for (const r of page) {
        if (!r.dinoEmbedding.length || !r.siglipEmbedding.length) continue;
        vectors.push({
          productId: r.productId,
          imageId: r.productImageId!,
          storeId: r.storeId,
          source: r.productImage?.source ?? 'other',
          category: r.product?.category ?? null,
          dino: unitOf(r.dinoEmbedding),
          siglip: unitOf(r.siglipEmbedding),
          unit: true,
        });
      }
      if (page.length < INDEX_PAGE) break;
      cursor = page[page.length - 1].id;
    }
    this.logger.log(`visual search index read: ${vectors.length} vectors in ${Date.now() - t} ms`);
    return vectors;
  }

  /**
   * Candidates from the pgvector HNSW indexes: the nearest rows to every query
   * vector under each model, then ranked exactly like the in-memory path. The
   * store/active/source filters run inside the query (iterative scan keeps recall).
   */
  private async annCandidates(
    user: AuthUser,
    headerStore: string | undefined,
    vectors: View[],
    source?: string,
  ): Promise<IndexedVector[]> {
    const stores =
      headerStore && headerStore !== 'all' ? [headerStore] : user.allStores ? null : user.storeIds;
    // $1 is the organisation and $2 the query vector; the optional filters follow.
    const extra: unknown[] = [];
    let filterSql = '';
    if (stores) {
      extra.push(stores);
      filterSql += ` AND (e."storeId" IS NULL OR e."storeId" = ANY($${extra.length + 2}::text[]))`;
    }
    if (source) {
      extra.push(source);
      filterSql += ` AND i.source = $${extra.length + 2}`;
    }
    const ids = new Set<string>();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = 200`);
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      for (const q of vectors) {
        for (const [col, vec] of [
          ['dinoEmbedding', q.dino],
          ['siglipEmbedding', q.siglip],
        ] as const) {
          const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT e.id FROM "ProductEmbedding" e
               JOIN "ProductImage" i ON i.id = e."productImageId" AND i.status = 'active'
              WHERE e."organisationId" = $1 AND array_length(e."${col}", 1) = ${ANN_DIM}${filterSql}
              ORDER BY (e."${col}"::vector(${ANN_DIM})) <=> $2::vector(${ANN_DIM})
              LIMIT ${ANN_K}`,
            user.organisationId,
            `[${vec.join(',')}]`,
            ...extra,
          );
          for (const r of rows) ids.add(r.id);
        }
      }
    });
    const rows = await this.prisma.productEmbedding.findMany({
      where: { id: { in: [...ids] } },
      select: {
        productId: true,
        productImageId: true,
        storeId: true,
        dinoEmbedding: true,
        siglipEmbedding: true,
        product: { select: { category: true } },
        productImage: { select: { source: true } },
      },
    });
    return rows.map((r) => ({
      productId: r.productId,
      imageId: r.productImageId!,
      storeId: r.storeId,
      source: r.productImage?.source ?? 'other',
      category: r.product?.category ?? null,
      dino: unitOf(r.dinoEmbedding),
      siglip: unitOf(r.siglipEmbedding),
      unit: true,
    }));
  }

  /** In-memory twin of {@link scopeWhere}, for vectors already loaded. */
  private storeFilter(user: AuthUser, headerStore?: string): (storeId: string | null) => boolean {
    if (headerStore && headerStore !== 'all') {
      this.scope.assertStoreAllowed(user, headerStore);
      return (s) => s === null || s === headerStore;
    }
    if (!user.allStores) {
      const mine = new Set(user.storeIds);
      return (s) => s === null || mine.has(s);
    }
    return () => true;
  }

  /** Store-scoped WHERE for a table carrying a nullable storeId (null = company-wide). */
  private scopeWhere(user: AuthUser, headerStore?: string): { organisationId: string; OR?: any[] } {
    // ORGANISATION boundary always — visual search/reindex never cross tenants.
    const org = { organisationId: user.organisationId };
    if (headerStore && headerStore !== 'all') {
      this.scope.assertStoreAllowed(user, headerStore);
      return { ...org, OR: [{ storeId: headerStore }, { storeId: null }] };
    }
    if (!user.allStores) return { ...org, OR: [{ storeId: { in: user.storeIds } }, { storeId: null }] };
    return org;
  }

  private validateUpload(file?: { buffer?: Buffer; mimetype?: string }): { buffer: Buffer; mime: string } {
    if (!file?.buffer?.length) throw new BadRequestException('No image uploaded');
    if (file.buffer.length > MAX_IMAGE_BYTES) throw new BadRequestException('Image too large (max 12MB)');
    // The bytes decide, not the client's content-type.
    const mime = sniffImageMime(file.buffer);
    if (!mime) throw new BadRequestException('Uploaded file is not an image');
    return { buffer: file.buffer, mime };
  }

  // ------------------------------------------------------------------ search
  /**
   * Find the catalogue designs closest to one to three photographs of a piece.
   *
   * Several photos are several views of the SAME object, so a design is scored
   * on its best view against the customer's best view and the result is one
   * list of designs, each shown with the picture of it that matched.
   */
  async search(
    user: AuthUser,
    files: { buffer?: Buffer; mimetype?: string } | ({ buffer?: Buffer; mimetype?: string } | undefined)[] | undefined,
    /** `source`: match only catalogue pictures from it (gati_cad, website); absent = every picture. */
    opts: { category?: ProductCategory; limit?: number; source?: string } = {},
    headerStore?: string,
    res?: HeaderSink,
  ) {
    const t0 = Date.now();
    const queryId = randomUUID();
    const uploads = (Array.isArray(files) ? files : [files]).filter(Boolean).slice(0, MAX_QUERY_IMAGES);
    if (!uploads.length) throw new BadRequestException('No image uploaded');
    // Validate every one before embedding any.
    const shots = uploads.map((u) => this.validateUpload(u));
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_TOP_N, 1), 50);
    const inScope = this.storeFilter(user, headerStore);
    this.bump('search_count');

    const empty = (status: 'SEARCH_ERROR' | 'NO_CLOSE_MATCH', reason: string, extra: Record<string, unknown> = {}) => ({
      queryId,
      available: true,
      status,
      matchLevel: 'NO_CLOSE_MATCH' as MatchLevel,
      closenessScore: 0,
      reason,
      ...extra,
      results: [],
    });

    if (!this.inference.available) {
      return {
        ...empty('SEARCH_ERROR', 'Visual similarity unavailable — no inference service configured (set ML_INFERENCE_URL).'),
        available: false,
      };
    }

    // Preflight: an organisation with nothing indexed gets its coverage back at
    // once — no inference call, no queue slot, no spinner.
    const indexedRows = await this.prisma.productEmbedding.count({
      where: { organisationId: user.organisationId, productImage: { status: 'active' } },
    });
    if (!indexedRows) {
      const c = await this.index.counts(user.organisationId);
      this.bump('search_not_indexed');
      return {
        queryId,
        available: true,
        status: 'CATALOGUE_INDEX_BUILD_REQUIRED' as const,
        matchLevel: 'NO_CLOSE_MATCH' as const,
        closenessScore: 0,
        coverage: {
          indexed: c.indexed,
          total: c.total,
          queued: c.queued + c.running + c.pending,
          failed: c.failed + c.dead,
        },
        reason:
          c.total > 0
            ? `Visual search isn't built yet — ${c.total} photo${c.total === 1 ? '' : 's'} waiting to be indexed. Ask an administrator to run visual indexing.`
            : 'No product photos to search yet — add catalogue images, then run visual indexing.',
        results: [],
      };
    }

    const maxConcurrent = this.num('SEARCH_MAX_CONCURRENT', 2);
    if (this.inFlight >= maxConcurrent) {
      this.bump('search_rejected');
      const p50 = this.samples.get('total')?.length ? percentile(this.samples.get('total')!, 50) : 5000;
      const retryAfter = Math.max(1, Math.ceil(p50 / 1000));
      res?.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        { statusCode: 429, message: 'Visual search is busy — try again in a few seconds.', retryAfter },
        429,
      );
    }
    this.inFlight++;
    try {
      return await this.runSearch(user, headerStore, shots, limit, opts.category, opts.source, inScope, queryId, t0, res, empty);
    } finally {
      this.inFlight--;
    }
  }

  private async runSearch(
    user: AuthUser,
    headerStore: string | undefined,
    shots: { buffer: Buffer; mime: string }[],
    limit: number,
    category: ProductCategory | undefined,
    source: string | undefined,
    inScope: (s: string | null) => boolean,
    queryId: string,
    t0: number,
    res: HeaderSink | undefined,
    empty: (s: 'SEARCH_ERROR' | 'NO_CLOSE_MATCH', reason: string, extra?: Record<string, unknown>) => any,
  ) {
    const timing: Partial<Record<Stage, number>> = {};
    const deadline = t0 + this.num('SEARCH_DEADLINE_MS', 45_000);

    // ONE inference call for every photo the cache does not already know.
    const keys = shots.map((s) => createHash('sha256').update(s.buffer).digest('hex'));
    const vecs: (DualEmbedding | null)[] = keys.map((k) => this.cache.get(k));
    const hits = vecs.filter(Boolean).length;
    if (hits) this.counters.cache_hit += hits;
    const miss = vecs.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    let failure = '';
    /** Photos the service answered for but could not decode. */
    let unreadable = 0;
    if (miss.length) {
      try {
        const call = () =>
          this.inference.embedBatch(
            miss.map((i) => ({ id: String(i), bytes: shots[i].buffer, mime: shots[i].mime })),
            { timeoutMs: Math.max(1_000, deadline - Date.now()) },
          );
        let out;
        try {
          out = await call();
        } catch (err) {
          // An idle inference service may be asleep: the call that wakes it
          // fails fast (refused / 502). One retry, and only inside the deadline.
          if (/abort|timeout/i.test(String(err)) || deadline - Date.now() < 5_000) throw err;
          this.logger.log(`similarity queryId=${queryId} embed failed fast; retrying once in case inference was asleep`);
          await new Promise((r) => setTimeout(r, 2_000));
          out = await call();
        }
        if (out.pipeline != null) this.detectorOn = out.pipeline >= 2;
        unreadable = out.errors.length;
        for (const r of out.results) {
          const i = Number(r.id);
          if (!Number.isInteger(i) || !miss.includes(i)) continue;
          vecs[i] = { dino: r.dino, siglip: r.siglip, views: r.views };
          this.cache.set(keys[i], vecs[i]!);
        }
        const compute = ['decode', 'detect', 'dino', 'siglip'] as const;
        for (const s of compute) if (out.timings[s] != null) timing[s] = out.timings[s];
        // What the call cost beyond the service's own compute: transfer + queueing.
        timing.upload = Math.max(0, out.wallMs - compute.reduce((n, s) => n + (out.timings[s] ?? 0), 0));
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        this.logger.warn(`similarity queryId=${queryId} embed failed: ${failure}`);
      }
    }
    const queries = vecs.filter((v): v is DualEmbedding => !!v);
    if (!queries.length) {
      this.bump('search_failure');
      this.bump('embedding_failure');
      return empty(
        'SEARCH_ERROR',
        /abort|timeout/i.test(failure)
          ? // Almost always a cold start: the first search of the day wakes two
            // vision models. Saying "try again" alone invites a second wait;
            // saying WHY, and that the second is quick, is the difference
            // between somebody retrying and somebody giving up on the feature.
            'The image models were waking up, so this search ran out of time. ' +
            'Try once more — it will be quick now.'
          : unreadable && !failure
            ? 'This photo could not be read. Take a fresh photo, or send it as a JPG, PNG or WebP.'
            : 'Visual search temporarily unavailable — inference service did not respond.',
      );
    }

    // Each photo contributes its whole frame AND each piece detected in it.
    const vectors = queries.flatMap((q) => [q, ...q.views]);

    let t = Date.now();
    const annOk = this.ann && vectors.every((v) => v.dino.length === ANN_DIM && v.siglip.length === ANN_DIM);
    // Pictures tombstoned but whose vectors were not purged yet are never candidates.
    const inactive = new Set(
      (
        await this.prisma.productEmbedding.findMany({
          where: { organisationId: user.organisationId, productImage: { status: { not: 'active' } } },
          select: { productImageId: true },
          distinct: ['productImageId'],
        })
      ).map((r) => r.productImageId),
    );
    const candidates = (
      annOk ? await this.annCandidates(user, headerStore, vectors, source) : await this.orgIndex(user.organisationId)
    ).filter((v) => inScope(v.storeId) && !inactive.has(v.imageId) && (!source || v.source === source));
    timing.retrieve = Date.now() - t;

    t = Date.now();
    // Rank each vector against the same candidates, then keep each design's
    // single best view (closeness is absolute, so it compares across runs).
    const outcomes = vectors.map((q) =>
      this.ranking.rank(q.dino, q.siglip, candidates, { limit: Math.max(limit, DEFAULT_TOP_N), queryCategory: category ?? null }),
    );
    const best = new Map<string, { closenessScore: number; matchLevel: MatchLevel; imageId: string | null }>();
    for (const o of outcomes) {
      for (const hit of o.results) {
        const prev = best.get(hit.productId);
        if (!prev || hit.closenessScore > prev.closenessScore) {
          best.set(hit.productId, { closenessScore: hit.closenessScore, matchLevel: hit.matchLevel, imageId: hit.imageId ?? null });
        }
      }
    }
    const all = [...best.entries()]
      .map(([productId, v]) => ({ productId, ...v }))
      .sort((a, b) => b.closenessScore - a.closenessScore);
    // If anything cleared the floor, only matches are shown. If nothing did,
    // the nearest designs are shown as "not close", with the reason why.
    const matched = all.some((h) => h.matchLevel !== 'NO_CLOSE_MATCH');
    const merged = all
      .filter((h) => !matched || h.matchLevel !== 'NO_CLOSE_MATCH')
      .slice(0, limit)
      .map((h, i) => ({ ...h, rank: i + 1 }));
    timing.rank = Date.now() - t;

    let body: any;
    if (!merged.length) {
      // No candidate at all in this store's scope: nothing to be near.
      this.bump('search_no_match');
      body = empty(
        'NO_CLOSE_MATCH',
        source
          ? 'None of the catalogue photos of that kind are searchable in this store yet. Search all photos instead.'
          : 'There are no searchable catalogue photos in this store yet.',
      );
    } else {
      t = Date.now();
      this.bump(matched ? 'search_success' : 'search_no_match');
      const [products, images, reason] = await Promise.all([
        this.prisma.product.findMany({
          where: { id: { in: merged.map((h) => h.productId) }, organisationId: user.organisationId },
          select: {
            id: true,
            name: true,
            sku: true,
            imageUrl: true,
            storeId: true,
            store: { select: { name: true } },
            websiteListing: { select: { marketingName: true } },
          },
        }),
        this.prisma.productImage.findMany({
          where: { id: { in: merged.map((h) => h.imageId).filter((x): x is string => !!x) } },
          select: {
            id: true,
            url: true,
            source: true,
            sourceUrl: true,
            createdAt: true,
            angle: true,
            associations: {
              where: { tombstonedAt: null },
              orderBy: { sourceOrder: 'asc' },
              take: 1,
              select: { colour: true, angle: true },
            },
          },
        }),
        matched ? undefined : this.whyNoMatch(shots, queries),
      ]);
      const byId = new Map(products.map((p) => [p.id, p]));
      const imgById = new Map(images.map((m) => [m.id, m]));
      body = {
        queryId,
        available: true,
        status: matched ? ('MATCHES_FOUND' as const) : ('NO_CLOSE_MATCH' as const),
        /** How many of the submitted photographs produced a usable vector. */
        photosUsed: queries.length,
        matchLevel: merged[0].matchLevel,
        closenessScore: merged[0].closenessScore,
        ...(reason ? { reason } : {}),
        results: merged.map((h) => {
          const p = byId.get(h.productId);
          const m = h.imageId ? imgById.get(h.imageId) : undefined;
          const a = m?.associations[0];
          return {
            productId: h.productId,
            productName: p?.websiteListing?.marketingName || p?.name || '',
            sku: p?.sku ?? null,
            imageUrl: p?.imageUrl ?? undefined,
            storeId: p?.storeId ?? null,
            storeName: p?.store?.name ?? null,
            rank: h.rank,
            closenessScore: h.closenessScore,
            matchLevel: h.matchLevel,
            matchedImageId: m?.id ?? null,
            matchedImageUrl: m?.url ?? null,
            matchedImageSource: m?.source ?? null,
            matchedImageSourceUrl: m?.sourceUrl ?? null,
            matchedImageAddedAt: m?.createdAt ?? null,
            matchedColour: a?.colour || null,
            matchedAngle: m?.angle ?? a?.angle ?? null,
            heroImageUrl: p?.imageUrl ?? null,
          };
        }),
      };
      timing.hydrate = Date.now() - t;
    }

    timing.total = Date.now() - t0;
    for (const s of STAGES) if (timing[s] != null) this.record(s, timing[s]!);
    res?.setHeader(
      'Server-Timing',
      [
        ...STAGES.filter((s) => timing[s] != null).map((s) => `${s};dur=${timing[s]}`),
        `cache;desc="${hits}/${shots.length} hit"`,
      ].join(', '),
    );
    this.logger.log(
      `similarity queryId=${queryId} status=${body.status} photos=${queries.length}/${shots.length} cache=${hits} ` +
        `views=${vectors.length - queries.length} candidates=${candidates.length} source=${source ?? 'all'} ` +
        `retrieval=${annOk ? 'ann' : 'exact'} ` +
        `ms=${JSON.stringify(timing)}`,
    );
    return body;
  }

  /** The reason a search found nothing close, from the photos and what the detector saw. */
  private async whyNoMatch(shots: { buffer: Buffer }[], queries: DualEmbedding[]): Promise<string> {
    const issues = new Set((await Promise.all(shots.map((s) => photoIssues(s.buffer)))).flat());
    return explainNoMatch({
      photos: shots.length,
      read: queries.length,
      issues: [...issues],
      // Only claim what the detector saw when it actually ran.
      // ponytail: under DETECT_MODE=auto a clean product shot skips detection and
      // reads as "no piece found"; production runs `always`.
      pieceFound: this.detectorOn ? queries.some((q) => q.views.length > 0) : null,
    });
  }

  // ---------------------------------------------------------------- feedback
  async feedback(
    user: AuthUser,
    dto: { queryId: string; productId: string; rank: number; feedback: SimilarityFeedback },
    headerStore?: string,
  ) {
    // Store-scope: the product must be visible to the caller.
    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, ...this.scopeWhere(user, headerStore) },
      select: { id: true, storeId: true },
    });
    if (!product) throw new BadRequestException('Unknown or out-of-scope product');

    // Model versions in play, for later calibration (best-effort, from the index row).
    const emb = await this.prisma.productEmbedding.findFirst({
      where: { productId: dto.productId },
      orderBy: { updatedAt: 'desc' },
      select: { dinoModelVersion: true, siglipModelVersion: true, preprocessingVersion: true },
    });

    await this.prisma.similaritySearchFeedback.create({
      data: {
        organisationId: user.organisationId,
        queryId: dto.queryId,
        productId: dto.productId,
        storeId: product.storeId,
        rank: dto.rank,
        score: 0, // client does not resend the score; captured from feedback context only.
        feedback: dto.feedback,
        rankingVersion: RANKING_VERSION,
        modelVersions: {
          dino: emb?.dinoModelVersion ?? 'unknown',
          siglip: emb?.siglipModelVersion ?? 'unknown',
          preprocessing: emb?.preprocessingVersion ?? 'unknown',
        } as Prisma.InputJsonValue,
      },
    });
    return { stored: true };
  }

  // ----------------------------------------------------------------- reindex
  /**
   * Queue the (store-scoped) catalogue for indexing and return at once. The
   * work runs on the durable job queue; progress is read back from the
   * pictures' own status, so a restart or a second instance loses nothing.
   */
  async startReindex(user: AuthUser, headerStore: string | undefined, opts: { force?: boolean; productId?: string } = {}) {
    if (!this.inference.available) {
      return {
        started: false,
        available: false,
        reason: 'No inference service configured (set ML_INFERENCE_URL).',
        ...(await this.reindexStatus(user)),
      };
    }
    // A head-office rebuild can afford one live /health: it decides what counts
    // as current, and warms the cache enqueue reads.
    await this.index.currentVersion();
    const r = await this.index.rebuild(user.organisationId, {
      force: opts.force,
      productId: opts.productId,
      productWhere: this.scopeWhere(user, headerStore) as Prisma.ProductWhereInput,
    });
    this.logger.log(`visual index rebuild ${user.organisationId}: queued ${r.queued} of ${r.total}, purged ${r.purged}`);
    return { started: r.queued > 0, available: true, queued: r.queued, purged: r.purged, ...(await this.reindexStatus(user)) };
  }

  /** Counts straight from ProductImage.embeddingStatus — the only truth. */
  async reindexStatus(user: AuthUser) {
    const c = await this.index.counts(user.organisationId);
    return {
      running: c.queued + c.running + c.failed > 0,
      done: c.indexed + c.dead + c.skipped,
      total: c.total,
      counts: c,
      version: this.index.cachedVersion(),
      result: { embedded: c.indexed, failed: c.failed + c.dead, skipped: c.skipped, total: c.total },
      searchMetrics: this.metrics(),
    };
  }
}
