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
      imageUrl: { not: null },
      ...(opts.productId ? { id: opts.productId } : {}),
    };
    const products = await this.prisma.product.findMany({
      where,
      take: CANDIDATE_CAP,
      select: { id: true, storeId: true, imageUrl: true, organisationId: true },
    });

    // Current served versions — lets a model/pipeline bump auto-invalidate rows.
    const versions = await this.inference.currentVersions();
    const preproc = versions.preprocessing ?? 'unknown';

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
      ).map((e) => [e.productId, e]),
    );

    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    const pending: { item: BatchItem; product: (typeof products)[number] }[] = [];

    for (const p of products) {
      const img = await readImageBytes(this.storage, p.imageUrl!);
      if (!img) {
        failed++;
        continue;
      }
      const imageHash = createHash('sha256').update(img.buffer).digest('hex');
      const prev = existing.get(p.id);
      const versionsMatch =
        prev &&
        (!versions.dino || prev.dinoModelVersion === versions.dino) &&
        (!versions.siglip || prev.siglipModelVersion === versions.siglip) &&
        prev.preprocessingVersion === preproc;
      if (!opts.force && prev && prev.imageHash === imageHash && versionsMatch) {
        skipped++;
        continue;
      }
      pending.push({ item: { id: p.id, bytes: img.buffer, mime: img.mime }, product: p });
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

      // Upsert successful rows (hash the exact buffer we sent, our idempotency key).
      for (const c of chunk) {
        const r = results.find((x) => x.id === c.item.id);
        if (!r) continue;
        const imageHash = createHash('sha256').update(c.item.bytes).digest('hex');
        await this.prisma.productEmbedding.upsert({
          where: { productId_preprocessingVersion: { productId: c.product.id, preprocessingVersion: preproc } },
          create: {
            organisationId: c.product.organisationId,
            productId: c.product.id,
            storeId: c.product.storeId,
            dinoEmbedding: r.dino,
            siglipEmbedding: r.siglip,
            dinoModelVersion: versions.dino ?? 'unknown',
            siglipModelVersion: versions.siglip ?? 'unknown',
            preprocessingVersion: preproc,
            imageHash,
          },
          update: {
            storeId: c.product.storeId,
            dinoEmbedding: r.dino,
            siglipEmbedding: r.siglip,
            dinoModelVersion: versions.dino ?? 'unknown',
            siglipModelVersion: versions.siglip ?? 'unknown',
            imageHash,
          },
        });
        embedded++;
      }
    }

    this.logger.log(
      `dual-reindex: ${embedded} embedded, ${skipped} skipped, ${failed} failed of ${products.length}`,
    );
    return { available: true, total: products.length, embedded, skipped, failed };
  }
}
