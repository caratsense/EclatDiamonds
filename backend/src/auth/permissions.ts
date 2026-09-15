import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * Permissions for access that a rank cannot express.
 *
 * `@Roles()` is a ladder: salesperson < store manager < head office, each rung
 * inheriting the one below. That is right for the people it was written for and
 * wrong for a job that is not on the ladder. A storeperson runs a branch's stock
 * and photos; they are not a junior salesperson (no customers, no pipeline) and
 * not a manager (no team, no money). Putting them on the ladder at any height
 * would hand them one of those by inheritance.
 *
 * So a storeperson is admitted ONLY where a route names a permission they hold,
 * and nowhere else — a new route is closed to them until somebody decides
 * otherwise. Every other role keeps the ladder exactly as before; `@Permit()` on
 * a route does not widen it for them.
 */
export const PERMISSIONS = [
  /** Who am I, my notifications, the tenant configuration every screen reads. */
  'session',
  /** My own punches, geofence, shift, holidays and regularisations. */
  'self.attendance',
  /** My own leave. */
  'self.leave',
  /** My own payslips. */
  'self.payslip',
  /** The catalogue at my branch, without cost or margin. */
  'catalogue.read',
  /** Product photographs: single upload and the image ZIP import. */
  'catalogue.images',
  /** The stock ledger, VIN lookup and dead stock at my branch. */
  'inventory.read',
  /** Inwarding a piece at my branch. */
  'inventory.write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const EVERYTHING: readonly Permission[] = PERMISSIONS;

/**
 * What each role holds. Typed `Record<Role, …>` so adding a role to the enum is a
 * compile error here until somebody decides what it may do.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  salesperson: ['session', 'self.attendance', 'self.leave', 'self.payslip', 'catalogue.read', 'inventory.read'],
  storeperson: [
    'session',
    'self.attendance',
    'self.leave',
    'self.payslip',
    'catalogue.read',
    'catalogue.images',
    'inventory.read',
    'inventory.write',
  ],
  store_manager: EVERYTHING,
  area_manager: EVERYTHING,
  head_office: EVERYTHING,
};

/**
 * Roles whose access is decided ONLY by permissions. For these, a route with no
 * `@Permit()` is refused even when it has no `@Roles()` at all.
 */
export const PERMISSION_ONLY_ROLES: ReadonlySet<Role> = new Set<Role>(['storeperson']);

export const PERMISSIONS_KEY = 'permissions';

/** Admit a permission-only role holding any of these. Other roles are unaffected. */
export const Permit = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export function holds(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
