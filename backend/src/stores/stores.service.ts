import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

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
      status: store.status,
      isActive: store.isActive,
      isAggregate: store.isAggregate,
      /// Which branch in the client's own system this is — the link head office
      /// needs to reconcile an Eclat branch against Gati. Null for branches
      /// created directly in Eclat.
      legacyId: store.legacyId ?? null,
      // Office address + contact, imported from the client's branch master.
      // Exposed so head office can check what came across and correct it —
      // legacy address data is frequently stale, and it ends up on documents.
      addressLine1: store.addressLine1 ?? null,
      addressLine2: store.addressLine2 ?? null,
      state: store.state ?? null,
      pincode: store.pincode ?? null,
      country: store.country ?? null,
      phone: store.phone ?? null,
      email: store.email ?? null,
      gstin: store.gstin ?? null,
      // Geofence centre. Null here means geo-attendance cannot work for this
      // branch; the legacy system has no coordinates, so these are always set by
      // hand after import.
      latitude: store.latitude != null ? Number(store.latitude) : null,
      longitude: store.longitude != null ? Number(store.longitude) : null,
      geofenceRadiusM: store.geofenceRadiusM ?? null,
      // The store's configured weekly off. Exposed because the HRMS screen that
      // EDITS it had no way to READ it, so it seeded the control from a
      // hardcoded default — showing a day that was not necessarily the one
      // actually saved.
      weekOffDay: store.weekOffDay ?? null,
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
      // head_office => every store OF THEIR ORGANISATION (never global); lower roles
      // => their assignments (already organisation-bounded via resolveScope).
      where: user.allStores
        ? { isAggregate: false, organisationId: user.organisationId }
        : { id: { in: user.storeIds } },
      orderBy: { name: 'asc' },
      include: STORE_INCLUDE,
    });
    return stores.map((s) => this.toView(s));
  }

  /**
   * Public store picker (self-signup). Minimal fields, real trading branches only.
   *
   * Tenant-scoped by an explicit `org` (organisation id or slug) query param.
   * With no `org`: if the platform still has exactly ONE organisation there is
   * nothing to enumerate across, so the picker resolves to that sole org (keeps
   * single-tenant Eclat self-signup working with no frontend change). The moment a
   * SECOND organisation exists, no-`org` returns `[]` — an explicit org is required
   * — so an unauthenticated caller can never enumerate every tenant's branches
   * (audit §I-4 / §L-M2). This is never a "first/default org" guess: it resolves
   * only when the org is unambiguous.
   *
   * ponytail: minimal safe fix, single-org fallback until tenant-aware onboarding.
   * A proper solution resolves the org from the signup CONTEXT (subdomain/custom
   * domain); until then the signup UI passes the org it is signing into.
   */
  async directory(org?: string) {
    const slug = org?.trim();
    let organisationId: string;
    if (slug) {
      const organisation = await this.prisma.organisation.findFirst({
        where: { OR: [{ id: slug }, { slug }] },
        select: { id: true },
      });
      if (!organisation) return [];
      organisationId = organisation.id;
    } else {
      // No org given: only safe when the platform is single-tenant. Take 2 so we
      // can tell "exactly one" from "more than one" without counting all rows.
      const orgs = await this.prisma.organisation.findMany({
        where: { status: { in: ['active', 'onboarding'] } },
        select: { id: true },
        take: 2,
      });
      if (orgs.length !== 1) return [];
      organisationId = orgs[0].id;
    }
    const stores = await this.prisma.store.findMany({
      where: {
        organisationId,
        isAggregate: false,
        status: { not: 'closed' },
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, city: true },
    });
    return stores;
  }

  /**
   * POST /stores (area_manager+) — provision a new branch. head_office is
   * unrestricted; an area_manager may only create in a region they manage.
   * Manually-created stores are deliberately set up, so start active.
   */
  async create(user: AuthUser, dto: CreateStoreDto) {
    await this.assertCanCreateInRegion(user, dto.regionId);

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

    // A store may only go live with geofence coords + a region set — the same
    // invariant activate() enforces. If the creator supplied everything it's
    // active immediately; otherwise it lands pending until activated (no live
    // store can exist without a geofence).
    const hasGeo = dto.latitude != null && dto.longitude != null;
    const ready = hasGeo && !!dto.regionId;
    const store = await this.prisma.store.create({
      data: {
        id: slug,
        code: slug,
        // A store a manager provisions belongs to that manager's organisation.
        organisationId: user.organisationId,
        name: dto.name,
        city: dto.city,
        regionId: dto.regionId || null,
        status: ready ? 'active' : 'pending',
        isActive: ready,
        latitude: dto.latitude != null ? String(dto.latitude) : null,
        longitude: dto.longitude != null ? String(dto.longitude) : null,
      },
      include: STORE_INCLUDE,
    });
    await this.audit.record(user, {
      action: 'store.create',
      entityType: 'store',
      entityId: store.id,
      storeId: store.id,
      summary: `Created branch ${store.name}`,
      metadata: { city: store.city, regionId: store.regionId ?? null },
    });
    return this.toView(store);
  }

  /**
   * PATCH /stores/:id/activate (area_manager+, in scope) — flip a pending branch
   * to active. Geofence coordinates and a region MUST be set first (attendance
   * geofencing and area rollups depend on them).
   */
  async activate(user: AuthUser, id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    if (store.isAggregate) {
      throw new BadRequestException('The aggregate "All Stores" view cannot be activated');
    }
    this.scope.assertStoreAllowed(user, store.id);

    const missing: string[] = [];
    if (store.latitude == null || store.longitude == null) missing.push('geofence coordinates');
    if (!store.regionId) missing.push('region');
    if (missing.length) {
      throw new BadRequestException(`Cannot activate: set ${missing.join(' and ')} first`);
    }

    const updated = await this.prisma.store.update({
      where: { id },
      data: { status: 'active', isActive: true },
      include: STORE_INCLUDE,
    });
    await this.audit.record(user, {
      action: 'store.activate',
      entityType: 'store',
      entityId: updated.id,
      storeId: updated.id,
      summary: `Activated branch ${updated.name}`,
    });
    return this.toView(updated);
  }

  /**
   * PATCH /stores/:id/close (head office) — soft-close a branch. Never deletes:
   * status=closed, isActive=false so history and scoping stay intact.
   */
  async close(user: AuthUser, id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    // Org boundary: an HO must not close a branch belonging to another tenant.
    this.scope.assertOrgAllowed(user, store.organisationId);
    if (store.isAggregate) {
      throw new BadRequestException('The aggregate "All Stores" view cannot be closed');
    }

    const updated = await this.prisma.store.update({
      where: { id },
      data: { status: 'closed', isActive: false },
      include: STORE_INCLUDE,
    });
    await this.audit.record(user, {
      action: 'store.close',
      entityType: 'store',
      entityId: updated.id,
      storeId: updated.id,
      summary: `Closed branch ${updated.name}`,
    });
    return this.toView(updated);
  }

  /**
   * GET /stores/pending (area_manager+, store-scoped) — branches awaiting setup
   * (typically Gati auto-detected), newest first, each flagged with what's still
   * missing before it can be activated.
   */
  async listPending(user: AuthUser) {
    const stores = await this.prisma.store.findMany({
      where: {
        status: 'pending',
        isAggregate: false,
        // storeIds is organisation-bounded for every role (head_office too — it
        // is the org's full store set, pending branches included), so this is the
        // tenant boundary. Never an unfiltered {} that would list another
        // organisation's pending branches.
        id: { in: user.storeIds },
      },
      orderBy: { createdAt: 'desc' },
      include: STORE_INCLUDE,
    });
    return stores.map((s) => {
      const view = this.toView(s);
      return {
        ...view,
        needsGeo: s.latitude == null || s.longitude == null,
        needsRegion: !s.regionId,
        needsManager: view.managers.length === 0,
      };
    });
  }

  /**
   * An area_manager may only create a branch in a region they manage. Region
   * membership is derived from scope: the target region must already contain at
   * least one store in the AM's effective scope. head_office is unrestricted.
   */
  private async assertCanCreateInRegion(
    user: AuthUser,
    regionId?: string | null,
  ): Promise<void> {
    if (user.allStores) return; // head_office: unrestricted
    if (!regionId) {
      throw new ForbiddenException('Select a region you manage for the new branch');
    }
    const inRegion = await this.prisma.store.findFirst({
      where: { regionId, id: { in: user.storeIds } },
      select: { id: true },
    });
    if (!inRegion) {
      throw new ForbiddenException('You can only create a branch in a region you manage');
    }
  }

  /** PATCH /stores/:id (head office) — edit a branch. Aggregate stores are immutable. */
  async update(user: AuthUser, id: string, dto: UpdateStoreDto) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    // @Roles('head_office') alone is org-blind — an HO of another tenant would edit
    // this branch's name/address/GSTIN. Bind the mutation to the caller's org.
    this.scope.assertOrgAllowed(user, store.organisationId);
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
    // Address/contact: an explicitly-sent empty string clears the field, while an
    // omitted key leaves it alone — so a manager can delete a wrong value without
    // every partial edit wiping the rest.
    for (const f of [
      'addressLine1',
      'addressLine2',
      'state',
      'pincode',
      'country',
      'phone',
      'email',
      'gstin',
    ] as const) {
      if (dto[f] !== undefined) data[f] = dto[f] || null;
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
  async addManager(actor: AuthUser, storeId: string, dto: CreateManagerDto) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('Store not found');
    // The new manager is stamped with store.organisationId below — so the store
    // being staffed MUST be the caller's org, or an HO could provision a login
    // into another tenant's branch.
    this.scope.assertOrgAllowed(actor, store.organisationId);

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
          // No AuthUser here — the manager belongs to the branch being staffed,
          // so org is taken from the (already-validated) store.
          organisationId: store.organisationId,
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

  /** GET /regions (head office) — optional store grouping, scoped to the caller's org. */
  async listRegions(user: AuthUser) {
    const regions = await this.prisma.region.findMany({
      where: { organisationId: user.organisationId },
      orderBy: { name: 'asc' },
    });
    return regions.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null }));
  }

  /** POST /regions (head office) — create a region. */
  async createRegion(user: AuthUser, dto: CreateRegionDto) {
    const code = dto.code?.trim() || null;
    if (code) {
      // Region codes are unique PER ORGANISATION (the schema constraint is being
      // made org-scoped); keep the app check org-scoped so two tenants can each
      // own a region "NORTH" without a false clash.
      const clash = await this.prisma.region.findFirst({
        where: { code, organisationId: user.organisationId },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`Region code "${code}" already exists`);
    }
    const region = await this.prisma.region.create({
      data: { name: dto.name, code, organisationId: user.organisationId },
    });
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
