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
import { CreateProductDto } from './dto/product.dto';

function toView(p: any) {
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

  async list(
    user: AuthUser,
    f: ProductFilters,
    headerStore?: string,
    pagination?: PageRequest,
  ): Promise<ReturnType<typeof toView>[] | Paginated<ReturnType<typeof toView>>> {
    const where: Prisma.ProductWhereInput = {};
    if (f.category) where.category = f.category;
    if (f.metal) where.metal = f.metal;
    if (f.availability) where.availability = f.availability;

    // Catalogue is shared, but scope to the user's stores (+ global products with no store).
    const requested = f.storeId ?? headerStore;
    if (requested && requested !== 'all') {
      this.scope.assertStoreAllowed(user, requested);
      where.OR = [{ storeId: requested }, { storeId: null }];
    } else if (!user.allStores) {
      where.OR = [{ storeId: { in: user.storeIds } }, { storeId: null }];
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: 'desc' };

    // No page/pageSize → legacy plain-array response (existing frontend shape).
    if (!pagination) {
      const products = await this.prisma.product.findMany({ where, orderBy });
      return products.map(toView);
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
    return { items: rows.map(toView), total, page, pageSize };
  }

  async get(_user: AuthUser, id: string) {
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Product not found');
    return toView(p);
  }

  /** Create a catalogue product. Managers and above (store-scoped if storeId given). */
  async create(user: AuthUser, dto: CreateProductDto) {
    if (dto.storeId) this.scope.assertStoreAllowed(user, dto.storeId);

    const existing = await this.prisma.product.findUnique({
      where: { sku: dto.sku },
    });
    if (existing) throw new ConflictException(`SKU "${dto.sku}" already exists`);

    const created = await this.prisma.product.create({
      data: {
        sku: dto.sku,
        name: dto.name,
        category: dto.category,
        metal: dto.metal,
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
    // A store-scoped product can only be edited by someone with that store in scope.
    if (p.storeId) this.scope.assertStoreAllowed(user, p.storeId);

    const ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const imageUrl = await this.storage.save('products', `${id}.${ext}`, file.buffer);
    const updated = await this.prisma.product.update({ where: { id }, data: { imageUrl } });
    return toView(updated);
  }
}
