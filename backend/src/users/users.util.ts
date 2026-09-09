import { Role } from '@prisma/client';
import { ROLE_RANK } from '../common/role.util';

/**
 * The neutral root every tenant's generated login handles hang off.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, which is the point:
 * a login handle is an IDENTIFIER, not a mailbox. Nothing is ever delivered to
 * it, and the person's real address lives in `User.contactEmail`. Naming it
 * something deliverable-looking would invite exactly the confusion this replaces
 * — every tenant's staff signing in at a jeweller's domain.
 *
 * Override with `PLATFORM_HANDLE_DOMAIN` once a real platform login domain
 * exists; existing handles are stored values and are unaffected by the change.
 */
export const PLATFORM_HANDLE_DOMAIN =
  process.env.PLATFORM_HANDLE_DOMAIN?.trim().toLowerCase() || 'accounts.caratos.invalid';

/**
 * Tenants whose handles predate tenant-scoping.
 *
 * Éclat's staff have been signing in as `firstname.store@eclatdiamonds.in` since
 * before this product had a second tenant. Those handles are live credentials in
 * live records: moving them would lock real people out on a Monday morning for
 * no benefit they can see. So this organisation keeps its domain — for existing
 * handles AND for new ones, so a store that hires next month does not end up
 * with staff on two different domains.
 *
 * Keyed by `Organisation.slug`, deliberately, and not by industry: "jewellery"
 * is a pack anyone may choose, and the second jeweller to sign up gets their own
 * tenant-scoped domain like everybody else.
 */
const LEGACY_HANDLE_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  eclat: 'eclatdiamonds.in',
});

/** lowercase, strip everything but a-z0-9. "MUMBAI BANDRA" -> "mumbaibandra". */
function slug(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * One DNS label from a tenant slug. Hyphens survive (they are legal and they are
 * what `Organisation.slug` already uses); anything else becomes one, and the
 * result is trimmed and capped at the 63-octet label limit so a long tenant name
 * cannot produce a handle no validator will accept.
 */
function domainLabel(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/, '');
}

/**
 * The domain a given organisation's generated handles live on.
 *
 * `<tenant-slug>.accounts.caratos.invalid` for everyone but the legacy tenant
 * above. Tenant-scoping is what makes a handle collision across two customers
 * structurally impossible rather than merely unlikely — two clinics can both
 * employ a Priya at their Andheri branch and neither one's sign-in is disturbed
 * by the other existing.
 *
 * An organisation with no usable slug falls back to the bare platform root. That
 * cannot happen through any current path (`Organisation.slug` is required and
 * unique) and it is still handled, because the alternative is minting a handle
 * with an empty DNS label that no validator will accept.
 */
export function handleDomain(organisationSlug: string | null | undefined): string {
  const label = domainLabel(organisationSlug);
  const legacy = LEGACY_HANDLE_DOMAINS[label];
  if (legacy) return legacy;
  return label ? `${label}.${PLATFORM_HANDLE_DOMAIN}` : PLATFORM_HANDLE_DOMAIN;
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
 * A globally-unique login handle `<first>.<store>@<tenant domain>`.
 *
 * THE one generator: self-signup, a manager adding staff, and re-issuing a
 * handle after a store reassignment all come through here, so a handle's shape
 * cannot depend on which screen created the account.
 *
 * Appends a numeric suffix (`...2`, `...3`) only when the base is already taken,
 * so the common case reads cleanly. `exists` is injected (the caller passes a
 * Prisma lookup) to keep this independently testable — and it must check
 * GLOBALLY, not within the tenant: `User.email` is unique across the table, so a
 * per-tenant check would let an insert fail at the database instead of here.
 */
export async function uniqueEmailHandle(
  name: string,
  storeName: string,
  organisationSlug: string | null | undefined,
  exists: (email: string) => Promise<boolean>,
): Promise<string> {
  const base = handleBase(name, storeName);
  const domain = handleDomain(organisationSlug);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}${n === 1 ? '' : n}@${domain}`;
    if (!(await exists(candidate))) return candidate;
  }
  // Astronomically unlikely (1000 same-name collisions in one store); disambiguate.
  return `${base}.${Date.now()}@${domain}`;
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
