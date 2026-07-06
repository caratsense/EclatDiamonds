import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetalKind, Prisma, ProductCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { fetchJson } from '../integrations/integrations.util';

interface Detected {
  category?: string;
  metal?: string;
  keywords: string[];
}

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
 * AI image search (Module 5). Uses Claude vision (the only sanctioned AI per the
 * project's no-ML rule) to TAG an uploaded design photo with category/metal/style
 * keywords, then does a deterministic, RULE-BASED match against the store-scoped
 * catalogue. Code-complete behind ANTHROPIC_API_KEY: with no key it degrades to a
 * pure rule-based "best matches" view (aiUsed=false). No trained embedding model.
 */
@Injectable()
export class AiImageSearchService {
  private readonly logger = new Logger(AiImageSearchService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  private get apiKey(): string {
    return this.config.get<string>('ANTHROPIC_API_KEY') ?? '';
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  /** Ask Claude vision to classify the piece. Returns null on no-key or any failure. */
  private async analyze(buffer: Buffer, mime: string): Promise<Detected | null> {
    if (!this.enabled) return null;
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
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k: any) => typeof k === 'string') : [],
      };
    } catch (err) {
      this.logger.warn(`Claude vision analyze failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Rule-based relevance score 0..1 for a product against the detected attributes. */
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

  /**
   * POST /products/image-search — upload a design photo, get ranked catalogue
   * matches. Returns `{ aiUsed, detected, results }`.
   */
  async search(user: AuthUser, file: { buffer?: Buffer; mimetype?: string } | undefined, headerStore?: string) {
    if (!file?.buffer?.length) throw new BadRequestException('No image uploaded');
    const mime = file.mimetype && file.mimetype.startsWith('image/') ? file.mimetype : 'image/jpeg';

    // Store-scoped candidate set (mirrors ProductsService.list scoping).
    const where: Prisma.ProductWhereInput = {};
    if (headerStore && headerStore !== 'all') {
      this.scope.assertStoreAllowed(user, headerStore);
      where.OR = [{ storeId: headerStore }, { storeId: null }];
    } else if (!user.allStores) {
      where.OR = [{ storeId: { in: user.storeIds } }, { storeId: null }];
    }

    const detected = await this.analyze(file.buffer, mime);

    const candidates = await this.prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    if (!detected) {
      // No AI key / failure → rule-based fallback: best-sellers first, then recent.
      const fallback = [...candidates]
        .sort((a, b) => Number(b.bestSeller) - Number(a.bestSeller))
        .slice(0, 12)
        .map((p) => toView(p));
      return { aiUsed: false, detected: null, results: fallback };
    }

    const ranked = candidates
      .map((p) => ({ p, s: this.score(p, detected) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map(({ p, s }) => toView(p, Math.round(Math.max(s, 0.4) * 100) / 100));

    this.logger.log(
      `image-search: detected ${detected.category}/${detected.metal} [${detected.keywords.join(', ')}] → ${ranked.length} matches`,
    );
    return { aiUsed: true, detected, results: ranked };
  }
}
