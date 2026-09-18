import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Availability, MetalKind, Prisma, ProductCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { PageRequest, Paginated } from '../common/pagination';
import { StorageService } from '../storage/storage.service';
import { stockClassWhere } from '../stock/stock-class';
import { CreateProductDto } from './dto/product.dto';
import { forViewer } from './composition';
import { ROLE_RANK } from '../common/role.util';
import { applyImageOrder } from '../catalogue/image-order';
import { CatalogueIndexService } from './catalogue-index.service';
import { sniffImageMime } from './image-fetch.util';
import sharp from 'sharp';
import {
  COST_PRICE_KINDS,
  STOCK_COST_FIELDS,
  VARIANT_COST_FIELDS,
  costTier,
  stripCostJson,
} from './cost-boundary';

/**
 * Where a design can actually be had, from the viewer's counter.
 *
 * Derived from StockItem rather than stored on Product, because "is it
 * available" has no single answer — it depends entirely on who is asking and
 * where they are standing. The same ring is "on the shelf" in Bandra and "three
 * days away" in Udaipur, and a flag on the design cannot say both.
 */
export interface StockPresence {
  /** Pieces on hand in the store the viewer is looking at. */
  hereCount: number;
  /** Pieces in other branches, newest-first by count. */
  elsewhere: { storeId: string; storeName: string; count: number }[];
  /** Everything on hand across the branches the viewer may see. */
  totalCount: number;
  /**
   * What a salesperson should say out loud:
   *   here      — "I can show it to you now"
   *   elsewhere — "I can have it brought from Kala Ghoda"
   *   made      — "we can make it for you" (in the catalogue, nobody stocks it)
   */
  where: 'here' | 'elsewhere' | 'made';
}

const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v == null ? 0 : Number(v);

/**
 * One physical piece of a design, as the counter needs it: the actual tagged
 * price and the tracking identifiers (the Gati JewelId is the tag/batch number,
 * plus hallmark + certificate). Landed COST is deliberately omitted — that is
 * gated to area_manager+ (Module 15) and never belongs on a shared catalogue view.
 */
export interface StockPieceView {
  id: string;
  tagNo: string;
  storeId: string;
  storeName: string;
  status: string;
  grossWeight: number;
  netWeight: number;
  diamondWeightCt: number;
  diamondPieces: number;
  tagPrice: number;
  mrp: number;
  hallmarkNo: string;
  certificateNo: string;
  inwardDate: string | null;
  ageDays: number | null;
}

/**
 * Where a design came from, as a salesperson would say it.
 *
 * Not stored: it follows from the provenance columns sync already writes —
 * Gati designs carry their StyleId in `legacyId`, website-only designs a
 * `WEB-` marker, and a Gati design that is also on the website a `websiteCode`.
 */
export type ProductSource = 'gati' | 'website' | 'gati_website' | 'import' | 'manual';

function sourceOf(p: { legacyId?: string | null; websiteCode?: string | null; importBatchId?: string | null }): ProductSource {
  if (p.legacyId?.startsWith('WEB-')) return 'website';
  if (p.legacyId) return p.websiteCode ? 'gati_website' : 'gati';
  if (p.importBatchId) return 'import';
  return 'manual';
}

/**
 * The lightweight catalogue-card additions (docs/modules/05-catalogue-sources.md,
 * "Product API"). Computed for a whole page in a handful of batch queries —
 * see ProductsService.cardExtras.
 */
export interface CardExtras {
  /** listing.marketingName ?? product.name. */
  displayName: string;
  heroImageUrl: string | null;
  heroThumbUrl: string | null;
  /** gati_cad | website | manual | inventory | other, or null for a legacy imageUrl-only cover. */
  heroSource: string | null;
  onlinePrice: { min: number | null; max: number | null; indicative: number | null } | null;
  tagPrice: { min: number; max: number } | null;
  onHand: number;
  flags: {
    noImage: boolean;
    noCad: boolean;
    /** Open CatalogueConflict rows for this design. */
    conflicts: number;
    indexing: 'none' | 'partial' | 'full';
  };
}

/** Online selling prices (website). Range over the variants; indicative on its own. */
const ONLINE_RANGE_KINDS = ['variant', 'min_variant', 'natural_diamond'];
/** Gati tag price rows (one, or a store min & max pair). */
const isTagKind = (k: string) => k.startsWith('gati_tag');

const PRICE_LABELS: Record<string, string> = {
  indicative: 'Indicative online price',
  min_variant: 'Lowest variant price (website)',
  natural_diamond: 'Natural diamond price (website)',
  variant: 'Variant price (website)',
  variant_with_margin: 'Variant price with margin (website)',
  gati_tag: 'Tag price (Gati)',
  gati_tag_min: 'Lowest tag price (Gati)',
  gati_tag_max: 'Highest tag price (Gati)',
};

