import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { MetalKind, Prisma, ProductCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { StorageService } from '../storage/storage.service';
import { fetchJson } from '../integrations/integrations.util';
import { ImageEmbeddingService } from './image-embedding.service';

interface Detected {
  category?: string;
  metal?: string;
  keywords: string[];
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const CATEGORIES: ProductCategory[] = [
  'necklace',
  'ring',
  'earrings',
  'bangle',
  'bracelet',
  'pendant',
  'chain',
  'other',
];
const METALS: MetalKind[] = [
  'gold_24k',
  'gold_22k',
  'gold_18k',
  'rose_gold_18k',
  'platinum',
  'silver',
];

/** JSON schema the model must fill — guarantees a parseable, enum-constrained reply. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    metal: { type: 'string', enum: METALS },
    keywords: { type: 'array', items: { type: 'string' } },
  },
  required: ['category', 'metal', 'keywords'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Pure vector helpers (exported for unit tests — no DB, no network).
// ---------------------------------------------------------------------------

/** Cosine similarity in [-1, 1]; 0 when shapes differ or either vector is zero. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank catalogue candidates by cosine similarity to a query embedding, keep only
 * those at/above `threshold`, sort best-first and cap at `limit`.
 *
 * ponytail: O(n) in-memory scan over stored embeddings — fine for a per-store
 * catalogue of a few thousand designs. Move to a pgvector ANN index (see
 * prisma/manual/2026xxxx_pgvector_image_search.sql) once the `vector` extension
 * is installed on the target Postgres.
 */
export function rankByEmbedding<T extends { embedding?: unknown }>(
  query: number[],
  candidates: T[],
  threshold: number,
  limit: number,
): { p: T; s: number }[] {
  return candidates
    .map((p) => ({ p, s: cosineSimilarity(query, (p.embedding as number[]) ?? []) }))
    .filter((x) => x.s >= threshold)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
}

/**
 * Optional metadata pre-filter: narrow the candidate pool to the detected
 * category when the vision tagger produced one AND at least one candidate matches.
 * Non-destructive by design — if the tag matches nothing (e.g. mis-detection) the
 * full pool is returned rather than hiding every genuine visual match.
 */
export function metadataPrefilter<T extends { category?: unknown }>(
  candidates: T[],
  detected: Detected | null,
): T[] {
  if (!detected?.category) return candidates;
  const narrowed = candidates.filter((p) => p.category === detected.category);
  return narrowed.length ? narrowed : candidates;
}

function toView(p: any, similarity?: number) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    metal: p.metal,
    karat: p.karat,
    weightGrams: Number(p.weightGrams),
    caratWeight: Number(p.caratWeight),
    price: Number(p.price),
    availability: p.availability,
    leadTimeDays: p.leadTimeDays ?? undefined,
    storeId: p.storeId ?? '',
    description: p.description ?? '',
    imageUrl: p.imageUrl ?? undefined,
    bestSeller: p.bestSeller,
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

/**
 * AI image search (Module 5).
 *
 * Two clearly-separated capabilities, each honestly labelled in the response:
 *
 *  1. VISUAL SIMILARITY (the real thing): an uploaded photo is turned into an
 *     image embedding by a config-gated provider (`ImageEmbeddingService`), then
 *     ranked by cosine similarity against stored catalogue embeddings. Requires an
 *     image-embedding provider + credential — BLOCKED until one is configured.
 *     Responses carry `visualMatch:true` and a real `similarity` per result.
 *
 *  2. METADATA ENRICHMENT (optional): Claude vision TAGS the image with
 *     category/metal/keywords. This is NOT similarity — it only enriches/filters,
 *     and any keyword-only results are labelled `visualMatch:false` / no similarity.
 *
 * Every returned result is a real store-scoped catalogue Product (real
 * id/sku/price). Nothing is fabricated: no invented SKUs, no floored similarity,
 * no best-sellers dressed up as AI.
 */
@Injectable()
export class AiImageSearchService {
  private readonly logger = new Logger(AiImageSearchService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly embeddings: ImageEmbeddingService,
  ) {}

  private get apiKey(): string {
    return this.config.get<string>('ANTHROPIC_API_KEY') ?? '';
  }

  /** Whether the (optional) Claude vision metadata tagger is available. */
  get taggerEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  /** Cosine threshold below which a candidate is not a match. Calibration knob. */
  private get threshold(): number {
    const v = Number(this.config.get<string>('IMAGE_EMBEDDING_MATCH_THRESHOLD'));
    return Number.isFinite(v) && v > 0 ? v : 0.7;
  }

  /** Ask Claude vision to classify the piece. Returns null on no-key or any failure. */
  private async analyze(buffer: Buffer, mime: string): Promise<Detected | null> {
    if (!this.taggerEnabled) return null;
    try {
      const data = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeoutMs: 30_000,
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mime, data: buffer.toString('base64') },
                },
                {
                  type: 'text',
                  text:
                    'You are a jewellery cataloguing assistant for an Indian jewellery retailer. ' +
                    'Classify this jewellery image: pick the closest category and most likely metal, ' +
                    'and give 3-6 short lowercase style keywords (e.g. "temple", "antique", "floral", ' +
                    '"solitaire", "kundan", "bridal", "minimal"). Respond using the required JSON shape.',
                },
              ],
            },
          ],
          output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        }),
      });
      const text = (data?.content ?? []).find((b: any) => b.type === 'text')?.text;
      if (!text) return null;
      const parsed = JSON.parse(text);
      return {
        category: parsed.category,
        metal: parsed.metal,
        keywords: Array.isArray(parsed.keywords)
          ? parsed.keywords.filter((k: any) => typeof k === 'string')
          : [],
      };
    } catch (err) {
      this.logger.warn(`Claude vision analyze failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Rule-based relevance score 0..1 for a product against detected tags (keyword fallback only). */
  private score(p: any, d: Detected): number {
    let s = 0;
    if (d.category && p.category === d.category) s += 0.5;
    if (d.metal && p.metal === d.metal) s += 0.3;
    const hay = `${p.name} ${p.description ?? ''} ${p.sku}`.toLowerCase();
    const kw = (d.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
    if (kw.length) {
      const hits = kw.filter((k) => hay.includes(k)).length;
      s += Math.min(0.2, (hits / kw.length) * 0.2);
    }
    return s;
  }

  /** Store-scoped candidate WHERE, mirroring ProductsService.list scoping. */
  private scopeWhere(user: AuthUser, headerStore?: string): Prisma.ProductWhereInput {
    // ORGANISATION boundary always — reindex/search never cross tenants.
    const where: Prisma.ProductWhereInput = { organisationId: user.organisationId };
    if (headerStore && headerStore !== 'all') {
      this.scope.assertStoreAllowed(user, headerStore);
      where.OR = [{ storeId: headerStore }, { storeId: null }];
    } else if (!user.allStores) {
      where.OR = [{ storeId: { in: user.storeIds } }, { storeId: null }];
    }
    return where;
  }

  /**
   * Fetch the raw bytes of a stored product image, from its URL.
   * Handles both absolute (R2/Cloudinary) URLs and the local `/uploads/...` path.
   * Returns null on any failure rather than throwing — a broken image just means
   * that one product is skipped during (re)indexing.
   */
  private async readImageBytes(imageUrl: string): Promise<{ buffer: Buffer; mime: string } | null> {
    try {
      if (/^https?:\/\//i.test(imageUrl)) {
        const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return null;
        return {
          buffer: Buffer.from(await res.arrayBuffer()),
          mime: res.headers.get('content-type') ?? 'image/jpeg',
        };
      }
      const prefix = `${this.storage.publicPrefix}/`;
      if (imageUrl.startsWith(prefix)) {
        const rel = imageUrl.slice(prefix.length);
        const buffer = await readFile(join(this.storage.baseDir, rel));
        const ext = rel.toLowerCase().split('.').pop() ?? '';
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        return { buffer, mime };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * (Re)generate and store image embeddings for store-scoped catalogue products
   * (HO-only endpoint). Idempotent: products that already carry an embedding are
   * skipped unless `force`. One embedding per product (the write overwrites in
   * place — no duplicates). Returns null if no embedding provider is configured.
   */
  async reindex(
    user: AuthUser,
    headerStore: string | undefined,
    opts: { force?: boolean } = {},
  ) {
    if (!this.embeddings.available) {
      return {
        available: false,
        reason:
          'Embeddings not generated — no image-embedding provider configured (set IMAGE_EMBEDDING_PROVIDER + URL + KEY).',
        total: 0,
        embedded: 0,
        skipped: 0,
        failed: 0,
      };
    }

    const where: Prisma.ProductWhereInput = {
      ...this.scopeWhere(user, headerStore),
      imageUrl: { not: null },
    };
    const products = await this.prisma.product.findMany({ where, take: 5000 });

    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    for (const p of products) {
      if (!opts.force && Array.isArray(p.embedding) && p.embedding.length) {
        skipped++;
        continue;
      }
      const img = await this.readImageBytes(p.imageUrl!);
      if (!img) {
        failed++;
        continue;
      }
      const vec = await this.embeddings.embedImage(img.buffer, img.mime);
      if (!vec) {
        failed++;
        continue;
      }
      await this.prisma.product.update({ where: { id: p.id }, data: { embedding: vec } });
      embedded++;
    }

    this.logger.log(
      `reindex: ${embedded} embedded, ${skipped} skipped, ${failed} failed of ${products.length}`,
    );
    return { available: true, total: products.length, embedded, skipped, failed };
  }

  /**
   * POST /products/image-search — upload a design photo, get ranked catalogue
   * matches. Response is honestly labelled:
   *   { available, visualMatch, aiUsed, detected, reason?, results }
   */
  async search(
    user: AuthUser,
    file: { buffer?: Buffer; mimetype?: string } | undefined,
    headerStore?: string,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('No image uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }
    if (file.buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image too large (max 12MB)');
    }
    const mime = file.mimetype?.startsWith('image/') ? file.mimetype : 'image/jpeg';
    const where = this.scopeWhere(user, headerStore);

    // ---- 1. Genuine visual similarity (requires an embedding provider) --------
    if (this.embeddings.available) {
      const query = await this.embeddings.embedImage(file.buffer, mime);
      if (!query) {
        // Provider configured but failed/timed out — graceful, not fabricated.
        return {
          available: true,
          visualMatch: false,
          aiUsed: false,
          detected: null,
          reason: 'Visual search temporarily unavailable — embedding provider did not respond.',
          results: [],
        };
      }

      const candidates = await this.prisma.product.findMany({
        where: { ...where, embedding: { isEmpty: false } },
        take: 2000,
      });

      // Optional metadata enrichment: only if the Claude tagger is also available.
      const detected = this.taggerEnabled ? await this.analyze(file.buffer, mime) : null;
      const pool = metadataPrefilter(candidates, detected);

      const ranked = rankByEmbedding(query, pool, this.threshold, 24);
      if (!ranked.length) {
        return {
          available: true,
          visualMatch: true,
          aiUsed: true,
          detected,
          reason: 'No catalogue design matched closely enough.',
          results: [],
        };
      }
      this.logger.log(`image-search: ${ranked.length} visual matches (threshold ${this.threshold})`);
      return {
        available: true,
        visualMatch: true,
        aiUsed: true,
        detected,
        results: ranked.map(({ p, s }) => toView(p, Math.round(s * 1000) / 1000)),
      };
    }

    // ---- 2. No embedding provider → visual search unavailable -----------------
    // Optional Claude metadata tagging is offered as clearly-labelled enrichment,
    // never presented as visual similarity.
    const detected = await this.analyze(file.buffer, mime);
    if (!detected) {
      return {
        available: false,
        visualMatch: false,
        aiUsed: false,
        detected: null,
        reason:
          'AI visual search unavailable — no image-embedding provider configured.',
        results: [],
      };
    }

    const candidates = await this.prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const ranked = candidates
      .map((p) => ({ p, s: this.score(p, detected) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12);
    return {
      available: false,
      visualMatch: false,
      aiUsed: true,
      detected,
      reason: 'Keyword/metadata match only — visual similarity unavailable.',
      // No similarity score: these are keyword matches, not visual matches.
      results: ranked.map(({ p }) => toView(p)),
    };
  }
}
