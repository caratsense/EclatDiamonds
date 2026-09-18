import {
  BadRequestException,
  ConflictException,
  Injectable,
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

function toView(p: any, presence?: StockPresence, amounts = false) {
  const source = sourceOf(p);
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
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
            angle: i.angle ?? undefined,
            isPrimary: i.isPrimary,
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
  /** Free text: style number, SKU, name, Gati id or website code. */
  q?: string;
  category?: ProductCategory;
  metal?: MetalKind;
  storeId?: string;
  availability?: Availability;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
  ) {}

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

  async list(
    user: AuthUser,
    f: ProductFilters,
    headerStore?: string,
    pagination?: PageRequest,
  ): Promise<ReturnType<typeof toView>[] | Paginated<ReturnType<typeof toView>>> {
    // ORGANISATION boundary first — the catalogue is company-wide WITHIN an org,
    // never across organisations. Applied to both count and findMany below.
    const where: Prisma.ProductWhereInput = { organisationId: user.organisationId };
    if (f.category) where.category = f.category;
    if (f.metal) where.metal = f.metal;
    if (f.availability) where.availability = f.availability;
    // A salesperson with a customer asking about "SK-010225-A" types the code.
    // Every identifier a design can be quoted by, because Gati keeps its style
    // code in `name` and the website its code in `websiteCode` — a search over
    // `styleNumber` alone would find none of them.
    const q = f.q?.trim().slice(0, 64);
    if (q) {
      const has = { contains: q, mode: 'insensitive' as const };
      where.AND = [
        {
          OR: [
            { name: has },
            { sku: has },
            { styleNumber: has },
            { legacyId: has },
            { websiteCode: has },
          ],
        },
      ];
    }

    // Within the org, scope to the user's stores (+ global products with no store).
    const requested = f.storeId ?? headerStore;
    if (requested && requested !== 'all') {
      this.scope.assertStoreAllowed(user, requested);
      where.OR = [{ storeId: requested }, { storeId: null }];
    } else if (!user.allStores) {
      where.OR = [{ storeId: { in: user.storeIds } }, { storeId: null }];
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: 'desc' };

    // Which counter is this person standing at? "all" means none in particular.
    const viewerStore = requested && requested !== 'all' ? requested : null;
    const visible = this.visibleStoreIds(user);

    // No page/pageSize → legacy plain-array response (existing frontend shape).
    if (!pagination) {
      const products = await this.prisma.product.findMany({ where, orderBy });
      const presence = await this.stockPresence(
        products.map((p) => p.id),
        viewerStore,
        visible,
      );
      return products.map((p) => toView(p, presence.get(p.id), seesAmounts(user)));
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
    const presence = await this.stockPresence(rows.map((p) => p.id), viewerStore, visible);
    // The exact code first: typing "SK-010225-A" should put that design at the
    // top, ahead of "SK-010225-AB" and every other design that merely contains it.
    // ponytail: ranks within the page only; exact hits are few enough to land on page 1.
    const exact = (p: (typeof rows)[number]) =>
      q ? [p.name, p.sku, p.styleNumber, p.websiteCode].some((v) => v?.toLowerCase() === q.toLowerCase()) : false;
    if (q) rows.sort((a, b) => Number(exact(b)) - Number(exact(a)));
    return {
      items: rows.map((p) => toView(p, presence.get(p.id), seesAmounts(user))),
      total,
      page,
      pageSize,
    };
  }

  async get(user: AuthUser, id: string, headerStore?: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      // The detail view is where every angle of a design is looked at, so the
      // gallery is joined here and nowhere else — the grid needs one cover, not
      // N photos per tile.
      include: {
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!p) throw new NotFoundException('Product not found');
    // Organisation boundary: a product from another org is Not Found to this user.
    if (p.organisationId !== user.organisationId) throw new NotFoundException('Product not found');
    const viewerStore = headerStore && headerStore !== 'all' ? headerStore : null;
    if (viewerStore) this.scope.assertStoreAllowed(user, viewerStore);
    const presence = await this.stockPresence([p.id], viewerStore, this.visibleStoreIds(user));
    return toView(p, presence.get(p.id), seesAmounts(user));
  }

  /**
   * The physical pieces of a design on hand in the viewer's scope, each with its
   * ACTUAL tagged price and tracking (tag/JewelId, hallmark, certificate) — the
   * real per-piece detail the design-level `price` cannot carry. Only countable
   * stock (in_stock / aging / dead_stock); sold and returned pieces are excluded.
   */
  async pieces(user: AuthUser, productId: string, headerStore?: string): Promise<StockPieceView[]> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, organisationId: true },
    });
    if (product && product.organisationId !== user.organisationId) {
      throw new NotFoundException('Product not found');
    }
    if (!product) throw new NotFoundException('Product not found');

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

  /** Upload/replace a product photo. Stored in object storage; DB keeps the URL. */
  async setImage(user: AuthUser, id: string, file?: { buffer?: Buffer; originalname?: string; mimetype?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('No image file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Product not found');
    // Org gate first: the store check below misses null-store (company-wide)
    // products, so without this a product from another tenant could be overwritten.
    if (p.organisationId !== user.organisationId) throw new NotFoundException('Product not found');
    // A store-scoped product can only be edited by someone with that store in scope.
    if (p.storeId) this.scope.assertStoreAllowed(user, p.storeId);

    const ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const imageUrl = await this.storage.save(user.organisationId, 'products', `${id}.${ext}`, file.buffer);
    const updated = await this.prisma.product.update({ where: { id }, data: { imageUrl } });
    // Keep the gallery in step: replacing the cover through the old
    // single-photo route must not leave the gallery showing the picture that
    // is no longer the cover.
    await this.prisma.$transaction([
      this.prisma.productImage.updateMany({
        where: { productId: id, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.productImage.create({
        data: {
          organisationId: p.organisationId,
          productId: id,
          url: imageUrl,
          isPrimary: true,
          sortOrder: 0,
        },
      }),
    ]);
    return toView(updated);
  }

  /** The product, with the caller proven to be allowed to change its photos. */
  private async assertEditableProduct(user: AuthUser, id: string) {
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p || p.organisationId !== user.organisationId) throw new NotFoundException('Product not found');
    if (p.storeId) this.scope.assertStoreAllowed(user, p.storeId);
    return p;
  }

  /**
   * Add one or more photographs of a design (multipart field `files`).
   *
   * Several at once because that is how the pictures arrive: a salesperson
   * stands at the counter with an iPad and takes the front, the side and one on
   * the hand in the same half minute. `angles` is positional and optional — an
   * unlabelled photo is still worth having and still gets indexed.
   *
   * The first photo of a design with no cover becomes the cover, so a design
   * never ends up with a gallery and an empty grid tile.
   */
  async addImages(
    user: AuthUser,
    id: string,
    files: { buffer?: Buffer; originalname?: string; mimetype?: string }[] | undefined,
    angles?: string[],
  ) {
    if (!files?.length) throw new BadRequestException('No image files uploaded');
    const p = await this.assertEditableProduct(user, id);

    for (const file of files) {
      if (!file?.buffer?.length) throw new BadRequestException('One of the uploads was empty');
      if (file.mimetype && !file.mimetype.startsWith('image/')) {
        throw new BadRequestException('One of the uploads is not an image');
      }
    }

    const existing = await this.prisma.productImage.count({ where: { productId: id } });
    const hasCover = Boolean(p.imageUrl) || existing > 0;

    const created: { url: string; isPrimary: boolean }[] = [];
    for (const [i, file] of files.entries()) {
      const ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      // A unique name per photo: `${id}.${ext}` would have each angle overwrite
      // the last, which is precisely the bug this whole table exists to end.
      const url = await this.storage.save(
        user.organisationId,
        'products',
        `${id}-${Date.now()}-${i}.${ext}`,
        file.buffer!,
      );
      const isPrimary = !hasCover && i === 0;
      await this.prisma.productImage.create({
        data: {
          organisationId: p.organisationId,
          productId: id,
          url,
          angle: angles?.[i]?.trim() || null,
          isPrimary,
          sortOrder: existing + i,
        },
      });
      created.push({ url, isPrimary });
    }

    const cover = created.find((c) => c.isPrimary);
    if (cover) {
      await this.prisma.product.update({ where: { id }, data: { imageUrl: cover.url } });
    }
    return this.listImages(user, id);
  }

  /** Every photograph of a design, cover first then in display order. */
  async listImages(user: AuthUser, id: string) {
    await this.assertEditableProduct(user, id);
    const rows = await this.prisma.productImage.findMany({
      where: { productId: id },
      orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((i) => ({
      id: i.id,
      url: i.url,
      angle: i.angle ?? undefined,
      isPrimary: i.isPrimary,
      sortOrder: i.sortOrder,
    }));
  }

  /** Promote one photo to the cover, demoting whichever held it. */
  async setPrimaryImage(user: AuthUser, id: string, imageId: string) {
    await this.assertEditableProduct(user, id);
    const img = await this.prisma.productImage.findFirst({ where: { id: imageId, productId: id } });
    if (!img) throw new NotFoundException('Photo not found on this design');

    await this.prisma.$transaction([
      this.prisma.productImage.updateMany({
        where: { productId: id, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.productImage.update({ where: { id: imageId }, data: { isPrimary: true } }),
      this.prisma.product.update({ where: { id }, data: { imageUrl: img.url } }),
    ]);
    return this.listImages(user, id);
  }

  /**
   * Remove a photograph. Deleting the cover promotes the next one rather than
   * leaving the design with a gallery and a blank tile; deleting the last photo
   * clears the cover honestly.
   */
  async deleteImage(user: AuthUser, id: string, imageId: string) {
    await this.assertEditableProduct(user, id);
    const img = await this.prisma.productImage.findFirst({ where: { id: imageId, productId: id } });
    if (!img) throw new NotFoundException('Photo not found on this design');

    await this.prisma.productImage.delete({ where: { id: imageId } });
    if (img.isPrimary) {
      const next = await this.prisma.productImage.findFirst({
        where: { productId: id },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      if (next) {
        await this.prisma.$transaction([
          this.prisma.productImage.update({ where: { id: next.id }, data: { isPrimary: true } }),
          this.prisma.product.update({ where: { id }, data: { imageUrl: next.url } }),
        ]);
      } else {
        await this.prisma.product.update({ where: { id }, data: { imageUrl: null } });
      }
    }
    return this.listImages(user, id);
  }
}
