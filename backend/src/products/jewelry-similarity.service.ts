import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma, ProductCategory, SimilarityFeedback } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { StorageService } from '../storage/storage.service';
import { readImageBytes } from './image-fetch.util';
import { MlInferenceService, BatchItem, BatchResult, DualEmbedding } from './ml-inference.service';
import {
  JewelryRankingService,
  MatchLevel,
  RankCandidate,
  RANKING_VERSION,
} from './jewelry-ranking.service';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/**
 * Photos per inference call. Each one is now a detection pass (~3-9s on CPU)
 * plus an embedding of the whole frame and of every piece found in it (up to
 * five canvases), so batches are small enough to finish well inside the call's
 * 120s timeout. Throughput is unchanged: the service works through a batch one
 * image at a time either way.
 */
const BATCH_SIZE = 4;
/** Designs one re-index run will consider. */
const CANDIDATE_CAP = 5000;
/** Rows per page when loading the vector index into memory. */
const INDEX_PAGE = 1000;

/**
 * One indexed vector — a whole photograph, or one piece of jewellery detected
 * in it — packed for ranking.
 */
interface IndexedVector extends RankCandidate {
  storeId: string | null;
  dino: Float32Array;
  siglip: Float32Array;
}

/** A background re-index: its progress while running, its outcome after. */
interface ReindexRun {
  startedAt: Date;
  finishedAt?: Date;
  /** Photos processed so far (indexed, already current or unreadable), of all. */
  done: number;
  total: number;
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * How many photographs one search may carry.
 *
 * A piece held in the hand looks different from three sides, and so does the
 * same piece in the catalogue; one photo of each is a single guess at which
 * pair happens to line up. Three is where the returns flatten and the wait at
 * the counter starts to be felt — each one is its own embedding call.
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
  | 'embedding_failure';

/**
 * Jewelry visual similarity (Module 5): orchestrates the DINOv3 + SigLIP 2
 * inference client, the ProductEmbedding index, and the centralised ranker.
 *
 * Honesty contract, identical in spirit to AiImageSearchService:
 *   - no ML_INFERENCE_URL      -> available:false (never fabricates)
 *   - provider error / no embed -> SEARCH_ERROR (distinct from NO_CLOSE_MATCH)
 *   - nothing clears thresholds -> NO_CLOSE_MATCH with empty results
 * Results are ALWAYS real store-scoped catalogue products; raw vectors, model
 * internals and credentials are never returned.
 */
@Injectable()
export class JewelrySimilarityService {
  private readonly logger = new Logger(JewelrySimilarityService.name);
  private readonly counters: Record<Metric, number> = {
    search_count: 0,
    search_success: 0,
    search_failure: 0,
    search_no_match: 0,
    search_not_indexed: 0,
    embedding_failure: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly inference: MlInferenceService,
    private readonly ranking: JewelryRankingService,
  ) {}

  /**
   * Each organisation's vectors, held in memory until its index changes.
   *
   * The index is one row per photograph AND per piece detected in it — ~10k
   * rows for a Gati-plus-website catalogue. Pulled from Postgres on every
   * search that is seconds and hundreds of MB of boxed numbers per request;
   * packed as Float32 it is ~60MB, loaded once. The stamp (row count + latest
   * write) is one cheap aggregate, so a re-index or a new photo is seen by the
   * very next search, on any instance.
   * ponytail: whole-index scan in process; the pgvector ANN index (see
   * prisma/manual/20260819_pgvector_dual_embeddings.sql) is the upgrade when a
   * catalogue reaches ~100k rows.
   */
  private readonly index = new Map<string, { stamp: string; vectors: IndexedVector[] }>();

  /** The latest catalogue-wide re-index per organisation (this instance only). */
  private readonly runs = new Map<string, ReindexRun>();

  private bump(m: Metric): void {
    this.counters[m]++;
  }

