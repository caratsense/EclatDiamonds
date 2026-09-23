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
      isHolding: store.isHolding,
      attendanceOnly: store.attendanceOnly,
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
        ? {
            isAggregate: false,
            organisationId: user.organisationId,
          }
        : {
            id: { in: user.storeIds },
            organisationId: user.organisationId,
          },
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
        isHolding: false,
        attendanceOnly: false,
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

    let code: string;
    if (dto.code && dto.code.trim()) {
      code = slugify(dto.code);
      const clash = await this.prisma.store.findFirst({
        where: { organisationId: user.organisationId, code },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`Store code "${code}" already exists`);
    } else {
      code = await this.uniqueCode(user.organisationId, slugify(dto.name));
    }
    // Store ids are globally unique for historical FK compatibility, while
    // human branch codes are unique only inside a tenant. Another tenant using
    // the same code gets a distinct internal id, not a false conflict.
    const id = await this.uniqueId(code);

    await this.assertRegion(user.organisationId, dto.regionId);

    // A store may only go live with geofence coords + a region set — the same
    // invariant activate() enforces. If the creator supplied everything it's
    // active immediately; otherwise it lands pending until activated (no live
    // store can exist without a geofence).
    const hasGeo = dto.latitude != null && dto.longitude != null;
    const ready = hasGeo && !!dto.regionId;
    const store = await this.prisma.store.create({
      data: {
        id,
        code,
        // A store a manager provisions belongs to that manager's organisation.
        organisationId: user.organisationId,
        name: dto.name,
        city: dto.city,
        regionId: dto.regionId || null,
        status: ready ? 'active' : 'pending',
        isActive: ready,
        isHolding: false,
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
   * PATCH /stores/:id/activate (area_manager+, in scope) — take a branch live.
   * Geofence coordinates and a region MUST be set first (attendance geofencing
   * and area rollups depend on them).
   *
   * It reopens a closed branch as well as activating a pending one. A shop shut
   * for a refit or a season comes back, and `close()` is deliberately a soft
   * close, so the way back has to exist here rather than in the database.
   */
  async activate(user: AuthUser, id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Store not found');
    // Authorize before describing the target. Otherwise a caller could probe a
    // foreign id and distinguish an aggregate/holding row by its error message.
    this.scope.assertStoreAllowed(user, store.id);
    if (store.isAggregate) {
      throw new BadRequestException('The aggregate "All Stores" view cannot be activated');
    }
    if (store.isHolding) {
      throw new BadRequestException('The unassigned import bucket is not a physical branch');
    }
    if (store.isActive || store.status === 'active') {
      throw new ConflictException('This branch is already active');
    }

    const missing: string[] = [];
    if (store.latitude == null || store.longitude == null) missing.push('geofence coordinates');
    if (!store.attendanceOnly && !store.regionId) missing.push('region');
    if (missing.length) {
      throw new BadRequestException(`Cannot activate: set ${missing.join(' and ')} first`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.store.updateMany({
        where: {
          id,
          organisationId: user.organisationId,
          status: { in: ['pending', 'closed'] },
          isActive: false,
          isHolding: false,
          latitude: { not: null },
          longitude: { not: null },
          ...(store.attendanceOnly ? {} : { regionId: { not: null } }),
        },
        data: { status: 'active', isActive: true },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          'Branch details changed while it was being activated. Review and try again.',
        );
      }
      const saved = await tx.store.findFirstOrThrow({
        where: { id, organisationId: user.organisationId },
        include: STORE_INCLUDE,
      });
      await this.audit.record(user, {
        action: 'store.activate',
        entityType: 'store',
        entityId: saved.id,
        storeId: saved.id,
        summary: `${store.status === 'closed' ? 'Reopened' : 'Activated'} branch ${saved.name}`,
      }, tx);
      return saved;
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
    if (store.isHolding) {
      throw new BadRequestException('The unassigned import bucket is not a physical branch');
    }
    if (store.status === 'closed' && !store.isActive) {
      throw new ConflictException('This branch is already closed');
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
        isHolding: false,
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
    if (!user.allStores) {
      this.scope.assertStoreAllowed(user, id);
    }
    if (store.isAggregate) {
      throw new BadRequestException('The aggregate "All Stores" view cannot be edited');
    }
    if (store.isHolding) {
      throw new BadRequestException('The unassigned import bucket is managed by reconciliation');
    }

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.city !== undefined) data.city = dto.city;
    // Lifecycle is a two-column invariant. A generic edit used to change only
    // isActive and could leave `status=active,isActive=false` (or the reverse).
    // The dedicated Activate/Close endpoints enforce readiness, authorization
    // and audit, so this one ignores the field: a browser still holding the
    // previous bundle sends it on every save, and failing that save would make
    // the deploy window look like a broken screen.
    if (dto.latitude !== undefined) {
      data.latitude = dto.latitude != null ? String(dto.latitude) : null;
    }
    if (dto.geofenceRadiusM !== undefined) data.geofenceRadiusM = dto.geofenceRadiusM;
    if (dto.longitude !== undefined) {
      data.longitude = dto.longitude != null ? String(dto.longitude) : null;
    }
    if (dto.regionId !== undefined) {
      // Area-manager scope is derived from the regions of their directly
      // assigned stores. Letting a scoped manager move that anchor to another
      // region would silently grant access to every branch in the new region
      // on the next request. Region membership is therefore an HO-only change.
      if (user.role !== 'head_office') {
        throw new ForbiddenException('Only Head Office can change a branch region.');
      }
      const regionId = dto.regionId || null;
      await this.assertRegion(user.organisationId, regionId);
      data.regionId = regionId;
    }

    // A live branch may be relocated, but it may not be left in a state the
    // activation endpoint itself would reject. Check the effective post-patch
    // values so one request can fill a legacy gap, while explicit runtime nulls
    // and an empty region are treated as removals rather than as "not supplied".
    if (store.status === 'active' || store.isActive) {
      const nextLatitude =
        dto.latitude !== undefined ? dto.latitude : store.latitude;
      const nextLongitude =
        dto.longitude !== undefined ? dto.longitude : store.longitude;
      const nextRegionId =
        dto.regionId !== undefined ? dto.regionId || null : store.regionId;
      const missing: string[] = [];
      if (nextLatitude == null) missing.push('latitude');
      if (nextLongitude == null) missing.push('longitude');
      if (!store.attendanceOnly && !nextRegionId) missing.push('region');
      if (missing.length) {
        throw new BadRequestException(
          `An active branch must keep ${missing.join(', ')} configured`,
        );
      }
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
          where: { organisationId: user.organisationId, code: newCode, NOT: { id } },
          select: { id: true },
        });
        if (clash) throw new ConflictException(`Store code "${newCode}" already exists`);
      }
      data.code = newCode;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Bind the write to the lifecycle state validated above. If activation or
      // closure wins the race, a stale pending edit cannot clear readiness
      // fields underneath the newly-live branch.
      const written = await tx.store.updateMany({
        where: {
          id,
          organisationId: user.organisationId,
          status: store.status,
          isActive: store.isActive,
          isHolding: false,
        },
        data,
      });
      if (written.count !== 1) {
        throw new ConflictException(
          'Branch status changed while it was being edited. Reload and try again.',
        );
      }
      const saved = await tx.store.findFirstOrThrow({
        where: { id, organisationId: user.organisationId },
        include: STORE_INCLUDE,
      });
      await this.audit.record(user, {
        action: 'store.update',
        entityType: 'store',
        entityId: saved.id,
        storeId: saved.id,
        summary: `Updated branch ${saved.name}`,
        metadata: { changedFields: Object.keys(data).sort() },
      }, tx);
      return saved;
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
    if (store.isHolding) {
      throw new BadRequestException('Managers cannot be assigned to the unassigned import bucket');
    }

    const email = dto.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    const isNew = !user;

    if (user && user.organisationId !== store.organisationId) {
      throw new ConflictException('That login belongs to a different organisation');
    }
    if (user && user.role !== 'store_manager') {
      throw new ConflictException('That login already exists with a different role');
    }

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

    await this.audit.record(actor, {
      action: 'store.manager.assign',
      entityType: 'store',
      entityId: store.id,
      storeId: store.id,
      summary: `Assigned ${user.name} as manager of ${store.name}`,
      metadata: { userId: user.id, createdLogin: isNew },
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
  private async assertRegion(
    organisationId: string,
    regionId?: string | null,
  ): Promise<void> {
    if (!regionId) return;
    const region = await this.prisma.region.findFirst({
      where: { id: regionId, organisationId },
      select: { id: true },
    });
    if (!region) throw new BadRequestException('Region not found');
  }

  /** Find a human branch code not already used inside this organisation. */
  private async uniqueCode(organisationId: string, base: string): Promise<string> {
    const stores = await this.prisma.store.findMany({
      where: { organisationId },
      select: { code: true },
    });
    const taken = new Set(stores.flatMap((s) => (s.code ? [s.code] : [])));
    let code = base;
    let n = 2;
    while (taken.has(code)) code = `${base}-${n++}`;
    return code;
  }

  /** Store ids remain globally unique even though visible codes are tenant-scoped. */
  private async uniqueId(base: string): Promise<string> {
    const rows = await this.prisma.store.findMany({ select: { id: true } });
    const taken = new Set(rows.map((s) => s.id));
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }
}
