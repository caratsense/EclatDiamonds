import { Injectable } from '@nestjs/common';
import { Prisma, StockStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { PageRequest, Paginated } from '../common/pagination';
import { CreateStockDto } from './dto/stock.dto';

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
    ageDays: s.ageDays ?? 0,
    status: STATUS_LABEL[s.status] ?? s.status,
    tagPrice: s.tagPrice != null ? Number(s.tagPrice) : 0,
  };
}

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
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
}