  private async orgIndex(organisationId: string): Promise<IndexedVector[]> {
    const agg = await this.prisma.productEmbedding.aggregate({
      where: { organisationId },
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    const stamp = `${agg._count._all}:${agg._max.updatedAt?.getTime() ?? 0}`;
    const cached = this.index.get(organisationId);
    if (cached?.stamp === stamp) return cached.vectors;

    const vectors: IndexedVector[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.productEmbedding.findMany({
        where: { organisationId },
        orderBy: { id: 'asc' },
        take: INDEX_PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          productId: true,
          storeId: true,
          dinoEmbedding: true,
          siglipEmbedding: true,
          product: { select: { category: true } },
        },
      });
      for (const r of page) {
        if (!r.dinoEmbedding.length || !r.siglipEmbedding.length) continue;
        vectors.push({
          productId: r.productId,
          storeId: r.storeId,
          category: r.product?.category ?? null,
          dino: Float32Array.from(r.dinoEmbedding),
          siglip: Float32Array.from(r.siglipEmbedding),
        });
      }
      if (page.length < INDEX_PAGE) break;
      cursor = page[page.length - 1].id;
    }
    this.index.set(organisationId, { stamp, vectors });
    return vectors;
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
    // Applies to both Product and ProductEmbedding (both carry organisationId).
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
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }
    if (file.buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image too large (max 12MB)');
    }
    return { buffer: file.buffer, mime: file.mimetype?.startsWith('image/') ? file.mimetype : 'image/jpeg' };
  }

  // ------------------------------------------------------------------ search
  /**
   * Find the catalogue designs closest to one or more photographs of a piece.
   *
   * Several photos are not several searches. They are several views of the SAME
   * object, so a design is scored on its best view against the customer’s best
   * view and the results stay one list of designs — which is what a salesperson
   * holding a ring and an iPad actually wants.
   */
  async search(
    user: AuthUser,
    files: { buffer?: Buffer; mimetype?: string } | ({ buffer?: Buffer; mimetype?: string } | undefined)[] | undefined,
    opts: { category?: ProductCategory; limit?: number } = {},
    headerStore?: string,
  ) {
    const queryId = randomUUID();
    const uploads = (Array.isArray(files) ? files : [files]).filter(Boolean).slice(0, MAX_QUERY_IMAGES);
    if (!uploads.length) throw new BadRequestException('No image uploaded');
    // Validate every one before embedding any: a rejected third photo should
    // fail the request outright, not after two embedding calls have been paid for.
    const shots = uploads.map((u) => this.validateUpload(u));
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_TOP_N, 1), 50);
    this.bump('search_count');

    if (!this.inference.available) {
      return {
        queryId,
        available: false,
        status: 'SEARCH_ERROR' as const,
        matchLevel: 'NO_CLOSE_MATCH' as const,
        closenessScore: 0,
        reason: 'Visual similarity unavailable — no inference service configured (set ML_INFERENCE_URL).',
        results: [],
      };
    }

    const t0 = Date.now();
    // Sequential, not parallel: the inference service is a single container
    // that may still be waking up, and three simultaneous cold requests are how
    // you turn one slow search into three timed-out ones.
    const queries: DualEmbedding[] = [];
    for (const shot of shots) {
      const q = await this.inference.embed(shot.buffer, shot.mime);
      if (q) queries.push(q);
    }
    const embedMs = Date.now() - t0;
    // One photo failing among several is survivable; all of them failing is not.
    if (!queries.length) {
      this.bump('search_failure');
      this.bump('embedding_failure');
      return {
        queryId,
        available: true,
        status: 'SEARCH_ERROR' as const,
        matchLevel: 'NO_CLOSE_MATCH' as const,
        closenessScore: 0,
        reason: 'Visual search temporarily unavailable — inference service did not respond.',
        results: [],
      };
    }

    const t1 = Date.now();
    const inScope = this.storeFilter(user, headerStore);
    const candidates = (await this.orgIndex(user.organisationId)).filter((v) => inScope(v.storeId));
    const retrievalMs = Date.now() - t1;

    // Nothing indexed in scope is NOT the same as "no design matched" — the
    // catalogue simply hasn't been embedded yet. Report it distinctly and
    // actionably (how many photographed designs are waiting) instead of a bare
    // no-match, so the UI can tell the operator to run indexing.
    if (candidates.length === 0) {
      const indexable = await this.prisma.product.count({
        where: {
          ...(this.scopeWhere(user, headerStore) as Prisma.ProductWhereInput),
          imageUrl: { not: null },
        },
      });
      this.bump('search_not_indexed');
      this.logger.log(`similarity queryId=${queryId} status=NOT_INDEXED indexable=${indexable}`);
      return {
        queryId,
        available: true,
        status: 'NOT_INDEXED' as const,
        matchLevel: 'NO_CLOSE_MATCH' as const,
        closenessScore: 0,
        reason:
          indexable > 0
            ? `Visual search isn't built yet — ${indexable} design${indexable === 1 ? '' : 's'} with photos are waiting to be indexed. Ask an administrator to run visual indexing.`
            : 'No product photos to search yet — add catalogue images, then run visual indexing.',
        results: [],
      };
    }

