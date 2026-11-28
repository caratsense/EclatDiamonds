/**
 * What a branch needs in order to TRADE, and what it is merely INCOMPLETE
 * without.
 *
 * These were one rule until 28 Nov, when the client could not take INDORE
 * RATNAMANI COMPLEX live: "for activation this shouldn't be there. Geofencing
 * could be set up later on when we want it. The store should at least be
 * activated without that geofence so that we can start operating on it."
 *
 * She is right, and the old rule confused two different things:
 *
 *  - a geofence exists for GEO-TAGGED ATTENDANCE. A shop sells, quotes, holds
 *    stock and answers customers without one, so a missing one cannot be
 *    allowed to stop it trading.
 *  - a region exists for AREA ROLLUPS in reporting. A branch with no region is
 *    absent from an area manager's totals — a real cost, and still not a
 *    reason to stop it trading.
 *
 * Neither is something the customer at the counter depends on, so neither
 * gates activation any more. They are reported as gaps ON the branch instead
 * (`storeSetupGaps`), which is the honest signal: the shop is open, and head
 * office can still see exactly what is unfinished about it.
 *
 * Pure on purpose. The rule is the part worth testing and the part that was
 * wrong, and it is testable here with no Nest container and no database.
 */

/**
 * Prisma hands coordinates over as `Decimal`, the DTOs as numbers and the
 * import paths as strings. Only their PRESENCE is decided here, so the shape
 * stays as wide as every caller already is.
 */
type Coordinate = number | string | { toString(): string } | null;

/** The branch facts the lifecycle rules are decided from. */
export interface StoreLifecycleFacts {
  isAggregate: boolean;
  isHolding: boolean;
  isActive: boolean;
  status: string;
  attendanceOnly: boolean;
  latitude: Coordinate;
  longitude: Coordinate;
  regionId: string | null;
}

/**
 * Why activation is refused — a code, so the sentence the caller shows stays
 * with the endpoint and the rule stays testable on its own.
 *
 * Note what is NOT here: a missing geofence and a missing region. Everything
 * left is a row that is not a branch at all, or a branch that is already open.
 */
export type ActivationRefusal = 'aggregate' | 'holding' | 'already_active';

/**
 * Refuse to activate what cannot be activated, and nothing else.
 *
 * `status === 'active'` is checked alongside `isActive` because the two columns
 * are one invariant that a past generic edit could leave half-written; either
 * one saying "open" means a second activation is a conflict, not an event.
 */
export function refuseActivation(
  store: Pick<StoreLifecycleFacts, 'isAggregate' | 'isHolding' | 'isActive' | 'status'>,
): ActivationRefusal | null {
  if (store.isAggregate) return 'aggregate';
  if (store.isHolding) return 'holding';
  if (store.isActive || store.status === 'active') return 'already_active';
  return null;
}

/** What a branch is incomplete without — never what stops it trading. */
export interface StoreSetupGaps {
  /**
   * No geofence centre. Attendance still works, but no punch here can be
   * location-checked, so none of them is geo-verified.
   */
  needsGeo: boolean;
  /** No region, so this branch is absent from area-manager rollups. */
  needsRegion: boolean;
}

export function storeSetupGaps(
  store: Pick<StoreLifecycleFacts, 'attendanceOnly' | 'latitude' | 'longitude' | 'regionId'>,
): StoreSetupGaps {
  return {
    needsGeo: store.latitude == null || store.longitude == null,
    // An attendance-only office does not sell, so it is in no sales area's
    // rollup by design and a missing region is not a gap for it.
    needsRegion: !store.attendanceOnly && !store.regionId,
  };
}