function toView(p: any, presence?: StockPresence, amounts = false, extras?: CardExtras) {
  const source = sourceOf(p);
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    ...(extras ?? {}),
    /**
     * The style number to show and to search by. Gati puts its StyleCode in
     * `name` and never fills `styleNumber`, so for a Gati design the name IS
     * the style number.
     */
    styleNumber: p.styleNumber ?? (source === 'gati' || source === 'gati_website' ? p.name : null),
    /** Gati StyleId, or null. The `WEB-` marker is provenance, not an id anyone quotes. */
    gatiId: p.legacyId && !p.legacyId.startsWith('WEB-') ? p.legacyId : null,
    websiteCode: p.websiteCode ?? null,
    source,
    category: p.category,
    categoryLabel: p.categoryLabel ?? undefined,
    metal: p.metal,
    materialLabel: p.materialLabel ?? undefined,
    karat: p.karat,
    weightGrams: Number(p.weightGrams),
    weightKnown: p.weightKnown ?? true,
    caratWeight: Number(p.caratWeight),
    price: Number(p.price),
    priceKnown: p.priceKnown ?? true,
    unitOfMeasure: p.unitOfMeasure ?? undefined,
    availability: p.availability,
    /** Block 9 — standard / customised / non_stock. */
    stockClass: p.stockClass,
    leadTimeDays: p.leadTimeDays ?? undefined,
    storeId: p.storeId ?? '',
    description: p.description ?? '',
    imageUrl: p.imageUrl ?? undefined,
    // The whole gallery when it was joined in; absent (not empty) when it was
    // not, so a caller can tell "no photos" from "did not ask".
    ...(p.images
      ? {
          images: (p.images as any[]).map((i) => ({
            id: i.id,
            url: i.url,
            thumbUrl: i.thumbUrl ?? null,
            source: i.source,
            angle: i.angle ?? undefined,
            isPrimary: i.isPrimary,
            pinned: i.pinnedPrimary ?? false,
            sortOrder: i.sortOrder,
          })),
        }
      : {}),
    bestSeller: p.bestSeller,
    // Tenant-defined attributes. Previously dropped here, which made every
    // configured custom field invisible in the app no matter what an admin set
    // up — the configuration screen wrote definitions nothing ever read.
    attributes: (p.attributes ?? null) as Record<string, unknown> | null,
    /** Metal, diamonds, stones, making — amounts only for store managers and up. */
    composition: forViewer(p.composition, amounts),
    ...(presence ? { stock: presence } : {}),
  };
}

/** Rates, amounts and making charges reveal margin: store managers and up. */
const seesAmounts = (user: AuthUser) => ROLE_RANK[user.role] >= ROLE_RANK.store_manager;

export interface ProductFilters {
  /** Free text: style number, SKU, name, Gati id, website code or marketing name. */
  q?: string;
  /** A ProductCategory value, or a website listing category ("Rings"). */
  category?: string;
  /** Website listing sub-category. */
  subCategory?: string;
  /** A size option ("IND 12") or a Gati piece size label. */
  size?: string;
  karat?: number;
  /** Variant colour / metal type, or the colour group of a photo. */
  colour?: string;
  metal?: MetalKind;
  /** Any online or tag price of the design falls in [priceMin, priceMax]. */
  priceMin?: number;
  priceMax?: number;
  storeId?: string;
  availability?: Availability;
  source?: ProductSource;
  imageCoverage?: 'none' | 'no_cad' | 'unindexed' | 'indexed';
}

const SOURCES: ProductSource[] = ['gati', 'website', 'gati_website', 'import', 'manual'];
const COVERAGES = ['none', 'no_cad', 'unindexed', 'indexed'] as const;

/**
 * The list's query params, validated. Individual params rather than a query
 * DTO for the reason given on parsePagination: the global pipe forbids unknown
 * fields, and this endpoint has always ignored stray params.
 */
export function parseProductFilters(raw: Record<string, unknown>): ProductFilters {
  const str = (k: string, max = 80) => {
    const r = raw[k];
    if (r !== undefined && typeof r !== 'string') throw new BadRequestException(`${k} must be given once`);
    const v = r?.trim();
    return v ? v.slice(0, max) : undefined;
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
    const v = str(k);
    if (v === undefined) return undefined;
    if (!allowed.includes(v as T)) throw new BadRequestException(`${k} must be one of: ${allowed.join(', ')}`);
    return v as T;
  };
  const number = (k: string, integer = false) => {
    const v = str(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
      throw new BadRequestException(`${k} must be a non-negative ${integer ? 'integer' : 'number'}`);
    }
    return n;
  };
  return {
    q: str('q', 64),
    category: str('category'),
    subCategory: str('subCategory'),
    size: str('size'),
    karat: number('karat', true),
    colour: str('colour'),
    metal: oneOf('metal', Object.values(MetalKind)),
    priceMin: number('priceMin'),
    priceMax: number('priceMax'),
    storeId: str('storeId'),
    availability: oneOf('availability', Object.values(Availability)),
    source: oneOf('source', SOURCES),
    imageCoverage: oneOf('imageCoverage', COVERAGES),
  };
}

