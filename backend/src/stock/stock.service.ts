import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockStatus, MetalKind, ProductCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { GoldRateService } from '../integrations/gold-rate.service';
import { DeadStockService } from './dead-stock.service';
import { effectiveStockClass } from './stock-class';
import { PageRequest, Paginated } from '../common/pagination';
import {
  ADJUST_REASON_TO_STATUS,
  BulkAdjustStockDto,
  BulkImportStockDto,
  CreateStockDto,
  UpdateStockDto,
} from './dto/stock.dto';

/** A live stock transfer that has reserved a piece — it may not be hand-adjusted. */
const ACTIVE_TRANSFER_STATUSES = ['ho_approved', 'dispatched'] as const;

const DAY_MS = 86_400_000;

/**
 * The dead-stock threshold now comes from `DeadStockService`, per tenant and per
 * category. The platform default lives there as DEFAULT_DEAD_STOCK_DAYS, so
 * there is one definition rather than a constant here and another on the
 * frontend quietly disagreeing with it.
 */

/** The four statuses that stay in the ledger view (sold/melted/transferred drop out). */
const LEDGER_STATUSES: StockStatus[] = ['in_stock', 'aging', 'dead_stock', 'reserved'];

/** Metals whose gross weight counts toward the "total gold weight" KPI. */
const GOLD_METALS = new Set<MetalKind>([
  'gold_24k',
  'gold_22k',
  'gold_18k',
  'gold_14k',
  'gold_10k',
  'gold_9k',
  'rose_gold_18k',
  'gold_unspecified',
]);

/** Optional server-side filters for the stock ledger (search + facet dropdowns). */
export interface StockFilters {
  q?: string;
  category?: ProductCategory;
  metal?: MetalKind;
  status?: StockStatus;
  storeId?: string;
  ageBucket?: string;
  /** Every piece of one design. Exact, not a search. */
  styleNumber?: string;
}

/** Age-bucket key → inward-days range (matches the frontend age filter + aging chart). */
const AGE_BUCKET_RANGES: Record<string, { minDays?: number; maxDays?: number }> = {
  '0-30': { maxDays: 30 },
  '31-90': { minDays: 31, maxDays: 90 },
  '91-180': { minDays: 91, maxDays: 180 },
  '181-365': { minDays: 181, maxDays: 365 },
  '365+': { minDays: 366 },
};

/**
 * Age bucket → an inwardDate range filter. age = days since inwardDate, so an
 * age *ceiling* is an inwardDate *floor* and vice-versa. Rows with no inwardDate
 * aren't matched by an age filter (there's no date to bucket them by).
 */
function ageDateFilter(bucket?: string): Prisma.DateTimeNullableFilter | undefined {
  if (!bucket) return undefined;
  const range = AGE_BUCKET_RANGES[bucket];
  if (!range) return undefined;
  const f: Prisma.DateTimeNullableFilter = {};
  if (range.maxDays != null) f.gte = new Date(Date.now() - range.maxDays * DAY_MS);
  if (range.minDays != null) f.lte = new Date(Date.now() - range.minDays * DAY_MS);
  return f;
}

/** Aging-distribution buckets (upper bound in days; last is open-ended). */
const AGING_BUCKETS: { bucket: string; max: number }[] = [
  { bucket: '0–30d', max: 30 },
  { bucket: '31–90d', max: 90 },
  { bucket: '91–180d', max: 180 },
  { bucket: '181–365d', max: 365 },
  { bucket: '365d+', max: Infinity },
];

const STATUS_LABEL: Partial<Record<StockStatus, string>> = {
  in_stock: 'In stock',
  aging: 'Aging',
  dead_stock: 'Dead stock',
  reserved: 'Reserved',
};

const CATEGORY_LABEL: Record<string, string> = {
  necklace: 'Necklaces',
  ring: 'Rings',
  earrings: 'Earrings',
  bangle: 'Bangles',
  bracelet: 'Bracelets',
  pendant: 'Pendants',
  chain: 'Chains',
  other: 'Other',
};