    // Candidates are one per PHOTOGRAPH and per piece detected in it: a design
    // shot from three angles competes as every one of them and is ranked on its
    // best; the ranker collapses the duplicates so the list is ten designs.
    //
    // The query side is the same. Each photo contributes its whole frame AND
    // each piece of jewellery found in it — so a pendant filling 15% of a shot
    // of a velvet stand is compared as the pendant, against each render cut
    // from a CAD sheet, rather than as a picture of velvet against a picture
    // of a technical drawing. The whole frame stays in as the fallback for a
    // photo where nothing was detected.
    const vectors = queries.flatMap((q) => [q, ...q.views]);

    const t2 = Date.now();
    // Rank each photograph against the same candidate set, then merge.
    //
    // Merging on closenessScore rather than on the fused ranking score is
    // deliberate: closeness is calibrated from the ABSOLUTE similarity and is
    // therefore comparable between runs, while the fused score is min-max
    // normalised within its own candidate pool and means nothing across two.
    //
    // A design keeps its single best view against the customer’s single best
    // view. Averaging instead would punish a design for the angles that happen
    // not to correspond — photograph a ring front-on and the catalogue’s side
    // view drags down a match the front view found perfectly.
    const outcomes = vectors.map((q) =>
      this.ranking.rank(q.dino, q.siglip, candidates, {
        limit: Math.max(limit, DEFAULT_TOP_N),
        queryCategory: opts.category ?? null,
      }),
    );

    const best = new Map<string, { closenessScore: number; matchLevel: MatchLevel }>();
    for (const o of outcomes) {
      for (const hit of o.results) {
        const prev = best.get(hit.productId);
        if (!prev || hit.closenessScore > prev.closenessScore) {
          best.set(hit.productId, { closenessScore: hit.closenessScore, matchLevel: hit.matchLevel });
        }
      }
    }
    const merged = [...best.entries()]
      .map(([productId, v]) => ({ productId, ...v }))
      .sort((a, b) => b.closenessScore - a.closenessScore)
      .slice(0, limit)
      .map((h, i) => ({ ...h, rank: i + 1 }));

    const outcome = {
      status: (merged.length ? 'MATCHES_FOUND' : 'NO_CLOSE_MATCH') as 'MATCHES_FOUND' | 'NO_CLOSE_MATCH',
      // With nothing merged, report the closest any photo came, so the caller
      // can tell “nothing is remotely like this” from “just under the bar”.
      matchLevel: merged[0]?.matchLevel ?? outcomes[0]?.matchLevel ?? ("NO_CLOSE_MATCH" as MatchLevel),
      closenessScore: merged[0]?.closenessScore ?? Math.max(0, ...outcomes.map((o) => o.closenessScore)),
      results: merged,
    };
    const rankMs = Date.now() - t2;

    this.logger.log(
      `similarity queryId=${queryId} status=${outcome.status} photos=${queries.length}/${shots.length} ` +
        `views=${vectors.length - queries.length} ` +
        `candidates=${candidates.length} ` +
        `latency_ms={embed:${embedMs},retrieval:${retrievalMs},rank:${rankMs}}`,
    );

    if (outcome.status === 'NO_CLOSE_MATCH') {
      this.bump('search_no_match');
      return {
        queryId,
        available: true,
        status: 'NO_CLOSE_MATCH' as const,
        matchLevel: outcome.matchLevel,
        closenessScore: outcome.closenessScore,
        reason: 'No catalogue design matched closely enough.',
        results: [],
      };
    }

