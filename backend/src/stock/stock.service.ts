import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { ROLE_RANK } from '../common/role.util';
import { PageRequest, Paginated } from '../common/pagination';
import { CreateStockDto, UpdateStockDto } from './dto/stock.dto';

const DAY_MS = 86_400_000;

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
  return {
    id: s.id,
    sku: s.sku ?? '',
    name: s.name ?? '',
    category: CATEGORY_LABEL[s.category] ?? s.category,
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
  ) {}

  async list(
    user: AuthUser,
    headerStore?: string,
    pagination?: PageRequest,
  ): Promise<ReturnType<typeof toView>[] | Paginated<ReturnType<typeof toView>>> {
    const where: Prisma.StockItemWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      status: { in: ['in_stock', 'aging', 'dead_stock', 'reserved'] },
    };
    const orderBy: Prisma.StockItemOrderByWithRelationInput = { ageDays: 'desc' };

    // No page/pageSize → legacy plain-array response (existing frontend shape).
    if (!pagination) {
      const items = await this.prisma.stockItem.findMany({
        where,
        include: { store: true },
        orderBy,
      });
      return items.map(toView);
    }

    const { page, pageSize } = pagination;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.stockItem.count({ where }),
      this.prisma.stockItem.findMany({
        where,
        include: { store: true },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toView), total, page, pageSize };
  }

  async create(user: AuthUser, dto: CreateStockDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const item = await this.prisma.stockItem.create({
      data: {
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
        mrp: dto.mrp != null ? new Prisma.Decimal(dto.mrp) : null,
        tagPrice: dto.tagPrice != null ? new Prisma.Decimal(dto.tagPrice) : null,
        ageDays: 0,
        inwardDate: new Date(),
      },
      include: { store: true },
    });
    return toView(item);
  }

  /**
   * PATCH /stock/:id — change a piece's status and/or transfer it to another store.
   * - Status-only change (e.g. in_stock → reserved → sold): store_manager+ on the
   *   piece's current store.
   * - Transfer (storeId differs from current): a cross-store move requiring
   *   area_manager+, gated on BOTH source and destination store being in scope.
   */
  async adjust(user: AuthUser, id: string, dto: UpdateStockDto) {
    if (dto.status == null && dto.storeId == null) {
      throw new BadRequestException('Nothing to update: provide status or storeId');
    }

    const item = await this.prisma.stockItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Stock item not found');

    // Source store must be in scope for any change.
    this.scope.assertStoreAllowed(user, item.storeId);

    const storeFrom = item.storeId;
    const isTransfer = dto.storeId != null && dto.storeId !== storeFrom;
    if (isTransfer) {
      // Cross-store moves are an area-manager-and-above operation.
      if (ROLE_RANK[user.role] < ROLE_RANK.area_manager) {
        throw new ForbiddenException('Cross-store transfer requires area manager or above');
      }
      this.scope.assertStoreAllowed(user, dto.storeId!);
    }

    const statusFrom = item.status;
    const statusTo = dto.status ?? statusFrom;
    const storeTo = isTransfer ? dto.storeId! : storeFrom;

    const updated = await this.prisma.stockItem.update({
      where: { id },
      data: {
        ...(dto.status != null ? { status: dto.status } : {}),
        ...(isTransfer ? { storeId: dto.storeId! } : {}),
      },
      include: { store: true },
    });

    await this.audit.record(user, {
      action: 'stock.adjust',
      entityType: 'StockItem',
      entityId: id,
      storeId: storeTo,
      summary: isTransfer
        ? `Transferred ${item.sku ?? id} ${storeFrom} → ${storeTo}${
            dto.status != null ? ` (${statusFrom} → ${statusTo})` : ''
          }`
        : `Stock ${item.sku ?? id} status ${statusFrom} → ${statusTo}`,
      metadata: { statusFrom, statusTo, storeFrom, storeTo },
    });

    return toView(updated);
  }
}
