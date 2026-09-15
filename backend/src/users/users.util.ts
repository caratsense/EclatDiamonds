import { ConflictException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { isEmail } from 'class-validator';
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

// ── Login IDs ─────────────────────────────────────────────────────────────────

/** The tokens a tenant's Login ID template may use. */
export const LOGIN_ID_TOKENS = ['firstname', 'lastname', 'storeslug', 'orgslug'] as const;

/** Who a Login ID is being minted for. */
export interface LoginIdSubject {
  name: string;
  storeName: string;
  organisationSlug: string | null | undefined;
}

/**
 * The Login ID for collision suffix `n` (1 = no suffix). THE one renderer:
 * self-signup, a manager adding staff, the signup preview and a re-issue after
 * a store override all come through here, so an ID's shape cannot depend on
 * which screen created the account.
 *
 * No template: `<first>.<store>[n]@<tenant domain>` — byte-for-byte what this
 * product has always minted. With a tenant template such as
 * `{firstname}@eclat.{storeslug}.in`, tokens are substituted and the suffix
 * lands at the end of the part before "@" (`priya2@eclat.surat.in`).
 *
 * Pure, and deliberately so: it never consults the database, which is what lets
 * the public preview show the format without revealing who already holds it.
 */
export function renderLoginId(
  template: string | null | undefined,
  subject: LoginIdSubject,
  n = 1,
): string {
  const suffix = n > 1 ? String(n) : '';
  if (!template) {
    return `${handleBase(subject.name, subject.storeName)}${suffix}@${handleDomain(subject.organisationSlug)}`;
  }
  const words = subject.name.trim().split(/\s+/);
  const values: Record<string, string> = {
    firstname: slug(words[0] ?? '') || 'user',
    lastname: words.length > 1 ? slug(words[words.length - 1]) : '',
    storeslug: slug(subject.storeName) || 'store',
    orgslug: domainLabel(subject.organisationSlug) || 'org',
  };
  // An empty token ({lastname} for a one-word name) must not leave "priya.@".
  const fill = (part: string) =>
    part
      .replace(/\{([a-z]+)\}/g, (_, token: string) => values[token] ?? '')
      .replace(/\.{2,}/g, '.')
      .replace(/^[._-]+|[._-]+$/g, '');
  const [local, domain = ''] = template.toLowerCase().split('@');
  const domainPart = fill(domain)
    .split('.')
    .map((label) => label.slice(0, 63))
    .join('.');
  // 56 leaves room for a suffix inside the 64-octet local-part limit.
  return `${(fill(local) || 'user').slice(0, 56)}${suffix}@${domainPart}`;
}

/** True when a store change should re-issue the Login ID (the store is part of it). */
export function loginIdUsesStore(template: string | null | undefined): boolean {
  return !template || template.includes('{storeslug}');
}

/**
 * Why a head-office Login ID template cannot be used, or null when it can.
 *
 * `User.email` is unique across EVERY tenant and sign-in has no tenant context,
 * so the part after "@" must carry this organisation's own code (literally or as
 * {orgslug}) — or be the tenant's existing default domain. Without that, one
 * tenant could mint IDs in the shape another tenant's staff will later need and
 * push them onto collision suffixes.
 */
export function loginIdTemplateError(template: string, organisationSlug: string): string | null {
  const t = template.trim().toLowerCase();
  if (t.length > 100) return 'The template is too long (100 characters at most).';
  const parts = t.split('@');
  if (parts.length !== 2) return 'The template needs exactly one "@".';
  const [local, domain] = parts;
  const tokens = [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  if (tokens.some((k) => !(LOGIN_ID_TOKENS as readonly string[]).includes(k))) {
    return `Unknown token. Use ${LOGIN_ID_TOKENS.map((k) => `{${k}}`).join(', ')}.`;
  }
  const literal = (part: string) => part.replace(/\{[a-z]+\}/g, '');
  if (/[{}]/.test(literal(t))) return 'Every "{" needs a matching "}".';
  if (!local.includes('{firstname}')) return 'The part before "@" must include {firstname}.';
  if (/\{(firstname|lastname)\}/.test(domain)) return 'Names can only go before "@".';
  if (!/^[a-z0-9._-]*$/.test(literal(local))) {
    return 'Before "@", use only letters, digits, ".", "_" and "-".';
  }
  if (!/^[a-z0-9.-]+$/.test(literal(domain) || '-')) {
    return 'After "@", use only letters, digits, "." and "-".';
  }
  const own = domainLabel(organisationSlug);
  const labels = domain.split('.');
  if (!labels.includes(own) && !labels.includes('{orgslug}') && domain !== handleDomain(organisationSlug)) {
    return `The part after "@" must include your organisation code ("${own}") or {orgslug}.`;
  }
  const sample = renderLoginId(t, { name: 'Priya Sharma', storeName: 'Main Store', organisationSlug }, 12);
  if (!isEmail(sample)) return 'That template does not produce a usable Login ID.';
  return null;
}

/** A unique-constraint failure on `User.email` — someone already holds this Login ID. */
export function isLoginIdConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.includes('email') : String(target ?? '').includes('email');
}

/**
 * Write a row under the first free Login ID.
 *
 * The unique index is the arbiter, not a prior lookup: `write` is attempted with
 * suffix 1, 2, 3… and a unique violation on `email` moves to the next. Two
 * people with the same name signing up in the same instant therefore get
 * different IDs — a check-then-insert would hand both the same one and fail one
 * insert. Inside an interactive transaction, `write` must isolate its attempt
 * with a savepoint (see withSavepoint) or the first conflict aborts the whole
 * transaction.
 *
 * ponytail: linear probe, one failed write per existing namesake. Fine at
 * store-team sizes; start from a count of the base if a name ever reaches
 * hundreds.
 */
export async function allocateLoginId<T>(
  render: (n: number) => string,
  write: (loginId: string) => Promise<T>,
): Promise<T> {
  for (let n = 1; n <= 500; n++) {
    try {
      return await write(render(n));
    } catch (err) {
      if (!isLoginIdConflict(err)) throw err;
    }
  }
  throw new ConflictException('Could not assign a unique Login ID. Try again.');
}

/**
 * Run one statement inside a savepoint so its failure leaves the surrounding
 * PostgreSQL transaction usable (a failed statement otherwise aborts it).
 */
export async function withSavepoint<T>(tx: Prisma.TransactionClient, run: () => Promise<T>): Promise<T> {
  await tx.$executeRaw`SAVEPOINT login_id`;
  try {
    const result = await run();
    await tx.$executeRaw`RELEASE SAVEPOINT login_id`;
    return result;
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT login_id`;
    throw err;
  }
}

/**
 * The default Login ID with a caller-supplied existence probe. Kept for the pure
 * format tests that pin the default shape; production writes go through
 * allocateLoginId, which lets the unique index decide.
 */
export async function uniqueEmailHandle(
  name: string,
  storeName: string,
  organisationSlug: string | null | undefined,
  exists: (email: string) => Promise<boolean>,
): Promise<string> {
  const subject = { name, storeName, organisationSlug };
  for (let n = 1; n < 1000; n++) {
    const candidate = renderLoginId(null, subject, n);
    if (!(await exists(candidate))) return candidate;
  }
  return `${handleBase(name, storeName)}.${Date.now()}@${handleDomain(organisationSlug)}`;
}

// ── Signup policy ─────────────────────────────────────────────────────────────

/** The `Organisation.settings` key head office edits from the Team page. */
export const SIGNUP_POLICY_KEY = 'signupPolicy';

export interface SignupPolicy {
  /** Template for NEW users' Login IDs; null = the default format. */
  loginIdTemplate: string | null;
  /** May an applicant ask to be a store manager? Off unless head office turns it on. */
  allowManagerSelfRequest: boolean;
}

export function readSignupPolicy(settings: unknown): SignupPolicy {
  const asObject = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const raw = asObject(asObject(settings)[SIGNUP_POLICY_KEY]);
  const template = typeof raw.loginIdTemplate === 'string' ? raw.loginIdTemplate.trim() : '';
  return {
    loginIdTemplate: template || null,
    allowManagerSelfRequest: raw.allowManagerSelfRequest === true,
  };
}

/**
 * Roles an applicant may ask for. Salesperson and storeperson always; store
 * manager only under an explicit tenant policy, and even then only head office
 * can approve it (canApproveSignup).
 */
export function requestableRoles(policy: SignupPolicy): Role[] {
  return policy.allowManagerSelfRequest
    ? ['salesperson', 'storeperson', 'store_manager']
    : ['salesperson', 'storeperson'];
}

/**
 * REAPPLICATION POLICY — a rejection is terminal for that request, never for
 * the person.
 *
 * The rejected row stays rejected: it cannot sign in, cannot be approved and
 * cannot be activated. The person may re-apply at any time as a FRESH request,
 * which gets a new pending row and a new Login ID; the approver sees the most
 * recent earlier rejection for the same phone beside it.
 *
 * There is deliberately no public cooldown. Phone is optional, so a phone-keyed
 * cooldown is bypassed by leaving it blank; and a distinct refusal would tell
 * anyone holding the organisation code whether a number had been turned down.
 * Queue spam is bounded by the per-IP signup throttle instead.
 */

/**
 * THE self-signup approval boundary, as one pure predicate.
 *
 * An approver may act on a pending signup iff:
 *  - the requested role is STRICTLY BELOW the approver's own rank (never a peer,
 *    a superior, or another head_office),
 *  - AND a manager-level role is decided by head office alone — the folded
 *    area tier included,
 *  - AND, for a scoped (non-head_office) approver, the requested store is inside
 *    their own scope.
 *
 * This governs both what appears in GET /users/pending and what approve() and
 * reject() will act on, so the queue filter and the action gate cannot drift.
 */
export function canApproveSignup(
  actor: { role: Role; allStores: boolean; storeIds: string[] },
  requestedRole: Role,
  requestedStoreId: string | null | undefined,
): boolean {
  if (ROLE_RANK[requestedRole] >= ROLE_RANK[actor.role]) return false;
  if (ROLE_RANK[requestedRole] >= ROLE_RANK.store_manager && actor.role !== 'head_office') return false;
  if (actor.allStores) return true;
  return !!requestedStoreId && actor.storeIds.includes(requestedStoreId);
}
