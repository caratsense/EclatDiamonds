import { Role } from '@prisma/client';
import { ROLE_RANK } from '../common/role.util';

/** Login-handle domain. Every generated sign-in identity lives here. */
export const HANDLE_DOMAIN = 'eclatdiamonds.in';

/** lowercase, strip everything but a-z0-9. "MUMBAI BANDRA" -> "mumbaibandra". */
function slug(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The local part of a login handle: `<firstname>.<storeslug>`. Pure + testable.
 * The store makes it unique across branches even for a shared first name, which
 * is the whole point — "shreyansh.mumbaibandra" vs "shreyansh.udaipur".
 */
export function handleBase(name: string, storeName: string): string {
  const first = slug(name.trim().split(/\s+/)[0] || 'user') || 'user';
  const store = slug(storeName) || 'store';
  return `${first}.${store}`;
}

/**
 * A globally-unique login handle `<first>.<store>@eclatdiamonds.in`. Appends a
 * numeric suffix (`...2`, `...3`) only when the base is already taken, so the
 * common case reads cleanly. `exists` is injected (the caller passes a Prisma
 * lookup) to keep this independently testable.
 */
export async function uniqueEmailHandle(
  name: string,
  storeName: string,
  exists: (email: string) => Promise<boolean>,
): Promise<string> {
  const base = handleBase(name, storeName);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}${n === 1 ? '' : n}@${HANDLE_DOMAIN}`;
    if (!(await exists(candidate))) return candidate;
  }
  // Astronomically unlikely (1000 same-name collisions in one store); disambiguate.
  return `${base}.${Date.now()}@${HANDLE_DOMAIN}`;
}

/**
 * THE self-signup approval boundary, as one pure predicate.
 *
 * An approver may act on a pending signup iff:
 *  - the requested role is STRICTLY BELOW the approver's own rank
 *    (so head_office approves store/area managers; a store/area manager approves
 *    only salespeople — never a peer or superior, and never another head_office),
 *  - AND, for a scoped (non-head_office) approver, the requested store is inside
 *    their own scope.
 *
 * This governs both what appears in GET /users/pending and — mirrored by the
 * throwing guards in approve()/reject() — what an approver may actually grant.
 * Keeping it in one place stops the queue filter and the action gate drifting.
 */
export function canApproveSignup(
  actor: { role: Role; allStores: boolean; storeIds: string[] },
  requestedRole: Role,
  requestedStoreId: string | null | undefined,
): boolean {
  if (ROLE_RANK[requestedRole] >= ROLE_RANK[actor.role]) return false;
  if (actor.allStores) return true;
  return !!requestedStoreId && actor.storeIds.includes(requestedStoreId);
}
