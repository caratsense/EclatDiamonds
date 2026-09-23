import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth-user';
import { isAllStoreRole } from './role.util';
import { DEFAULT_TZ, resolveTz } from './tz.util';

/**
 * StoreScopeService — THE store-scoping mechanism (CLAUDE.md rule #1).
 *
 * Resolve the set of storeIds a user may touch:
 *   - salesperson / store_manager -> their own UserStore assignments
 *   - area_manager               -> every store in the regions they are assigned to
 *   - head_office                -> all stores (allStores=true, no filter)
 *
 * Then `scopedStoreFilter()` turns that into a Prisma `where` fragment, and
 * `assertStoreAllowed()` gates writes. Implement once, reuse in every service.
 */
@Injectable()
export class StoreScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the full allowed-store set for a freshly-authenticated user, SCOPED TO
   * THEIR ORGANISATION. `head_office` (allStores) sees every store OF THEIR ORG —
   * never all stores globally. `organisationId` comes from the authenticated DB
   * user; a missing org yields an empty scope (fail-closed), never a global fetch.
   */
  async resolveScope(
    userId: string,
    role: Role,
    organisationId: string,
  ): Promise<{ storeIds: string[]; allStores: boolean }> {
    // No organisation => no access. Never fall back to a global store fetch.
    if (!organisationId) return { storeIds: [], allStores: isAllStoreRole(role) };

    if (isAllStoreRole(role)) {
      const stores = await this.prisma.store.findMany({
        where: { isAggregate: false, organisationId },
        select: { id: true },
      });
      return { storeIds: stores.map((s) => s.id), allStores: true };
    }

    // Lower roles: only their own UserStore assignments, and only stores that
    // actually belong to their organisation (defence-in-depth against a stray
    // cross-org assignment).
    const assignments = await this.prisma.userStore.findMany({
      where: { userId, store: { organisationId, isHolding: false } },
      select: { storeId: true, store: { select: { regionId: true } } },
    });
    const direct = assignments.map((a) => a.storeId);

    if (role === 'area_manager') {
      // Roll up: every store in any region the user is assigned to (within the
      // organisation), plus direct stores.
      const regionIds = [
        ...new Set(assignments.map((a) => a.store.regionId).filter((r): r is string => !!r)),
      ];
      const regionStores = regionIds.length
        ? await this.prisma.store.findMany({
            where: {
              regionId: { in: regionIds },
              isAggregate: false,
              isHolding: false,
              organisationId,
            },
            select: { id: true },
          })
        : [];
      const ids = [...new Set([...direct, ...regionStores.map((s) => s.id)])];
      return { storeIds: ids, allStores: false };
    }

    // salesperson + store_manager: exactly their assigned stores.
    return { storeIds: [...new Set(direct)], allStores: false };
  }

  /**
   * Build a Prisma `where` fragment that constrains `storeId` to the user's scope.
   * - head_office -> {} (no constraint)
   * - requestedStoreId given -> that store IF it's in scope, else ForbiddenException
   * - otherwise -> { in: user.storeIds }
   *
   * Pass `requestedStoreId` from the X-Store-Id header / ?storeId query so the UI's
   * current-store selector narrows the result for broad roles.
   */
  storeFilter(user: AuthUser, requestedStoreId?: string): { storeId: { in: string[] } | string } {
    if (requestedStoreId && requestedStoreId !== 'all') {
      if (!user.storeIds.includes(requestedStoreId)) {
        throw new ForbiddenException('Store not in your scope');
      }
      return { storeId: requestedStoreId };
    }
    // Always bound to the user's stores — for head_office that is every store OF
    // THEIR ORGANISATION (storeIds is org-resolved in resolveScope), NOT a global
    // no-op filter. This is the primary organisation-isolation guarantee for
    // store-scoped models.
    return { storeId: { in: user.storeIds } };
  }

  /**
   * A `where` fragment for ORGANISATION-level / nullable-store models (gold &
   * diamond rates, discount limits/presets, scheme plans, sync state, legacy rows,
   * audit reads, …). Use this where `storeFilter` cannot (a row with a null storeId
   * would be excluded by a storeId filter, and must be scoped by organisation).
   */
  orgFilter(user: AuthUser): { organisationId: string } {
    return { organisationId: user.organisationId };
  }

  /** Gate a write/read to a specific organisation. Throws if it is not the caller's. */
  assertOrgAllowed(user: AuthUser, organisationId: string | null | undefined): void {
    if (!organisationId || organisationId !== user.organisationId) {
      throw new ForbiddenException('Resource not in your organisation');
    }
  }

  /** The concrete list of store ids in play for a request (for aggregates/dashboards). */
  effectiveStoreIds(user: AuthUser, requestedStoreId?: string): string[] {
    if (requestedStoreId && requestedStoreId !== 'all') {
      // Even head_office must own the store — storeIds is organisation-bounded, so
      // this rejects any store belonging to another organisation.
      if (!user.storeIds.includes(requestedStoreId)) {
        throw new ForbiddenException('Store not in your scope');
      }
      return [requestedStoreId];
    }
    return user.storeIds;
  }

  /**
   * The timezone a report window should be anchored to.
   *
   * Report periods ("today", "this month") are business days at a STORE, not
   * wall-clock windows at whichever datacentre the API happens to run in. This
   * resolves the selected store's zone, falling back to the first store in the
   * caller's scope and finally to the platform default.
   *
   * Known limitation: a roll-up spanning stores in DIFFERENT zones is anchored
   * to one of them. That is correct today (every branch is in Asia/Kolkata) and
   * is the point at which a genuinely multi-zone roll-up would need per-store
   * windows summed together rather than one shared range.
   */
  async resolveTimezone(user: AuthUser, requestedStoreId?: string): Promise<string> {
    const storeId =
      requestedStoreId && requestedStoreId !== 'all'
        ? requestedStoreId
        : user.storeIds[0];
    if (!storeId) return DEFAULT_TZ;
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { timezone: true },
    });
    return resolveTz(store?.timezone);
  }

  /**
   * Gate a write to a specific store. Throws if out of scope. head_office is NOT
   * blanket-allowed any more — its `storeIds` is the set of stores in its
   * organisation, so a store from another organisation is correctly rejected.
   */
  assertStoreAllowed(user: AuthUser, storeId: string): void {
    if (!user.storeIds.includes(storeId)) {
      throw new ForbiddenException('Store not in your scope');
    }
  }

  /**
   * Refuse a store a piece of work may not use.
   *
   * `trading` (the default) is a NEW customer-facing write — sale, quote, lead,
   * footfall, target, DSR, stock intake. It refuses the holding bucket, an
   * attendance-only office and a closed branch. A `pending` branch is allowed
   * on purpose: Gati creates every branch it discovers as pending, and that
   * shop is already selling; pending means "head office has not reviewed its
   * geofence and region yet", not "not trading".
   *
   * `physical` is work against a location that already holds something — stock
   * leaving it, or a return of goods sold there. A closed branch and the
   * holding bucket are allowed, because emptying them is exactly how they stop
   * holding stock; only an attendance-only office is refused.
   */
  async assertTradingStore(storeId: string, use: 'trading' | 'physical' = 'trading'): Promise<void> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        attendanceOnly: true,
        isHolding: true,
        status: true,
      },
    });
    if (!store) {
      throw new BadRequestException('Choose an existing store branch.');
    }
    if (store.attendanceOnly) {
      throw new BadRequestException(`${store.name} is an attendance-only location — choose a store branch.`);
    }
    if (use === 'physical') return;
    if (store.isHolding) {
      throw new BadRequestException(
        `${store.name} is an import holding area — choose a physical store branch.`,
      );
    }
    if (store.status === 'closed') {
      throw new BadRequestException(`${store.name} is closed — choose an open store branch.`);
    }
  }
}