/** Decimal → number, keeping null as null (unlike `num`, which reads null as 0). */
const dec = (v: Prisma.Decimal | number | null | undefined): number | null => (v == null ? null : Number(v));

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly index: CatalogueIndexService,
  ) {}

  /**
   * A product this user may see, or 404. Another organisation's design, and a
   * store-owned design from a branch outside the user's scope, are both simply
   * "not found" — never a 403 that confirms the id exists.
   */
  private async visibleProduct(user: AuthUser, id: string) {
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p || p.organisationId !== user.organisationId) throw new NotFoundException('Product not found');
    if (p.storeId && !user.storeIds.includes(p.storeId)) throw new NotFoundException('Product not found');
    return p;
  }

  /**
   * The catalogue-card additions for a page of designs, in five batch queries
   * whatever the page size — never one query per design.
   */
  private async cardExtras(
    organisationId: string,
    rows: { id: string; name: string; imageUrl: string | null }[],
    presence: Map<string, StockPresence>,
  ): Promise<Map<string, CardExtras>> {
    const out = new Map<string, CardExtras>();
    if (!rows.length) return out;
    const ids = rows.map((r) => r.id);
    const [listings, heroes, imageCounts, prices, conflicts] = await Promise.all([
      this.prisma.productWebsiteListing.findMany({
        where: { productId: { in: ids } },
        select: { productId: true, marketingName: true },
      }),
      this.prisma.productImage.findMany({
        where: { productId: { in: ids }, isPrimary: true, status: 'active' },
        select: { productId: true, url: true, thumbUrl: true, source: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.productImage.groupBy({
        by: ['productId', 'source', 'embeddingStatus'],
        where: { productId: { in: ids }, status: 'active' },
        _count: { _all: true },
      }),
      this.prisma.productPrice.findMany({
        where: { productId: { in: ids } },
        select: { productId: true, kind: true, amount: true },
      }),
      this.prisma.catalogueConflict.groupBy({
        by: ['productId'],
        where: { organisationId, productId: { in: ids }, status: 'open' },
        _count: { _all: true },
      }),
    ]);

    const nameOf = new Map(listings.map((l) => [l.productId, l.marketingName]));
    const heroOf = new Map<string, (typeof heroes)[number]>();
    for (const h of heroes) if (!heroOf.has(h.productId)) heroOf.set(h.productId, h);
    const conflictsOf = new Map(conflicts.map((c) => [c.productId, c._count._all]));
    const byProduct = <T extends { productId: string }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) m.set(x.productId, [...(m.get(x.productId) ?? []), x]);
      return m;
    };
    const imagesOf = byProduct(imageCounts);
    const pricesOf = byProduct(prices);

    for (const r of rows) {
      const imgs = imagesOf.get(r.id) ?? [];
      const total = imgs.reduce((n, c) => n + c._count._all, 0);
      const indexed = imgs
        .filter((c) => c.embeddingStatus === 'indexed')
        .reduce((n, c) => n + c._count._all, 0);
      const mine = pricesOf.get(r.id) ?? [];
      const range = (ps: typeof mine) => ps.map((p) => Number(p.amount));
      const online = range(mine.filter((p) => ONLINE_RANGE_KINDS.includes(p.kind)));
      const indicative = mine.find((p) => p.kind === 'indicative');
      const tags = range(mine.filter((p) => isTagKind(p.kind)));
      const hero = heroOf.get(r.id);
      out.set(r.id, {
        displayName: nameOf.get(r.id) ?? r.name,
        heroImageUrl: hero?.url ?? r.imageUrl ?? null,
        heroThumbUrl: hero?.thumbUrl ?? null,
        heroSource: hero?.source ?? null,
        onlinePrice:
          online.length || indicative
            ? {
                min: online.length ? Math.min(...online) : null,
                max: online.length ? Math.max(...online) : null,
                indicative: indicative ? Number(indicative.amount) : null,
              }
            : null,
        tagPrice: tags.length ? { min: Math.min(...tags), max: Math.max(...tags) } : null,
        onHand: presence.get(r.id)?.totalCount ?? 0,
        flags: {
          noImage: total === 0 && !r.imageUrl,
          noCad: !imgs.some((c) => c.source === 'gati_cad'),
          conflicts: conflictsOf.get(r.id) ?? 0,
          indexing: indexed === 0 ? 'none' : indexed < total ? 'partial' : 'full',
        },
      });
    }
    return out;
  }

  /**
   * Stock presence for a page of designs, in ONE query.
   *
   * Deliberately a groupBy over the whole page rather than a count per product:
   * a catalogue grid shows 50 designs at a time, and the per-product version is
   * 50 round trips that get slower as the client's stock grows.
   *
   * `viewerStoreId` is the counter the person is standing at. When they are head
   * office looking at "all stores" there is no "here", so everything reads as
   * elsewhere — which is the honest answer for someone who is not at a counter.
   */
  private async stockPresence(
    productIds: string[],
    viewerStoreId: string | null,
    visibleStoreIds: string[] | null,
  ): Promise<Map<string, StockPresence>> {
    const result = new Map<string, StockPresence>();
    if (!productIds.length) return result;

    const rows = await this.prisma.stockItem.groupBy({
      by: ['productId', 'storeId'],
      where: {
        productId: { in: productIds },
        // Sold and returned pieces are not on the shelf; only countable stock is.
        status: { in: ['in_stock', 'aging', 'dead_stock'] },
        // And only merchandise. A ring made for one customer, or a display
        // sample, is on the shelf but is not something to offer the next person
        // — counting it is how a salesperson promises a piece that is spoken for.
        ...stockClassWhere('standard'),
        ...(visibleStoreIds ? { storeId: { in: visibleStoreIds } } : {}),
      },
      _count: { _all: true },
    });
    if (!rows.length) {
      for (const id of productIds) {
        result.set(id, { hereCount: 0, elsewhere: [], totalCount: 0, where: 'made' });
      }
      return result;
    }

    // Name the branches once, so the answer is readable without another lookup.
    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(stores.map((s) => [s.id, s.name]));

    for (const id of productIds) {
      const mine = rows.filter((r) => r.productId === id);
      const hereCount = viewerStoreId
        ? mine.find((r) => r.storeId === viewerStoreId)?._count._all ?? 0
        : 0;
      const elsewhere = mine
        .filter((r) => r.storeId !== viewerStoreId)
        .map((r) => ({
          storeId: r.storeId,
          storeName: nameOf.get(r.storeId) ?? r.storeId,
          count: r._count._all,
        }))
        .sort((a, b) => b.count - a.count);
      const totalCount = mine.reduce((n, r) => n + r._count._all, 0);
      result.set(id, {
        hereCount,
        elsewhere,
        totalCount,
        where: hereCount > 0 ? 'here' : elsewhere.length ? 'elsewhere' : 'made',
      });
    }
    return result;
  }

  /** The stores whose stock this user is allowed to see at all. */
  private visibleStoreIds(user: AuthUser): string[] | null {
    return user.allStores ? null : user.storeIds;
  }

  /** Every narrowing the list supports, as one AND of Prisma filters. */
  private filterWhere(f: ProductFilters): Prisma.ProductWhereInput[] {
    const and: Prisma.ProductWhereInput[] = [];
    const ci = (v: string) => ({ equals: v, mode: 'insensitive' as const });
    if (f.metal) and.push({ metal: f.metal });
    if (f.availability) and.push({ availability: f.availability });
    // A salesperson with a customer asking about "SK-010225-A" types the code.
    // Every identifier a design can be quoted by, because Gati keeps its style
    // code in `name` and the website its code in `websiteCode` — a search over
    // `styleNumber` alone would find none of them.
    if (f.q) {
      const has = { contains: f.q, mode: 'insensitive' as const };
      and.push({
        OR: [
          { name: has },
          { sku: has },
          { styleNumber: has },
          { legacyId: has },
          { websiteCode: has },
          { websiteListing: { marketingName: has } },
        ],
      });
    }
    if (f.category) {
      const isEnum = (Object.values(ProductCategory) as string[]).includes(f.category);
      and.push({
        OR: [
          ...(isEnum ? [{ category: f.category as ProductCategory }] : []),
          { websiteListing: { categories: { has: f.category } } },
        ],
      });
    }
    if (f.subCategory) and.push({ websiteListing: { subCategories: { has: f.subCategory } } });
    if (f.size) {
      and.push({
        OR: [
          { options: { some: { kind: 'size', value: ci(f.size), tombstonedAt: null } } },
          { stockItems: { some: { sizeLabel: ci(f.size) } } },
        ],
      });
    }
    if (f.karat != null) {
      and.push({ OR: [{ karat: f.karat }, { variants: { some: { karat: f.karat, status: 'active' } } }] });
    }
    if (f.colour) {
      const has = { contains: f.colour, mode: 'insensitive' as const };
      and.push({
        OR: [
          { variants: { some: { status: 'active', OR: [{ colour: has }, { metalType: has }] } } },
          {
            images: {
              some: { status: 'active', associations: { some: { colour: has, tombstonedAt: null } } },
            },
          },
        ],
      });
    }
    if (f.priceMin != null || f.priceMax != null) {
      const amount = {
        ...(f.priceMin != null ? { gte: new Prisma.Decimal(f.priceMin) } : {}),
        ...(f.priceMax != null ? { lte: new Prisma.Decimal(f.priceMax) } : {}),
      };
      // "Can it be had within the budget": any online price or tag price of the
      // design in range. Product.price is the Gati tag basis when no tag rows exist.
      and.push({
        OR: [
          {
            prices: {
              some: {
                amount,
                OR: [{ kind: { in: [...ONLINE_RANGE_KINDS, 'indicative'] } }, { kind: { startsWith: 'gati_tag' } }],
              },
            },
          },
          { priceKnown: true, price: { ...amount, gt: 0 } },
        ],
      });
    }
    if (f.source) {
      const gati: Prisma.ProductWhereInput = { legacyId: { not: null }, NOT: { legacyId: { startsWith: 'WEB-' } } };
      const bySource: Record<ProductSource, Prisma.ProductWhereInput> = {
        website: { legacyId: { startsWith: 'WEB-' } },
        gati: { ...gati, websiteCode: null },
        gati_website: { ...gati, websiteCode: { not: null } },
        import: { legacyId: null, importBatchId: { not: null } },
        manual: { legacyId: null, importBatchId: null },
      };
      and.push(bySource[f.source]);
    }
    if (f.imageCoverage) {
      const byCoverage: Record<NonNullable<ProductFilters['imageCoverage']>, Prisma.ProductWhereInput> = {
        none: { imageUrl: null, images: { none: { status: 'active' } } },
        no_cad: { images: { none: { status: 'active', source: 'gati_cad' } } },
        // Has pictures, none of them searchable yet.
        unindexed: {
          images: { some: { status: 'active' }, none: { status: 'active', embeddingStatus: 'indexed' } },
        },
        indexed: { images: { some: { status: 'active', embeddingStatus: 'indexed' } } },
      };
      and.push(byCoverage[f.imageCoverage]);
    }
    return and;
  }

  async list(
    user: AuthUser,
    f: ProductFilters,
    headerStore?: string,
    pagination?: PageRequest,
  ): Promise<ReturnType<typeof toView>[] | Paginated<ReturnType<typeof toView>>> {
    const and = this.filterWhere(f);
    const q = f.q;

    // Within the org, scope to the user's stores (+ global products with no store).
    const requested = f.storeId ?? headerStore;
    if (requested && requested !== 'all') {
      this.scope.assertStoreAllowed(user, requested);
      and.push({ OR: [{ storeId: requested }, { storeId: null }] });
    } else if (!user.allStores) {
      and.push({ OR: [{ storeId: { in: user.storeIds } }, { storeId: null }] });
    }
    // ORGANISATION boundary first — the catalogue is company-wide WITHIN an org,
    // never across organisations. Applied to both count and findMany below.
    const where: Prisma.ProductWhereInput = { organisationId: user.organisationId, AND: and };

    // Designs with a photo first: a page of gem glyphs is what a customer sees
    // otherwise, since most Gati designs have no picture yet.
    const orderBy: Prisma.ProductOrderByWithRelationInput[] = [
      { imageUrl: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'desc' },
    ];

    // Which counter is this person standing at? "all" means none in particular.
    const viewerStore = requested && requested !== 'all' ? requested : null;
    const visible = this.visibleStoreIds(user);
    const view = async (rows: Prisma.ProductGetPayload<object>[]) => {
      const presence = await this.stockPresence(rows.map((p) => p.id), viewerStore, visible);
      const extras = await this.cardExtras(user.organisationId, rows, presence);
      return rows.map((p) => toView(p, presence.get(p.id), seesAmounts(user), extras.get(p.id)));
    };

    // No page/pageSize → legacy plain-array response (existing frontend shape).
    if (!pagination) {
      return view(await this.prisma.product.findMany({ where, orderBy }));
    }

    const { page, pageSize } = pagination;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    // The exact code first: typing "SK-010225-A" should put that design at the
    // top, ahead of "SK-010225-AB" and every other design that merely contains it.
    // ponytail: ranks within the page only; exact hits are few enough to land on page 1.
    const exact = (p: (typeof rows)[number]) =>
      q ? [p.name, p.sku, p.styleNumber, p.websiteCode].some((v) => v?.toLowerCase() === q.toLowerCase()) : false;
    if (q) rows.sort((a, b) => Number(exact(b)) - Number(exact(a)));
    return { items: await view(rows), total, page, pageSize };
  }

  async get(user: AuthUser, id: string, headerStore?: string) {
    await this.visibleProduct(user, id);
    const p = await this.prisma.product.findUniqueOrThrow({
      where: { id },
      // The detail view is where every angle of a design is looked at, so the
      // gallery is joined here and nowhere else — the grid needs one cover, not
      // N photos per tile.
      include: {
        images: {
          where: { status: 'active' },
          orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    const viewerStore = headerStore && headerStore !== 'all' ? headerStore : null;
    if (viewerStore) this.scope.assertStoreAllowed(user, viewerStore);
    const presence = await this.stockPresence([p.id], viewerStore, this.visibleStoreIds(user));
    const extras = await this.cardExtras(user.organisationId, [p], presence);
    return toView(p, presence.get(p.id), seesAmounts(user), extras.get(p.id));
  }

  /**
   * Everything known about one design, for the detail dialog — fetched only
   * when it opens (docs/modules/05-catalogue-sources.md, "Detail").
   *
   * THE COST BOUNDARY lives here: below store manager every margin, making
   * charge, BOM rate/amount, stock component amount and cost is removed before
   * the object leaves this method; `rawMaterialId` only reaches head office.
   */
  async full(user: AuthUser, id: string, headerStore?: string) {
    const tier = costTier(user.role);
    const base = await this.get(user, id, headerStore);
    const visible = this.visibleStoreIds(user);
    const [product, listing, variants, options, prices, images, conflicts, pieceRows] = await Promise.all([
      this.prisma.product.findUniqueOrThrow({
        where: { id },
        select: {
          legacyUpdatedAt: true,
          hsn: true,
          costPrice: true,
          createdAt: true,
          updatedAt: true,
          gatiSyncedAt: true,
          websiteSyncedAt: true,
          importBatchId: true,
        },
      }),
      this.prisma.productWebsiteListing.findUnique({ where: { productId: id } }),
      this.prisma.productVariant.findMany({
        where: { productId: id, status: 'active' },
        orderBy: [{ source: 'asc' }, { karat: 'asc' }, { sourceKey: 'asc' }],
      }),
      this.prisma.productOption.findMany({
        where: { productId: id, tombstonedAt: null },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.productPrice.findMany({
        where: { productId: id },
        orderBy: [{ kind: 'asc' }, { amount: 'asc' }],
      }),
      this.prisma.productImage.findMany({
        where: { productId: id, status: 'active' },
        include: { associations: { where: { tombstonedAt: null }, orderBy: { sourceOrder: 'asc' } } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.catalogueConflict.findMany({
        where: { organisationId: user.organisationId, productId: id, status: 'open' },
        orderBy: { lastSeenAt: 'desc' },
      }),
      this.prisma.stockItem.findMany({
        where: {
          productId: id,
          organisationId: user.organisationId,
          ...(visible ? { storeId: { in: visible } } : {}),
        },
        orderBy: [{ status: 'asc' }, { inwardDate: 'desc' }],
        // ponytail: a design rarely has more than a few dozen pieces; page this if one ever passes 1000.
        take: 1000,
      }),
    ]);

    const stores = await this.prisma.store.findMany({
      where: { id: { in: [...new Set([...pieceRows.map((r) => r.storeId), headerStore ?? ''])] } },
      select: { id: true, name: true },
    });
    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    const variantLabel = new Map(
      variants.map((v) => [
        v.id,
        [v.karat ? `${v.karat}K` : null, v.metalType, v.colour, v.diamondType].filter(Boolean).join(' · '),
      ]),
    );
    const amounts = tier !== 'none';
    const omit = <T extends object>(o: T, keys: readonly string[]): Partial<T> =>
      amounts ? o : (Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as Partial<T>);

    const stock = base.stock;
    return {
      ...base,
      identifiers: {
        gatiId: base.gatiId,
        sku: base.sku,
        styleNumber: base.styleNumber,
        websiteCode: base.websiteCode,
        externalId: listing?.externalId ?? null,
        websiteProductCode: listing?.productCode ?? null,
        hsn: product.hsn ?? null,
      },
      ...(amounts ? { costPrice: dec(product.costPrice) } : {}),
      listing: listing
        ? {
            marketingName: listing.marketingName,
            slug: listing.slug,
            categories: listing.categories,
            subCategories: listing.subCategories,
            features: listing.features,
            tags: listing.tags,
            countries: listing.countries,
            isActive: listing.isActive,
            isDeleted: listing.isDeleted,
            description: listing.description,
            sizeGuide: listing.sizeGuide,
            seo: listing.seo,
            tombstonedAt: listing.tombstonedAt,
          }
        : null,
      // Shown verbatim; disagreements with the BOM are in `conflicts`, never corrected here.
      specifications: listing?.specifications
        ? {
            text: listing.specifications,
            source: 'website',
            syncedAt: listing.sourceUpdatedAt ?? product.websiteSyncedAt,
          }
        : null,
      variants: variants.map((v) =>
        omit(
          {
            id: v.id,
            source: v.source,
            sourceKey: v.sourceKey,
            label: variantLabel.get(v.id) ?? '',
            sku: v.sku,
            metalType: v.metalType,
            karat: v.karat,
            metal: v.metal,
            diamondType: v.diamondType,
            colour: v.colour,
            weightType: v.weightType,
            goldWeight: dec(v.goldWeight),
            diamondWeight: dec(v.diamondWeight),
            stoneWeight: dec(v.stoneWeight),
            totalWeight: dec(v.totalWeight),
            price: dec(v.price),
            priceWithMargin: dec(v.priceWithMargin),
            marginPercentage: dec(v.marginPercentage),
            makingCharge: dec(v.makingCharge),
            currency: v.currency,
            bom: stripCostJson(v.bom, tier) ?? null,
            attributes: stripCostJson(v.attributes, tier) ?? null,
          },
          VARIANT_COST_FIELDS,
        ),
      ),
      sizes: options
        .filter((o) => o.kind === 'size')
        .map((o) => ({ value: o.value, source: o.source, sortOrder: o.sortOrder })),
      prices: prices
        .filter((p) => amounts || !COST_PRICE_KINDS.has(p.kind))
        .map((p) => ({
          id: p.id,
          source: p.source,
          kind: p.kind,
          label: PRICE_LABELS[p.kind] ?? p.kind,
          variantId: p.variantKey || null,
          variantLabel: p.variantKey ? (variantLabel.get(p.variantKey) ?? null) : null,
          amount: Number(p.amount),
          currency: p.currency,
          capturedAt: p.capturedAt,
        })),
      images: images.map((i) => {
        const first = i.associations[0];
        return {
          id: i.id,
          url: i.url,
          thumbUrl: i.thumbUrl,
          source: i.source,
          colour: first?.colour || null,
          angle: i.angle ?? first?.angle ?? null,
          shape: first?.shape || null,
          isPrimary: i.isPrimary,
          pinned: i.pinnedPrimary,
          sortOrder: i.sortOrder,
          width: i.width,
          height: i.height,
          embeddingStatus: i.embeddingStatus,
          associations: i.associations.map((a) => ({
            variantId: a.variantId,
            colour: a.colour || null,
            shape: a.shape || null,
            angle: a.angle,
            sourceOrder: a.sourceOrder,
          })),
        };
      }),
      /** On-hand (countable, standard) pieces per store in the viewer's scope. */
      availabilityByStore: [
        ...(stock?.hereCount && headerStore
          ? [{ storeId: headerStore, storeName: storeName.get(headerStore) ?? headerStore, count: stock.hereCount, here: true }]
          : []),
        ...(stock?.elsewhere ?? []).map((e) => ({ ...e, here: false })),
      ],
      pieces: pieceRows.map((r) =>
        omit(
          {
            id: r.id,
            // The Gati JewelId (stored as legacyId) is the piece's tag / batch number.
            tagNo: r.legacyId ?? r.sku ?? '',
            vin: r.vin,
            sku: r.sku,
            styleNumber: r.styleNumber,
            productCode: r.productCode,
            storeId: r.storeId,
            storeName: storeName.get(r.storeId) ?? r.storeId,
            status: r.status,
            stockClass: r.stockClass,
            variantId: r.variantId,
            metal: r.metal,
            karat: r.karat,
            sizeLabel: r.sizeLabel,
            itemSizeId: r.itemSizeId,
            hsn: r.hsn,
            huid: r.huid,
            hallmarkNo: r.hallmarkNo,
            certificateNo: r.certificateNo,
            quantity: r.quantity,
            grossWeight: dec(r.grossWeight),
            netWeight: dec(r.netWeight),
            pureWeight: dec(r.pureWeight),
            metalLossWeight: dec(r.metalLossWeight),
            diamondWeightCt: dec(r.diamondWeightCt),
            diamondPieces: r.diamondPieces,
            stoneWeightCt: dec(r.stoneWeightCt),
            stonePieces: r.stonePieces,
            tagPrice: dec(r.tagPrice),
            mrp: dec(r.mrp),
            metalAmount: dec(r.metalAmount),
            diamondAmount: dec(r.diamondAmount),
            stoneAmount: dec(r.stoneAmount),
            makingAmount: dec(r.makingAmount),
            cpfAmount: dec(r.cpfAmount),
            cost: dec(r.cost),
            imageUrl: r.imageUrl,
            inwardDate: r.inwardDate ? r.inwardDate.toISOString() : null,
            ageDays: r.ageDays,
          },
          STOCK_COST_FIELDS,
        ),
      ),
      provenance: {
        source: base.source,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        gatiSyncedAt: product.gatiSyncedAt,
        gatiUpdatedAt: product.legacyUpdatedAt,
        websiteSyncedAt: product.websiteSyncedAt,
        websiteSourceCreatedAt: listing?.sourceCreatedAt ?? null,
        websiteSourceUpdatedAt: listing?.sourceUpdatedAt ?? null,
        websiteLastSeenAt: listing?.lastSeenAt ?? null,
        importBatchId: product.importBatchId,
      },
      conflicts: conflicts.map((c) => ({
        id: c.id,
        kind: c.kind,
        summary: c.summary,
        detail: stripCostJson(c.detail, tier) ?? null,
        firstSeenAt: c.firstSeenAt,
        lastSeenAt: c.lastSeenAt,
      })),
    };
  }

  /**
   * The physical pieces of a design on hand in the viewer's scope, each with its
   * ACTUAL tagged price and tracking (tag/JewelId, hallmark, certificate) — the
   * real per-piece detail the design-level `price` cannot carry. Only countable
   * stock (in_stock / aging / dead_stock); sold and returned pieces are excluded.
   */
  async pieces(user: AuthUser, productId: string, headerStore?: string): Promise<StockPieceView[]> {
    await this.visibleProduct(user, productId);

    const requested = headerStore && headerStore !== 'all' ? headerStore : null;
    if (requested) this.scope.assertStoreAllowed(user, requested);
    const visible = this.visibleStoreIds(user);
    const storeFilter = requested
      ? { storeId: requested }
      : visible
        ? { storeId: { in: visible } }
        : {};

    const rows = await this.prisma.stockItem.findMany({
      where: {
        productId,
        status: { in: ['in_stock', 'aging', 'dead_stock'] },
        // The counter's list of what can be sold: the same set the "on the
        // shelf" count above is taken from, so the two cannot disagree.
        ...stockClassWhere('standard'),
        ...storeFilter,
      },
      orderBy: [{ inwardDate: 'desc' }],
      take: 200,
    });

    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    const stores = await this.prisma.store.findMany({
      where: { id: { in: storeIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(stores.map((s) => [s.id, s.name]));

    return rows.map((r) => ({
      id: r.id,
      // The Gati JewelId (stored as legacyId) is the piece's tag / batch number.
      tagNo: r.legacyId ?? r.sku ?? '',
      storeId: r.storeId,
      storeName: nameOf.get(r.storeId) ?? r.storeId,
      status: r.status,
      grossWeight: num(r.grossWeight),
      netWeight: num(r.netWeight),
      diamondWeightCt: num(r.diamondWeightCt),
      diamondPieces: r.diamondPieces ?? 0,
      tagPrice: num(r.tagPrice),
      mrp: num(r.mrp),
      hallmarkNo: r.hallmarkNo ?? '',
      certificateNo: r.certificateNo ?? '',
      inwardDate: r.inwardDate ? r.inwardDate.toISOString() : null,
      ageDays: r.ageDays ?? null,
    }));
  }

  /** Create a catalogue product. Managers and above (store-scoped if storeId given). */
  async create(user: AuthUser, dto: CreateProductDto) {
    if (dto.storeId) this.scope.assertStoreAllowed(user, dto.storeId);

    // SKU uniqueness is per-organisation — two tenants may each own SKU "R001".
    const existing = await this.prisma.product.findFirst({
      where: { sku: dto.sku, organisationId: user.organisationId },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`SKU "${dto.sku}" already exists`);

    const created = await this.prisma.product.create({
      data: {
        organisationId: user.organisationId,
        sku: dto.sku,
        name: dto.name,
        category: dto.category,
        metal: dto.metal,
        // The tenant's own words for a product whose typed columns had to fall
        // back to `other` / `unspecified`. Trimmed to null rather than stored as
        // an empty string, so "absent" has one representation.
        categoryLabel: dto.categoryLabel?.trim() || null,
        materialLabel: dto.materialLabel?.trim() || null,
        unitOfMeasure: dto.unitOfMeasure?.trim() || null,
        karat: dto.karat ?? 0,
        weightGrams:
          dto.weightGrams != null ? new Prisma.Decimal(dto.weightGrams) : undefined,
        caratWeight:
          dto.caratWeight != null ? new Prisma.Decimal(dto.caratWeight) : undefined,
        price: dto.price != null ? new Prisma.Decimal(dto.price) : undefined,
        availability: dto.availability ?? 'in_stock',
        leadTimeDays: dto.leadTimeDays,
        description: dto.description,
        storeId: dto.storeId,
        attributes: (dto.attributes ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return toView(created);
  }

  /**
   * Queue new pictures for visual-search indexing. The upload is already durable
   * here; a failure to queue leaves the picture `pending`, which the next
   * catalogue rebuild picks up — so it is logged, never thrown back at the counter.
   */
  private async queueIndex(organisationId: string, imageIds: string[]) {
    try {
      await this.index.enqueue(organisationId, imageIds);
    } catch (err) {
      this.logger.warn(`index enqueue failed for ${imageIds.length} image(s): ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * What to store for an uploaded photo, judged by its bytes rather than the
   * browser's label: a web format as it is; another raster sharp reads (TIFF,
   * AVIF) as a JPEG; and what it cannot — an iPhone HEIC picked outside
   * Safari — refused, since stored raw it would show only in Safari. SVG is
   * refused too (a document, not a photo), and decoding is capped at 100 MP so
   * one crafted file cannot take a gigabyte of memory.
   */
  private static async webImage(file: { buffer?: Buffer; originalname?: string }): Promise<{ buffer: Buffer; ext: string }> {
    const buffer = file.buffer!;
    const web = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>;
    const ext = web[sniffImageMime(buffer) ?? ''];
    if (ext) return { buffer, ext };
    try {
      const img = sharp(buffer, { limitInputPixels: 100_000_000 });
      if ((await img.metadata()).format === 'svg') throw new Error('svg');
      return { buffer: await img.rotate().jpeg({ quality: 88 }).toBuffer(), ext: 'jpg' };
    } catch {
      throw new BadRequestException(
        `${file.originalname || 'A photo'} is not a picture this system can read (an iPhone HEIC opened outside Safari, say). ` +
          'Upload it as JPEG or PNG — on the iPhone: Settings → Camera → Formats → Most Compatible.',
      );
    }
  }

  /**
   * Upload a product photo (legacy single-photo route, multipart `file`).
   *
   * The picture is added as a `manual` photo and the cover re-elected by the one
   * image-order rule (pin → Gati CAD → website → manual). A design with no CAD or
   * website photos therefore still gets this upload as its cover, as before.
   */
  async setImage(user: AuthUser, id: string, file?: { buffer?: Buffer; originalname?: string; mimetype?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('No image file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }
    // Org gate + store scope: another tenant's design is Not Found.
    const p = await this.visibleProduct(user, id);
    const photo = await ProductsService.webImage(file);
    const url = await this.storage.save(user.organisationId, 'products', `${id}-${Date.now()}.${photo.ext}`, photo.buffer);
    const img = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productImage.create({
        data: { organisationId: p.organisationId, productId: id, url, source: 'manual' },
      });
      await applyImageOrder(tx, id);
      return created;
    });
    await this.queueIndex(p.organisationId, [img.id]);
    return toView(await this.prisma.product.findUniqueOrThrow({ where: { id } }));
  }

  /**
   * Add one or more photographs of a design (multipart field `files`).
   *
   * Several at once because that is how the pictures arrive: a salesperson
   * stands at the counter with an iPad and takes the front, the side and one on
   * the hand in the same half minute. `angles` is positional and optional — an
   * unlabelled photo is still worth having and still gets indexed.
   *
   * The cover is re-elected by the image-order rule, so a design with no other
   * picture gets the first upload as its cover.
   */
  async addImages(
    user: AuthUser,
    id: string,
    files: { buffer?: Buffer; originalname?: string; mimetype?: string }[] | undefined,
    angles?: string[],
  ) {
    if (!files?.length) throw new BadRequestException('No image files uploaded');
    const p = await this.visibleProduct(user, id);

    for (const file of files) {
      if (!file?.buffer?.length) throw new BadRequestException('One of the uploads was empty');
      if (file.mimetype && !file.mimetype.startsWith('image/')) {
        throw new BadRequestException('One of the uploads is not an image');
      }
    }

    // Every photo is readable before any is stored: a batch is all or nothing.
    const photos = await Promise.all(files.map((f) => ProductsService.webImage(f)));
    const existing = await this.prisma.productImage.count({ where: { productId: id, source: 'manual' } });
    const urls: string[] = [];
    for (const [i, photo] of photos.entries()) {
      // A unique name per photo: `${id}.${ext}` would have each angle overwrite
      // the last, which is precisely the bug this whole table exists to end.
      urls.push(await this.storage.save(user.organisationId, 'products', `${id}-${Date.now()}-${i}.${photo.ext}`, photo.buffer));
    }
    const ids = await this.prisma.$transaction(async (tx) => {
      const out: string[] = [];
      for (const [i, url] of urls.entries()) {
        const img = await tx.productImage.create({
          data: {
            organisationId: p.organisationId,
            productId: id,
            url,
            source: 'manual',
            angle: angles?.[i]?.trim() || null,
            // Keeps the batch in the order it was taken, after earlier uploads.
            sourceOrder: existing + i,
          },
        });
        out.push(img.id);
      }
      await applyImageOrder(tx, id);
      return out;
    });
    await this.queueIndex(p.organisationId, ids);
    return this.listImages(user, id);
  }

  /** Every active photograph of a design, cover first then in display order. */
  async listImages(user: AuthUser, id: string) {
    await this.visibleProduct(user, id);
    const rows = await this.prisma.productImage.findMany({
      where: { productId: id, status: 'active' },
      orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((i) => ({
      id: i.id,
      url: i.url,
      thumbUrl: i.thumbUrl,
      source: i.source,
      angle: i.angle ?? undefined,
      isPrimary: i.isPrimary,
      pinned: i.pinnedPrimary,
      sortOrder: i.sortOrder,
      embeddingStatus: i.embeddingStatus,
    }));
  }

  /** An active picture of a design the user can see, or 404. */
  private async visibleImage(user: AuthUser, id: string, imageId: string) {
    await this.visibleProduct(user, id);
    const img = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId: id, organisationId: user.organisationId, status: 'active' },
    });
    if (!img) throw new NotFoundException('Photo not found on this design');
    return img;
  }

  /**
   * Pin one photo as the design's cover — an explicit choice that outranks the
   * CAD-first default and survives every later sync. Clears any other pin.
   */
  async setPrimaryImage(user: AuthUser, id: string, imageId: string) {
    await this.visibleImage(user, id, imageId);
    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.updateMany({ where: { productId: id, pinnedPrimary: true }, data: { pinnedPrimary: false } });
      await tx.productImage.update({ where: { id: imageId }, data: { pinnedPrimary: true } });
      await applyImageOrder(tx, id);
    });
    return this.listImages(user, id);
  }

  /** Remove the pin; the cover goes back to the default (CAD first) order. */
  async unpinPrimaryImage(user: AuthUser, id: string, imageId: string) {
    await this.visibleImage(user, id, imageId);
    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.update({ where: { id: imageId }, data: { pinnedPrimary: false } });
      await applyImageOrder(tx, id);
    });
    return this.listImages(user, id);
  }

  /**
   * Remove a photograph. A manual/inventory photo is deleted; a synced one
   * (website, Gati CAD) is tombstoned instead, so the next sync does not quietly
   * bring it back. Either way its vectors go at once — a stale vector keeps the
   * design matching searches for a picture that is gone — and the cover is
   * re-elected.
   */
  async deleteImage(user: AuthUser, id: string, imageId: string) {
    const img = await this.visibleImage(user, id, imageId);
    await this.prisma.$transaction(async (tx) => {
      await tx.productEmbedding.deleteMany({ where: { productImageId: imageId } });
      if (img.source === 'website' || img.source === 'gati_cad') {
        await tx.productImage.update({
          where: { id: imageId },
          data: { status: 'tombstoned', tombstonedAt: new Date(), pinnedPrimary: false },
        });
      } else {
        await tx.productImage.delete({ where: { id: imageId } });
      }
      await applyImageOrder(tx, id);
    });
    return this.listImages(user, id);
  }
}
