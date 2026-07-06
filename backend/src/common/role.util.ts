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
 * Module 15 cost/margin visibility gate. Only area_manager and head_office may
 * ever see cost price / margin. store_manager and salesperson NEVER do.
 */
export function canSeeCost(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.area_manager;
}
