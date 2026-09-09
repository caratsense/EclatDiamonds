import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient tenant context (CaratOS Phase A1).
 *
 * WHAT THIS IS NOT: it is not the authorization contract. `AuthUser` passed
 * explicitly into a service is, and stays so — a service that decides what a
 * caller may touch reads its `user` parameter, never this. Swapping 40 modules
 * onto ambient authorization would turn every missing `runAsTenant` into a
 * silent cross-tenant read, which is exactly the failure mode Step 2 spent a
 * whole pass closing.
 *
 * WHAT IT IS FOR: the places where no `AuthUser` exists or can be threaded —
 *   - structured logs and correlation ids (Phase B5),
 *   - background jobs and connectors running with no HTTP request,
 *   - the `SET app.current_org` that PostgreSQL RLS will read (Phase B3).
 *
 * Two explicit modes, no third. `runAsPlatform` is deliberately noisy about its
 * reason so a cross-tenant operation is greppable in review and in logs.
 */

export interface TenantScope {
  kind: 'tenant';
  organisationId: string;
  /** Present when a signed-in human drove this; absent for jobs/connectors. */
  userId?: string;
  /** Who is acting: a person, a scheduled job, a connector, an inbound webhook. */
  actor: 'user' | 'job' | 'connector' | 'webhook' | 'system';
  /** Correlates every log line and job for one request. */
  requestId?: string;
}

export interface PlatformScope {
  kind: 'platform';
  /** Why this bypassed tenant scoping. Required — an unexplained bypass is a bug. */
  reason: string;
  requestId?: string;
}

export type CaratosScope = TenantScope | PlatformScope;

const storage = new AsyncLocalStorage<CaratosScope>();

/** Run `fn` bound to one tenant. Nested calls replace the scope for their subtree. */
export function runAsTenant<T>(scope: Omit<TenantScope, 'kind'>, fn: () => T): T {
  return storage.run({ kind: 'tenant', ...scope }, fn);
}

/**
 * Run `fn` with no tenant — control-plane work that legitimately spans tenants
 * (the scheduler picking up due jobs, a platform health sweep). `reason` is
 * mandatory so these show up in logs as a deliberate choice.
 */
export function runAsPlatform<T>(reason: string, fn: () => T, requestId?: string): T {
  return storage.run({ kind: 'platform', reason, requestId }, fn);
}

/** The active scope, or undefined outside any bound execution. Never throws. */
export function current(): CaratosScope | undefined {
  return storage.getStore();
}

/**
 * The active tenant's organisation id, or undefined when running as platform or
 * unbound. Callers that need a hard guarantee use {@link requireOrganisationId}.
 */
export function currentOrganisationId(): string | undefined {
  const s = storage.getStore();
  return s?.kind === 'tenant' ? s.organisationId : undefined;
}

/**
 * The active tenant's organisation id, or throw. Fail-closed: code that would
 * otherwise fall back to "the first organisation" must call this instead and let
 * the request fail. Guessing a tenant is worse than a 500.
 */
export function requireOrganisationId(): string {
  const id = currentOrganisationId();
  if (!id) {
    throw new Error(
      'No tenant in scope. Wrap the work in runAsTenant(); never fall back to a default organisation.',
    );
  }
  return id;
}

/** Correlation id for the current request/job, if one was set. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Install a request-scoped, initially tenant-less store around the rest of the
 * request. Called from middleware, which is the only layer that wraps the whole
 * downstream chain — a guard cannot do this, because its AsyncLocalStorage frame
 * exits the moment `canActivate` returns and the route handler would see nothing.
 *
 * The store starts as `platform` with reason 'unauthenticated', and JwtAuthGuard
 * promotes it via {@link adoptTenant} once it has resolved the DB user. Until
 * that happens `currentOrganisationId()` is correctly undefined.
 */
export function bindRequestScope<T>(requestId: string, fn: () => T): T {
  return storage.run({ kind: 'platform', reason: 'unauthenticated', requestId }, fn);
}

/**
 * Promote the current request's scope to a tenant, in place.
 *
 * Mutation rather than a nested `run()` because the caller (JwtAuthGuard) has to
 * hand the scope to code it does not wrap. Safe: the store object belongs to
 * exactly one request's async context and is never shared between requests.
 *
 * No-op outside a bound request (unit tests, scripts) so nothing depends on
 * middleware having run.
 */
export function adoptTenant(scope: Omit<TenantScope, 'kind'>): void {
  const store = storage.getStore();
  if (!store) return;
  const requestId = store.requestId;
  Object.assign(store, { kind: 'tenant', requestId, ...scope });
  // Object.assign leaves `reason` behind from the platform placeholder; drop it
  // so a tenant scope never reads as a deliberate platform bypass in logs.
  delete (store as Partial<PlatformScope>).reason;
}