    this.bump('search_success');
    const byId = new Map(
      (
        await this.prisma.product.findMany({
          where: { id: { in: outcome.results.map((h) => h.productId) } },
          select: {
            id: true,
            name: true,
            sku: true,
            imageUrl: true,
            storeId: true,
            store: { select: { name: true } },
          },
        })
      ).map((p) => [p.id, p]),
    );
    return {
      queryId,
      available: true,
      status: 'MATCHES_FOUND' as const,
      /** How many of the submitted photographs produced a usable vector. */
      photosUsed: queries.length,
      matchLevel: outcome.matchLevel,
      closenessScore: outcome.closenessScore,
      results: outcome.results.map((h) => {
        const p = byId.get(h.productId);
        return {
          productId: h.productId,
          productName: p?.name ?? '',
          sku: p?.sku ?? null,
          imageUrl: p?.imageUrl ?? undefined,
          storeId: p?.storeId ?? null,
          // Store name is included when the product is store-specific; the UI
          // decides whether to show it (relevant only in a multi-store scope).
          storeName: p?.store?.name ?? null,
          rank: h.rank,
          closenessScore: h.closenessScore,
          matchLevel: h.matchLevel,
        };
      }),
    };
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
   * Start a re-index in the background and return at once.
   *
   * A whole catalogue is thousands of photos, each a detection pass plus up to
   * five embeddings — tens of minutes on CPU, far past any HTTP timeout. One run
   * per organisation at a time: pressing again while one is going reports that
   * run instead of doubling the load on the inference service.
   */
  startReindex(user: AuthUser, headerStore: string | undefined, opts: { force?: boolean } = {}) {
    const current = this.runs.get(user.organisationId);
    if (current && !current.finishedAt) return { started: false, ...this.reindexStatus(user) };

    const run: ReindexRun = { startedAt: new Date(), done: 0, total: 0 };
    this.runs.set(user.organisationId, run);
    void this.reindex(user, headerStore, {
      ...opts,
      onProgress: (done, total) => Object.assign(run, { done, total }),
    })
      .then((result) => {
        run.result = result;
      })
      .catch((err) => {
        run.error = err instanceof Error ? err.message : String(err);
        this.logger.warn(`background re-index failed: ${run.error}`);
      })
      .finally(() => {
        run.finishedAt = new Date();
      });
    return { started: true, ...this.reindexStatus(user) };
  }

  reindexStatus(user: AuthUser) {
    const run = this.runs.get(user.organisationId);
    return run ? { running: !run.finishedAt, ...run } : { running: false };
  }

