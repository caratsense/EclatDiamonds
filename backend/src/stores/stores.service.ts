import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import {
  CreateManagerDto,
  CreateRegionDto,
  CreateStoreDto,
  UpdateStoreDto,
} from './dto/stores.dto';

/** Pull a store's assigned store-managers alongside it (for the admin store view). */
const STORE_INCLUDE = {
  userStores: {
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  },
} as const;

/** Two-letter initials fallback for a freshly-provisioned manager login. */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || name.slice(0, 2).toUpperCase()
  );
}

/** Slug-ify a store name/code into a stable, URL-safe id/code. */
function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'store'
  );
}

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public admin/list shape — enriched with assigned store-manager(s). */
  private toView(store: any) {
    const managers = (store.userStores ?? [])
      .filter((us: any) => (us.role ?? us.user.role) === 'store_manager')
      .map((us: any) => ({ id: us.user.id, name: us.user.name, email: us.user.email }));
    return {
      id: store.id,
      name: store.name,
      city: store.city,
      code: store.code ?? null,
      regionId: store.regionId ?? null,
      isActive: store.isActive,
      isAggregate: store.isAggregate,
      managers,
    };
  }

  /**
   * GET /stores — the stores in the caller's scope (store-scoped as before),
   * each enriched with its assigned store-manager(s). Head office / broad roles
   * see every real branch; single-store users see only theirs.
   */
  async list(user: AuthUser) {
    const stores = await this.prisma.store.findMany({
      where: user.allStores ? { isAggregate: false } : { id: { in: user.storeIds } },
      orderBy: { name: 'asc' },
      include: STORE_INCLUDE,
    });
    return stores.map((s) => this.toView(s));
  }

  /** POST /stores (head office) — provision a new branch. */
  async create(dto: CreateStoreDto) {
    let slug: string;
    if (dto.code && dto.code.trim()) {
      slug = slugify(dto.code);
      const clash = await this.prisma.store.findFirst({
        where: { OR: [{ id: slug }, { code: slug }] },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`Store code "${slug}" already exists`);
    } else {
      slug = await this.uniqueSlug(slugify(dto.name));
    }

    await this.assertRegion(dto.regionId);

    const store = await this.prisma.store.create({
      data: {
        id: slug,
        code: slug,
        name: dto.name,
        city: dto.city,
        regionId: dto.regionId || null,
        isActive: true,
        latitude: dto.latitude != null ? String(dto.latitude) : null,
        longitude: dto.longitude != null ? String(dto.longitude) : null,
      },
      include: STORE_INCLUDE,
    });
    return this.toView(store);
  }

  /** PATCH /stores/:id (head office) — edit a branch. Aggregate stores are immutable. */
  async update(id: string, dto: UpdateStoreDto) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('The aggregate "All Stores" view cannot be edited');
    }

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.latitude !== undefined) {
      data.latitude = dto.latitude != null ? String(dto.latitude) : null;
    }
    if (dto.longitude !== undefined) {
      data.longitude = dto.longitude != null ? String(dto.longitude) : null;
    }
    if (dto.regionId !== undefined) {
      const regionId = dto.regionId || null;
      await this.assertRegion(regionId);
      data.regionId = regionId;
    }
    if (dto.code !== undefined) {
      const newCode = dto.code ? slugify(dto.code) : null;
      if (newCode && newCode !== store.code) {
        const clash = await this.prisma.store.findFirst({
          where: { code: newCode, NOT: { id } },
          select: { id: true },
        });
        if (clash) throw new ConflictException(`Store code "${newCode}" already exists`);
      }
      data.code = newCode;
    }

    const updated = await this.prisma.store.update({
      where: { id },
      data,
      include: STORE_INCLUDE,
    });
    return this.toView(updated);
  }

  /**
   * POST /stores/:id/manager (head office) — create the store-manager login and
   * link it to the branch. If the email already belongs to a user, we only ensure
   * the UserStore link exists (never duplicate, never touch their password/role).
   */
  async addManager(storeId: string, dto: CreateManagerDto) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('Store not found');

    const email = dto.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    const isNew = !user;

    if (!user) {
      const passwordHash = await bcrypt.hash(dto.password, 10);
      user = await this.prisma.user.create({
        data: {
          name: dto.name,
          email,
          phone: dto.phone ?? null,
          initials: initialsOf(dto.name),
          role: 'store_manager',
          passwordHash,
          isActive: true,
        },
      });
    }

    await this.prisma.userStore.upsert({
      where: { userId_storeId: { userId: user.id, storeId } },
      update: {},
      create: { userId: user.id, storeId, isPrimary: isNew },
    });

    return { userId: user.id, name: user.name, email: user.email, storeId };
  }

  /** GET /regions (head office) — optional store grouping. */
  async listRegions() {
    const regions = await this.prisma.region.findMany({ orderBy: { name: 'asc' } });
    return regions.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null }));
  }

  /** POST /regions (head office) — create a region. */
  async createRegion(dto: CreateRegionDto) {
    const code = dto.code?.trim() || null;
    if (code) {
      const clash = await this.prisma.region.findUnique({ where: { code } });
      if (clash) throw new ConflictException(`Region code "${code}" already exists`);
    }
    const region = await this.prisma.region.create({ data: { name: dto.name, code } });
    return { id: region.id, name: region.name, code: region.code ?? null };
  }

  /** Ensure a referenced region exists (avoids opaque FK 500s). */
  private async assertRegion(regionId?: string | null): Promise<void> {
    if (!regionId) return;
    const region = await this.prisma.region.findUnique({ where: { id: regionId } });
    if (!region) throw new BadRequestException('Region not found');
  }

  /** Find a store id/code slug not already taken by any existing store. */
  private async uniqueSlug(base: string): Promise<string> {
    const stores = await this.prisma.store.findMany({ select: { id: true, code: true } });
    const taken = new Set<string>();
    for (const s of stores) {
      taken.add(s.id);
      if (s.code) taken.add(s.code);
    }
    let slug = base;
    let n = 2;
    while (taken.has(slug)) slug = `${base}-${n++}`;
    return slug;
  }
}
