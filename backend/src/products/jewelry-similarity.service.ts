import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma, ProductCategory, SimilarityFeedback } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { StorageService } from '../storage/storage.service';
import { readImageBytes } from './image-fetch.util';
import { MlInferenceService, BatchItem } from './ml-inference.service';
import { JewelryRankingService, RankCandidate, RANKING_VERSION } from './jewelry-ranking.service';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const BATCH_SIZE = 16;
/**
 * Ceiling on rows pulled into one ranking pass. Since the index became one row
 * per PHOTOGRAPH, this counts photographs, not designs — a catalogue of 1,500
 * designs shot from three angles fits, one of 5,000 shot from three does not.
 * ponytail: in-process scan; the pgvector ANN index (see
 * prisma/manual/20260819_pgvector_dual_embeddings.sql) is the upgrade when a
 * catalogue outgrows it.
 */
const CANDIDATE_CAP = 5000;
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

  private bump(m: Metric): void {
    this.counters[m]++;
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
  async search(
    user: AuthUser,
    file: { buffer?: Buffer; mimetype?: string } | undefined,
    opts: { category?: ProductCategory; limit?: number } = {},
    headerStore?: string,
  ) {
    const queryId = randomUUID();
    const { buffer, mime } = this.validateUpload(file);
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
    const query = await this.inference.embed(buffer, mime);
    const embedMs = Date.now() - t0;
    if (!query) {
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
    const rows = await this.prisma.productEmbedding.findMany({
      where: {
        ...this.scopeWhere(user, headerStore),
        dinoEmbedding: { isEmpty: false },
        siglipEmbedding: { isEmpty: false },
      },
      take: CANDIDATE_CAP,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            imageUrl: true,
            category: true,
            storeId: true,
            store: { select: { name: true } },
          },
        },
      },
    });
    const retrievalMs = Date.now() - t1;

    // Nothing indexed in scope is NOT the same as "no design matched" — the
    // catalogue simply hasn't been embedded yet. Report it distinctly and
    // actionably (how many photographed designs are waiting) instead of a bare
    // no-match, so the UI can tell the operator to run indexing.
    if (rows.length === 0) {
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

    // One candidate per PHOTOGRAPH. A design shot from three angles competes
    // three times and is ranked on its best view; the ranker collapses the
    // duplicates so the result list is still ten designs, not ten pictures.
    const candidates: RankCandidate[] = rows.map((r) => ({
      productId: r.productId,
      dino: r.dinoEmbedding,
      siglip: r.siglipEmbedding,
      category: r.product?.category ?? null,
    }));
    const byId = new Map(rows.map((r) => [r.productId, r.product]));

    const t2 = Date.now();
    const outcome = this.ranking.rank(query.dino, query.siglip, candidates, {
      limit,
      queryCategory: opts.category ?? null,
    });
    const rankMs = Date.now() - t2;

    this.logger.log(
      `similarity queryId=${queryId} status=${outcome.status} candidates=${candidates.length} ` +
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
    return {
      queryId,
      available: true,
      status: 'MATCHES_FOUND' as const,
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
   * Rebuild the ProductEmbedding index for store-scoped products with an image
   * (HO-only endpoint). Idempotent: skips a product whose stored imageHash AND
   * model/preprocessing versions are unchanged (unless force). A failure NEVER
   * corrupts an existing vector — we only upsert on a successful embed.
   */
  async reindex(
    user: AuthUser,
    headerStore: string | undefined,
    opts: { force?: boolean; productId?: string } = {},
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

    const pending: { item: BatchItem; shot: Shot; imageHash: string }[] = [];
    /** Hashes seen this run, per design — the basis for pruning below. */
    const seenHashes = new Map<string, Set<string>>();
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

    for (const [i, shot] of shots.entries()) {
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

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      let results: { id: string; dino: number[]; siglip: number[] }[] = [];
      const errored = new Set<string>();
      try {
        const out = await this.inference.embedBatch(chunk.map((c) => c.item));
        results = out.results;
        for (const e of out.errors) errored.add(e.id);
      } catch (err) {
        this.logger.warn(`embed/batch chunk failed: ${err instanceof Error ? err.message : err}`);
        failed += chunk.length; // whole chunk failed; existing rows untouched.
        continue;
      }
      const ok = new Set(results.map((r) => r.id));
      failed += chunk.filter((c) => !ok.has(c.item.id)).length;

      // Upsert successful rows (the hash of the exact bytes sent is the key).
      for (const c of chunk) {
        const r = results.find((x) => x.id === c.item.id);
        if (!r) continue;
        const p = c.shot.product;
        await this.prisma.productEmbedding.upsert({
          where: {
            productId_imageHash_preprocessingVersion: {
              productId: p.id,
              imageHash: c.imageHash,
              preprocessingVersion: preproc,
            },
          },
          create: {
            organisationId: p.organisationId,
            productId: p.id,
            productImageId: c.shot.productImageId,
            storeId: p.storeId,
            dinoEmbedding: r.dino,
            siglipEmbedding: r.siglip,
            dinoModelVersion: versions.dino ?? 'unknown',
            siglipModelVersion: versions.siglip ?? 'unknown',
            preprocessingVersion: preproc,
            imageHash: c.imageHash,
          },
          update: {
            productImageId: c.shot.productImageId,
            storeId: p.storeId,
            dinoEmbedding: r.dino,
            siglipEmbedding: r.siglip,
            dinoModelVersion: versions.dino ?? 'unknown',
            siglipModelVersion: versions.siglip ?? 'unknown',
          },
        });
        embedded++;
      }
    }

    // Prune vectors whose photograph is gone.
    //
    // A deleted or replaced angle leaves its embedding behind, and a stale
    // vector is worse than a missing one: the design keeps matching searches
    // for a picture that is no longer in the catalogue. Only designs whose
    // every photo was read successfully are pruned — a network blip must not
    // be read as "this design has no pictures any more".
    let pruned = 0;
    for (const [productId, hashes] of seenHashes) {
      if (incomplete.has(productId)) continue;
      const res = await this.prisma.productEmbedding.deleteMany({
        where: { productId, imageHash: { notIn: [...hashes] } },
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
