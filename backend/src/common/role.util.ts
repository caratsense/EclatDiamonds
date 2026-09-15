import { Role } from '@prisma/client';

/**
 * Role rank — higher number == broader scope/visibility. Mirrors frontend ROLE_RANK.
 *
 * `storeperson` sits on the front-line tier (1) for DELEGATION only: a store
 * manager may provision and approve one, a salesperson may not. It is never used
 * to ADMIT a storeperson anywhere — RolesGuard decides that from explicit
 * permissions, so `@Roles('salesperson')` does not open a CRM route to them.
 */
export const ROLE_RANK: Record<Role, number> = {
  salesperson: 1,
  storeperson: 1,
  store_manager: 2,
  area_manager: 3,
  head_office: 4,
};

export const ROLE_LABELS: Record<Role, string> = {
  salesperson: 'Salesperson',
  storeperson: 'Storeperson',
  store_manager: 'Store Manager',
  area_manager: 'Area Manager',
  head_office: 'Head Office',
};

/**
 * Front-line roles that see only their OWN records wherever a service narrows
 * "mine" from "the store's" — attendance, leave, payslips. Use this instead of
 * `role === 'salesperson'`, which silently hands a storeperson the manager view.
 */
export function isFrontLine(role: Role): boolean {
  return ROLE_RANK[role] < ROLE_RANK.store_manager;
}

/** head_office sees everything (no storeId filter). */
export function isAllStoreRole(role: Role): boolean {
  return role === 'head_office';
}

/**
 * Module 15 cost/margin visibility gate. store_manager and head_office may see
 * cost price / margin; a salesperson NEVER does. (Store manager was raised into
 * this in 2026-08 when the area-manager tier was folded into it.)
 */
export function canSeeCost(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.store_manager;
}