/**
 * Aging is computed LIVE from inwardDate (days since the piece came into stock),
 * so it stays correct without a nightly job repopulating the stored ageDays.
 * Falls back to the persisted ageDays (then 0) when no inwardDate is set.
 */
function liveAgeDays(s: any): number {
  if (s.inwardDate) {
    const d = s.inwardDate instanceof Date ? s.inwardDate : new Date(s.inwardDate);
    const days = Math.floor((Date.now() - d.getTime()) / DAY_MS);
    return days > 0 ? days : 0;
  }
  return s.ageDays ?? 0;
}

function toView(s: any) {
  // A synced piece never carries its own category (syncStock leaves it at the
  // `other` default); the real design category lives on the linked Product.
  // Prefer the item's own category when it's meaningful, else fall back to the
  // product's. Manually-seeded rows set their own category and win here.
  const catKey =
    s.category && s.category !== 'other'
      ? s.category
      : (s.product?.category ?? s.category);
  return {
    id: s.id,
    sku: s.sku ?? '',
    /** The DESIGN. Falls back to the linked product's, which is where a synced
     *  piece carries it. */
    styleNumber: s.styleNumber ?? s.product?.styleNumber ?? null,
    /** The PIECE. Null until somebody issues one — see DeadStockService. */
    vin: s.vin ?? null,
    name: s.name ?? s.product?.name ?? '',
    category: CATEGORY_LABEL[catKey] ?? catKey,
    karat: s.karat ?? 0,
    storeId: s.storeId,
    storeName: s.store?.name ?? '',
    grossGrams: s.grossWeight != null ? Number(s.grossWeight) : 0,
    ageDays: liveAgeDays(s),
    status: STATUS_LABEL[s.status] ?? s.status,
    tagPrice: s.tagPrice != null ? Number(s.tagPrice) : 0,
  };
}

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly gold: GoldRateService,
    private readonly deadStock: DeadStockService,
  ) {}

  /** Combine store scope + the ledger status set + the optional facet/search filters. */
  private buildWhere(
    user: AuthUser,
    headerStore?: string,
    filters?: StockFilters,
  ): Prisma.StockItemWhereInput {
    const and: Prisma.StockItemWhereInput[] = [];

    if (filters?.q) {
      and.push({
        OR: [
          { sku: { contains: filters.q, mode: 'insensitive' } },
          { name: { contains: filters.q, mode: 'insensitive' } },
          // A person searching the shelf types whichever code is in front of
          // them: the design number on the docket, or the piece number on the
          // tag. Both find it.
          { styleNumber: { contains: filters.q, mode: 'insensitive' } },
          { vin: { contains: filters.q, mode: 'insensitive' } },
        ],
      });
    }
    if (filters?.styleNumber) {
      // Exact: "show me every piece of this design" is a grouping, not a search.
      and.push({ styleNumber: { equals: filters.styleNumber, mode: 'insensitive' } });
    }
    if (filters?.storeId) {
      // Explicit store facet — must be in the caller's scope (throws if not).
      this.scope.assertStoreAllowed(user, filters.storeId);
      and.push({ storeId: filters.storeId });
    }
    const ageFilter = ageDateFilter(filters?.ageBucket);
    if (ageFilter) and.push({ inwardDate: ageFilter });

    // A status facet may only narrow within the ledger set; anything else (or
    // unset) falls back to the full ledger set.
    const status =
      filters?.status && LEDGER_STATUSES.includes(filters.status)
        ? filters.status
        : { in: LEDGER_STATUSES };

    return {
      ...this.scope.storeFilter(user, headerStore),
      status,
      ...(filters?.category ? { category: filters.category } : {}),
      ...(filters?.metal ? { metal: filters.metal } : {}),
      ...(and.length ? { AND: and } : {}),
    };
  }

  async list(
    user: AuthUser,
    headerStore?: string,
    pagination?: PageRequest,
    filters?: StockFilters,
  ): Promise<ReturnType<typeof toView>[] | Paginated<ReturnType<typeof toView>>> {
    const where = this.buildWhere(user, headerStore, filters);
    const orderBy: Prisma.StockItemOrderByWithRelationInput = { ageDays: 'desc' };

    const include = {
      store: true,
      product: { select: { category: true, name: true, styleNumber: true } },
    };

    // No page/pageSize → legacy plain-array response (existing frontend shape).
    if (!pagination) {
      const items = await this.prisma.stockItem.findMany({
        where,
        include,
        orderBy,
      });
      return items.map(toView);
    }

    const { page, pageSize } = pagination;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.stockItem.count({ where }),
      this.prisma.stockItem.findMany({
        where,
        include,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toView), total, page, pageSize };
  }

  /**
   * GET /stock/summary — store-scoped aging distribution + dead-stock count over
   * the WHOLE matching set (not one page). Ages are derived live from inwardDate
   * (same rule as the ledger), so the chart and the dead-stock KPI always agree.
   */
  async summary(user: AuthUser, headerStore?: string) {
    // The tenant's own thresholds, resolved ONCE for the whole pass. A lookup
    // per row would be a query per piece on a screen that loads the whole shelf.
    const ruleFor = await this.deadStock.resolverFor(user.organisationId);
    const where: Prisma.StockItemWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      status: { in: LEDGER_STATUSES },
    };
    // Aging needs date/age; the KPI cards also need weight/value/metal; the
    // store-wise breakdown (for "All Stores") needs the owning store.
    const rows = await this.prisma.stockItem.findMany({
      where,
      select: {
        storeId: true,
        inwardDate: true,
        ageDays: true,
        grossWeight: true,
        tagPrice: true,
        metal: true,
        // Needed to pick the right threshold: a chain and a bridal set do not
        // go dead at the same age, which is the whole reason the policy exists.
        category: true,
        // A customised or display piece is not dead MERCHANDISE however old it
        // is — the dead-stock list's default view excludes them, so this does.
        stockClass: true,
        product: { select: { category: true, stockClass: true } },
      },
    });

    // Resolve today's per-gram rate once per distinct metal (store override wins).
    const metals = [...new Set(rows.map((r) => r.metal).filter((m): m is MetalKind => !!m))];
    const rateByMetal = new Map<MetalKind, number>();
    for (const m of metals) {
      rateByMetal.set(m, (await this.gold.getLatestRate(m, user.organisationId, headerStore)) ?? 0);
    }

    /** Value a piece at its tag price, else its metal weight at today's rate. */
    const valueOf = (r: (typeof rows)[number]) => {
      const grams = r.grossWeight != null ? Number(r.grossWeight) : 0;
      const tag = r.tagPrice != null ? Number(r.tagPrice) : 0;
      const rate = r.metal ? (rateByMetal.get(r.metal) ?? 0) : 0;
      return tag > 0 ? tag : grams * rate;
    };

    const counts = AGING_BUCKETS.map(() => 0);
    const bucketValue = AGING_BUCKETS.map(() => 0);
    const perStore = new Map<string, { pieces: number; value: number }>();
    let deadStock = 0;
    let totalGoldGrams = 0;
    let totalStockValue = 0;
    for (const r of rows) {
      const age = liveAgeDays(r);
      const idx = AGING_BUCKETS.findIndex((b) => age <= b.max);
      const bi = idx === -1 ? AGING_BUCKETS.length - 1 : idx;
      const value = valueOf(r);
      counts[bi]++;
      bucketValue[bi] += value;
      // A synced piece leaves `category` at the `other` default and carries the
      // real design category on the linked product — the same fallback the
      // ledger view uses, so the KPI and the rows agree.
      const cat = r.category && r.category !== 'other' ? r.category : (r.product?.category ?? r.category);
      if (age > ruleFor(cat).thresholdDays && effectiveStockClass(r) === 'standard') deadStock++;

      const grams = r.grossWeight != null ? Number(r.grossWeight) : 0;
      totalStockValue += value;
      if (r.metal && GOLD_METALS.has(r.metal)) totalGoldGrams += grams;

      const s = perStore.get(r.storeId) ?? { pieces: 0, value: 0 };
      s.pieces++;
      s.value += value;
      perStore.set(r.storeId, s);
    }

    // Name the stores in the breakdown (only when more than one is in play, i.e.
    // an "All Stores"/multi-store scope — a single-store view needs no split).
    let byStore: { storeId: string; storeName: string; pieces: number; value: number }[] = [];
    if (perStore.size > 1) {
      const stores = await this.prisma.store.findMany({
        where: { id: { in: [...perStore.keys()] } },
        select: { id: true, name: true },
      });
      const nameById = new Map(stores.map((s) => [s.id, s.name]));
      byStore = [...perStore.entries()]
        .map(([storeId, v]) => ({
          storeId,
          storeName: nameById.get(storeId) ?? storeId,
          pieces: v.pieces,
          value: Math.round(v.value),
        }))
        .sort((a, b) => b.value - a.value);
    }

    return {
      aging: AGING_BUCKETS.map((b, i) => ({
        bucket: b.bucket,
        items: counts[i],
        value: Math.round(bucketValue[i]),
      })),
      deadStock,
      totalItems: rows.length,
      totalPieces: rows.length,
      totalGoldGrams: Math.round(totalGoldGrams * 100) / 100,
      totalStockValue: Math.round(totalStockValue),
      byStore,
    };
  }

  /**
   * A destination store for adding stock must be concrete, in scope and a real
   * branch — never the "All Stores" view aggregate. Shared by create + import so
   * neither path can silently invent a store.
   */
  private async assertConcreteDestination(user: AuthUser, storeId?: string) {
    if (!storeId || storeId === 'all') {
      throw new BadRequestException('Select a specific store to add stock to');
    }
    this.scope.assertStoreAllowed(user, storeId);
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, isAggregate: true },
    });
    if (!store || store.isAggregate) {
      throw new BadRequestException('Choose a real store branch to add stock to');
    }
  }

  async create(user: AuthUser, dto: CreateStockDto) {
    await this.assertConcreteDestination(user, dto.storeId);

    // Duplicate prevention: a BIS HUID is unique to one physical piece, so the
    // same HUID must not be entered twice. (SKU is not globally unique across the
    // legacy data, so HUID is the safe natural key to dedupe on.)
    if (dto.huid) {
      // Org-scoped: a HUID is unique to one physical piece WITHIN a tenant. An
      // unscoped check leaks the existence of another org's HUID and wrongly
      // blocks a legitimate same-HUID piece in a different org.
      const clash = await this.prisma.stockItem.findFirst({
        where: { huid: dto.huid, organisationId: user.organisationId },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(`A piece with HUID ${dto.huid} already exists`);
      }
    }

    const item = await this.prisma.stockItem.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId,
        productId: dto.productId,
        sku: dto.sku,
        name: dto.name,
        metal: dto.metal,
        karat: dto.karat,
        status: dto.status ?? 'in_stock',
        grossWeight:
          dto.grossWeight != null ? new Prisma.Decimal(dto.grossWeight) : null,
        netWeight:
          dto.netWeight != null ? new Prisma.Decimal(dto.netWeight) : null,
        pureWeight:
          dto.pureWeight != null ? new Prisma.Decimal(dto.pureWeight) : null,
        diamondPieces: dto.diamondPieces ?? null,
        diamondWeightCt:
          dto.diamondWeightCt != null ? new Prisma.Decimal(dto.diamondWeightCt) : null,
        stoneWeightCt:
          dto.stoneWeightCt != null ? new Prisma.Decimal(dto.stoneWeightCt) : null,
        mrp: dto.mrp != null ? new Prisma.Decimal(dto.mrp) : null,
        tagPrice: dto.tagPrice != null ? new Prisma.Decimal(dto.tagPrice) : null,
        huid: dto.huid,
        hallmarkNo: dto.hallmarkNo,
        certificateNo: dto.certificateNo,
        // imageUrl is intentionally not set here — a piece's photo is Gati-sourced
        // (via /sync/product-images), not uploaded from the website.
        ageDays: 0,
        inwardDate: new Date(),
      },
      include: { store: true },
    });

    await this.audit.record(user, {
      action: 'stock.create',
      entityType: 'StockItem',
      entityId: item.id,
      storeId: dto.storeId,
      summary: `Added stock ${dto.sku} to ${dto.storeId}`,
      metadata: { huid: dto.huid ?? null, sku: dto.sku },
    });
    return toView(item);
  }

  /** True if the piece is currently locked by a live (reserved/in-transit) transfer. */
  private async transferLocked(id: string): Promise<boolean> {
    const hit = await this.prisma.stockTransferItem.findFirst({
      where: {
        stockItemId: id,
        transfer: { status: { in: [...ACTIVE_TRANSFER_STATUSES] } },
      },
      select: { id: true },
    });
    return !!hit;
  }

  /**
   * PATCH /stock/:id — "Adjust status" for one piece. A mandatory reason
   * (Sold / Reserved / Damaged / Lost / Sent for melting / Returned to vendor /
   * Repair) determines the resulting status, so every change is attributable in
   * the audit trail.
   *
   * Moving stock between stores is NOT done here — that goes through the Stock
   * Transfer workflow (HO approval → dispatch → receive), which is the single
   * authoritative transfer path. A piece locked by a live transfer cannot be
   * hand-adjusted (that would let someone dispose of an in-transit piece).
   */
  async adjust(user: AuthUser, id: string, dto: UpdateStockDto) {
    const item = await this.prisma.stockItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Stock item not found');
    this.scope.assertStoreAllowed(user, item.storeId);

    if (await this.transferLocked(id)) {
      throw new ConflictException(
        'Piece is reserved by an active stock transfer; act on the transfer, not the stock record',
      );
    }

    const statusFrom = item.status;
    const statusTo = ADJUST_REASON_TO_STATUS[dto.reason];

    const updated = await this.prisma.stockItem.update({
      where: { id },
      data: { status: statusTo },
      include: { store: true },
    });

    await this.audit.record(user, {
      action: 'stock.adjust',
      entityType: 'StockItem',
      entityId: id,
      storeId: item.storeId,
      summary: `Stock ${item.sku ?? id} status ${statusFrom} → ${statusTo} (${dto.reason})`,
      metadata: { statusFrom, statusTo, reason: dto.reason, note: dto.note },
    });

    return toView(updated);
  }

  /**
   * POST /stock/bulk-adjust — apply one reason/status to many pieces at once.
   * All-or-nothing: every piece is scope-checked and confirmed not transfer-locked
   * before any write, and the updates run in a single transaction so a bulk action
   * can never leave the ledger half-applied. Individual safety rules are NOT
   * bypassed — reserved/in-transit pieces are refused as a set.
   */
  async bulkAdjust(user: AuthUser, dto: BulkAdjustStockDto) {
    const statusTo = ADJUST_REASON_TO_STATUS[dto.reason];
    const items = await this.prisma.stockItem.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, storeId: true, status: true, sku: true },
    });
    if (items.length !== dto.ids.length) {
      throw new BadRequestException('One or more pieces do not exist');
    }
    for (const it of items) this.scope.assertStoreAllowed(user, it.storeId);

    const locked = await this.prisma.stockTransferItem.findMany({
      where: {
        stockItemId: { in: dto.ids },
        transfer: { status: { in: [...ACTIVE_TRANSFER_STATUSES] } },
      },
      select: { stockItemId: true },
    });
    if (locked.length) {
      throw new ConflictException(
        `${locked.length} piece(s) are reserved by an active transfer and cannot be bulk-adjusted`,
      );
    }

    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.stockItem.update({ where: { id: it.id }, data: { status: statusTo } }),
      ),
    );
    for (const it of items) {
      await this.audit.record(user, {
        action: 'stock.adjust.bulk',
        entityType: 'StockItem',
        entityId: it.id,
        storeId: it.storeId,
        summary: `Bulk status ${it.status} → ${statusTo} (${dto.reason})`,
        metadata: { statusFrom: it.status, statusTo, reason: dto.reason, note: dto.note },
      });
    }
    return { updated: items.length, status: statusTo, reason: dto.reason };
  }

  /**
   * POST /stock/bulk-import — add many pieces to ONE concrete store from a parsed
   * spreadsheet. All-or-nothing: every row is validated first (duplicate HUID
   * inside the batch or against existing stock), and if ANY row is bad NOTHING is
   * written — a row-level error report comes back instead, so a bad file can
   * never half-import or silently overwrite existing stock (import only creates).
   */
  async bulkImport(user: AuthUser, dto: BulkImportStockDto) {
    await this.assertConcreteDestination(user, dto.storeId);

    const errors: { row: number; sku: string; error: string }[] = [];
    const huids = dto.rows.map((r) => r.huid).filter((h): h is string => !!h);

    // Existing HUIDs that would clash, resolved in one query.
    const existing = huids.length
      ? await this.prisma.stockItem.findMany({
          where: { huid: { in: huids } },
          select: { huid: true },
        })
      : [];
    const existingHuids = new Set(existing.map((e) => e.huid));
    const seenHuids = new Set<string>();

    dto.rows.forEach((r, i) => {
      if (r.huid) {
        if (existingHuids.has(r.huid)) {
          errors.push({ row: i + 1, sku: r.sku, error: `HUID ${r.huid} already exists` });
        } else if (seenHuids.has(r.huid)) {
          errors.push({ row: i + 1, sku: r.sku, error: `Duplicate HUID ${r.huid} in this file` });
        } else {
          seenHuids.add(r.huid);
        }
      }
    });

    if (errors.length) {
      // No writes — return the full report so the whole file can be fixed at once.
      return { imported: 0, errors };
    }

    const now = new Date();
    await this.prisma.$transaction(
      dto.rows.map((r) =>
        this.prisma.stockItem.create({
          data: {
            organisationId: user.organisationId,
            storeId: dto.storeId,
            sku: r.sku,
            name: r.name,
            metal: r.metal,
            karat: r.karat,
            status: 'in_stock',
            grossWeight: r.grossWeight != null ? new Prisma.Decimal(r.grossWeight) : null,
            netWeight: r.netWeight != null ? new Prisma.Decimal(r.netWeight) : null,
            diamondPieces: r.diamondPieces ?? null,
            diamondWeightCt:
              r.diamondWeightCt != null ? new Prisma.Decimal(r.diamondWeightCt) : null,
            tagPrice: r.tagPrice != null ? new Prisma.Decimal(r.tagPrice) : null,
            huid: r.huid,
            hallmarkNo: r.hallmarkNo,
            certificateNo: r.certificateNo,
            ageDays: 0,
            inwardDate: now,
          },
        }),
      ),
    );

    await this.audit.record(user, {
      action: 'stock.bulk_import',
      entityType: 'Store',
      entityId: dto.storeId,
      storeId: dto.storeId,
      summary: `Bulk-imported ${dto.rows.length} piece(s)`,
      metadata: { count: dto.rows.length },
    });

    return { imported: dto.rows.length, errors: [] };
  }
}
