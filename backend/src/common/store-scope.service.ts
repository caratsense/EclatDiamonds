import { ForbiddenException, Injectable } from '@nestjs/common';
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

  /** Resolve the full allowed-store set for a freshly-authenticated user. */
  async resolveScope(userId: string, role: Role): Promise<{ storeIds: string[]; allStores: boolean }> {
    if (isAllStoreRole(role)) {
      const stores = await this.prisma.store.findMany({
        where: { isAggregate: false },
        select: { id: true },
      });
      return { storeIds: stores.map((s) => s.id), allStores: true };
    }

    const assignments = await this.prisma.userStore.findMany({
      where: { userId },
      select: { storeId: true, store: { select: { regionId: true } } },
    });
    const direct = assignments.map((a) => a.storeId);

    if (role === 'area_manager') {
      // Roll up: every store in any region the user is assigned to, plus direct stores.
      const regionIds = [
        ...new Set(assignments.map((a) => a.store.regionId).filter((r): r is string => !!r)),
      ];
      const regionStores = regionIds.length
        ? await this.prisma.store.findMany({
            where: { regionId: { in: regionIds }, isAggregate: false },
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
  storeFilter(user: AuthUser, requestedStoreId?: string): { storeId?: { in: string[] } | string } {
    if (requestedStoreId && requestedStoreId !== 'all') {
      if (!user.allStores && !user.storeIds.includes(requestedStoreId)) {
        throw new ForbiddenException('Store not in your scope');
      }
      return { storeId: requestedStoreId };
    }
    if (user.allStores) return {};
    return { storeId: { in: user.storeIds } };
  }

  /** The concrete list of store ids in play for a request (for aggregates/dashboards). */
  effectiveStoreIds(user: AuthUser, requestedStoreId?: string): string[] {
    if (requestedStoreId && requestedStoreId !== 'all') {
      if (!user.allStores && !user.storeIds.includes(requestedStoreId)) {
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

  /** Gate a write to a specific store. Throws if out of scope. */
  assertStoreAllowed(user: AuthUser, storeId: string): void {
    if (user.allStores) return;
    if (!user.storeIds.includes(storeId)) {
      throw new ForbiddenException('Store not in your scope');
    }
  }
}
