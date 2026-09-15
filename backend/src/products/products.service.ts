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

function toView(p: any, presence?: StockPresence) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
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
    bestSeller: p.bestSeller,
    // Tenant-defined attributes. Previously dropped here, which made every
    // configured custom field invisible in the app no matter what an admin set
    // up — the configuration screen wrote definitions nothing ever read.
    attributes: (p.attributes ?? null) as Record<string, unknown> | null,
    ...(presence ? { stock: presence } : {}),
  };
}

export interface ProductFilters {
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
      return products.map((p) => toView(p, presence.get(p.id)));
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
    return {
      items: rows.map((p) => toView(p, presence.get(p.id))),
      total,
      page,
      pageSize,
    };
  }

  async get(user: AuthUser, id: string, headerStore?: string) {
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Product not found');
    // Organisation boundary: a product from another org is Not Found to this user.
    if (p.organisationId !== user.organisationId) throw new NotFoundException('Product not found');
    const viewerStore = headerStore && headerStore !== 'all' ? headerStore : null;
    if (viewerStore) this.scope.assertStoreAllowed(user, viewerStore);
    const presence = await this.stockPresence([p.id], viewerStore, this.visibleStoreIds(user));
    return toView(p, presence.get(p.id));
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
    return toView(updated);
  }
}