  /**
   * Rebuild the ProductEmbedding index for store-scoped products with an image
   * (HO-only endpoint). Idempotent: skips a product whose stored imageHash AND
   * model/preprocessing versions are unchanged (unless force). A failure NEVER
   * corrupts an existing vector — we only upsert on a successful embed.
   */
  async reindex(
    user: AuthUser,
    headerStore: string | undefined,
    opts: {
      force?: boolean;
      productId?: string;
      /** Photos processed so far / all photos — called after each batch. */
      onProgress?: (done: number, total: number) => void;
    } = {},
  ) {
    if (!this.inference.available) {
      return {
        available: false,
        reason: 'No inference service configured (set ML_INFERENCE_URL).',
        total: 0,
        embedded: 0,
        skipped: 0,
        failed: 0,
      };
    }

    const where: Prisma.ProductWhereInput = {
      // Organisation boundary: reindex only the caller's own catalogue, never
      // another tenant's products (scopeWhere alone is empty for head_office).
      organisationId: user.organisationId,
      ...(this.scopeWhere(user, headerStore) as Prisma.ProductWhereInput),
      // A design qualifies on either kind of picture: a gallery photo, or the
      // legacy single cover that an ERP import still writes straight to the row.
      OR: [{ imageUrl: { not: null } }, { images: { some: {} } }],
      ...(opts.productId ? { id: opts.productId } : {}),
    };
    const products = await this.prisma.product.findMany({
      where,
      take: CANDIDATE_CAP,
      select: {
        id: true,
        storeId: true,
        imageUrl: true,
        organisationId: true,
        images: { select: { id: true, url: true } },
      },
    });

    // Current served versions — lets a model/pipeline bump auto-invalidate rows.
    const versions = await this.inference.currentVersions();
    const preproc = versions.preprocessing ?? 'unknown';

    // Keyed by design AND image hash: a design now has as many rows as it has
    // photographs, so "have I already embedded this?" is a question about a
    // picture, not about a product.
    const existing = new Map(
      (
        await this.prisma.productEmbedding.findMany({
          where: { productId: { in: products.map((p) => p.id) } },
          select: {
            productId: true,
            imageHash: true,
            dinoModelVersion: true,
            siglipModelVersion: true,
            preprocessingVersion: true,
          },
        })
      ).map((e) => [`${e.productId}:${e.imageHash}`, e] as const),
    );

    let embedded = 0;
    let skipped = 0;
    let failed = 0;

    /** One unit of indexing work: a single photograph of a single design. */
    type Shot = {
      product: (typeof products)[number];
      productImageId: string | null;
      url: string;
    };

    // A design with a gallery is indexed from every angle in it. One with only
    // the legacy cover is indexed from that, so an ERP import that writes
    // imageUrl directly is never left out of visual search.
    const shots: Shot[] = [];
    for (const p of products) {
      if (p.images.length) {
        for (const im of p.images) shots.push({ product: p, productImageId: im.id, url: im.url });
      } else if (p.imageUrl) {
        shots.push({ product: p, productImageId: null, url: p.imageUrl });
      }
    }

    /** Photo hashes seen this run, per design — the basis for pruning below. */
    const seenHashes = new Map<string, Set<string>>();
    /**
     * Per design, photo hash -> the exact row hashes it produced: its own, then
     * `<hash>#v1`, `#v2`… for each piece detected in it. Present only for photos
     * that are current after this run (embedded now, or already up to date);
     * an embedded photo lists what it wrote, a skipped one lists nothing.
     */
    const current = new Map<string, Map<string, Set<string> | null>>();
    const markCurrent = (productId: string, photoHash: string, rows: Set<string> | null) => {
      if (!current.has(productId)) current.set(productId, new Map());
      current.get(productId)!.set(photoHash, rows);
    };
    /**
     * Designs where a photo could not be READ, and whose hash is therefore
     * unknown. Pruning works by elimination against the hashes seen this run,
     * so a design missing one is a partial view of itself — eliminate against
     * it and a vector whose image still exists gets deleted.
     *
     * Deliberately not about embedding. Whether the models could describe a
     * picture says nothing about whether that picture is still in the
     * catalogue, and treating a failure as uncertainty let one permanently
     * unembeddable file (a vector placeholder, a corrupt upload) block pruning
     * for its design forever — so deleted photos kept their vectors and went
     * on matching searches. Read is what pruning needs; embedded is not.
     */
    const incomplete = new Set<string>();

    // One batch at a time, read and embedded together. Reading every photo
    // first held all of their bytes at once (~1GB for a 940-photo catalogue)
    // and reported no progress for the minutes the reading alone took.
    opts.onProgress?.(0, shots.length);
    for (let start = 0; start < shots.length; start += BATCH_SIZE) {
      const pending: { item: BatchItem; shot: Shot; imageHash: string }[] = [];
      for (let i = start; i < Math.min(start + BATCH_SIZE, shots.length); i++) {
        const shot = shots[i];
        const p = shot.product;
        const img = await readImageBytes(this.storage, shot.url);
        if (!img) {
          failed++;
          incomplete.add(p.id);
          continue;
        }
        const imageHash = createHash('sha256').update(img.buffer).digest('hex');
        if (!seenHashes.has(p.id)) seenHashes.set(p.id, new Set());
        seenHashes.get(p.id)!.add(imageHash);

        const prev = existing.get(`${p.id}:${imageHash}`);
        const versionsMatch =
          prev &&
          (!versions.dino || prev.dinoModelVersion === versions.dino) &&
          (!versions.siglip || prev.siglipModelVersion === versions.siglip) &&
          prev.preprocessingVersion === preproc;
        if (!opts.force && prev && versionsMatch) {
          skipped++;
          markCurrent(p.id, imageHash, null);
          continue;
        }
        // The batch id identifies the SHOT, not the design: two angles of one ring
        // are two rows, and keying by product id would make the second overwrite
        // the first on the way back out of the inference service.
        pending.push({
          item: { id: `${i}`, bytes: img.buffer, mime: img.mime },
          shot,
          imageHash,
        });
      }

      if (pending.length) {
        let results: BatchResult[] | null = null;
        try {
          results = (await this.inference.embedBatch(pending.map((c) => c.item))).results;
        } catch (err) {
          this.logger.warn(`embed/batch chunk failed: ${err instanceof Error ? err.message : err}`);
        }
        if (!results) {
          failed += pending.length; // whole chunk failed; existing rows untouched.
        } else {
          const ok = new Set(results.map((r) => r.id));
          failed += pending.filter((c) => !ok.has(c.item.id)).length;

          // Upsert successful rows: the photo itself under the hash of the exact
          // bytes sent, then each piece detected in it under `<hash>#v<n>`.
          for (const c of pending) {
            const r = results.find((x) => x.id === c.item.id);
            if (!r) continue;
            const p = c.shot.product;
            const rows = [
              { hash: c.imageHash, vec: r },
              ...r.views.map((v, n) => ({ hash: `${c.imageHash}#v${n + 1}`, vec: v })),
            ];
            for (const { hash, vec } of rows) {
              await this.prisma.productEmbedding.upsert({
                where: {
                  productId_imageHash_preprocessingVersion: {
                    productId: p.id,
                    imageHash: hash,
                    preprocessingVersion: preproc,
                  },
                },
                create: {
                  organisationId: p.organisationId,
                  productId: p.id,
                  productImageId: c.shot.productImageId,
                  storeId: p.storeId,
                  dinoEmbedding: vec.dino,
                  siglipEmbedding: vec.siglip,
                  dinoModelVersion: versions.dino ?? 'unknown',
                  siglipModelVersion: versions.siglip ?? 'unknown',
                  preprocessingVersion: preproc,
                  imageHash: hash,
                },
                update: {
                  productImageId: c.shot.productImageId,
                  storeId: p.storeId,
                  dinoEmbedding: vec.dino,
                  siglipEmbedding: vec.siglip,
                  dinoModelVersion: versions.dino ?? 'unknown',
                  siglipModelVersion: versions.siglip ?? 'unknown',
                },
              });
            }
            markCurrent(p.id, c.imageHash, new Set(rows.map((x) => x.hash)));
            embedded++;
          }
        }
      }
      opts.onProgress?.(Math.min(start + BATCH_SIZE, shots.length), shots.length);
    }

    // Prune vectors whose photograph is gone.
    //
    // A deleted or replaced angle leaves its embedding behind, and a stale
    // vector is worse than a missing one: the design keeps matching searches
    // for a picture that is no longer in the catalogue. Only designs whose
    // every photo was read successfully are pruned — a network blip must not
    // be read as "this design has no pictures any more".
    //
    // Rows are matched to their photo by the part of imageHash before `#`, and
    // a row is stale when:
    //   - its photo is gone;
    //   - its photo is current and the row is from an older pipeline version
    //     (what a version bump leaves behind once the new rows exist);
    //   - its photo was re-embedded now and the row is a view it no longer
    //     produced (the detector found fewer pieces this time).
    // A photo that failed to embed matches none of these, so its old rows —
    // the only ones it has — keep it searchable.
    let pruned = 0;
    for (const [productId, hashes] of seenHashes) {
      if (incomplete.has(productId)) continue;
      const fresh = current.get(productId);
      const rows = await this.prisma.productEmbedding.findMany({
        where: { productId },
        select: { id: true, imageHash: true, preprocessingVersion: true },
      });
      const stale = rows.filter((r) => {
        const photo = r.imageHash.split('#')[0];
        if (!hashes.has(photo)) return true;
        if (!fresh?.has(photo)) return false;
        if (r.preprocessingVersion !== preproc) return true;
        const wrote = fresh.get(photo);
        return wrote != null && !wrote.has(r.imageHash);
      });
      if (!stale.length) continue;
      const res = await this.prisma.productEmbedding.deleteMany({
        where: { id: { in: stale.map((r) => r.id) } },
      });
      pruned += res.count;
    }

    this.logger.log(
      `dual-reindex: ${embedded} embedded, ${skipped} skipped, ${failed} failed, ${pruned} pruned of ${shots.length} photo(s) across ${products.length} design(s)`,
    );
    // `total` counts photographs now, because that is the unit of work. The
    // design count is reported alongside so a caller can still see both.
    return {
      available: true,
      total: shots.length,
      designs: products.length,
      embedded,
      skipped,
      failed,
      pruned,
    };
  }
}
