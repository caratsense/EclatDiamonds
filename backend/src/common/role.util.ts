import { Role } from '@prisma/client';

/** Role rank — higher number == broader scope/visibility. Mirrors frontend ROLE_RANK. */
export const ROLE_RANK: Record<Role, number> = {
  salesperson: 1,
  store_manager: 2,
  area_manager: 3,
  head_office: 4,
};

export const ROLE_LABELS: Record<Role, string> = {
  salesperson: 'Salesperson',
  store_manager: 'Store Manager',
  area_manager: 'Area Manager',
  head_office: 'Head Office',
};

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
