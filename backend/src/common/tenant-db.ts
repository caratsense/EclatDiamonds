import { Prisma } from '@prisma/client';

/**
 * Database-level tenant context for PostgreSQL RLS (Phase B3).
 *
 * ## The contract
 *
 * RLS policies read two session settings:
 *
 *   `app.current_organisation` — the tenant every query is bounded to.
 *   `app.platform_bypass`      — 'on' for control-plane work that legitimately
 *                                spans tenants (the scheduler sweeping due jobs,
 *                                a migration, a platform health check).
 *
 * Both are set with `SET LOCAL`, which is scoped to the surrounding TRANSACTION
 * and reset when it ends. That word is load-bearing: a plain `SET` would persist
 * on the pooled connection, so the next unrelated request to be handed that
 * connection would inherit the previous tenant's context. With a connection pool
 * that is not a theoretical risk, it is the default outcome — which is why every
 * helper here opens a transaction rather than offering a "set it and forget it"
 * variant.
 *
 * ## RLS is the SECOND boundary, never the first
 *
 * The application continues to scope every query through `AuthUser` and
 * `StoreScopeService` exactly as before. These policies exist to catch the query
 * that forgets — a missing `where` clause, a new endpoint written in a hurry —
 * not to replace the checks that make the app correct. A codebase that leaned on
 * RLS alone would break silently and completely the moment a context was not
 * established.
 */

/** Session setting names. Referenced by both the SQL policies and the app. */
export const ORG_SETTING = 'app.current_organisation';
export const BYPASS_SETTING = 'app.platform_bypass';

/**
 * Statements that bind a transaction to one tenant.
 *
 * `set_config(..., true)` is the function form of `SET LOCAL` — used because it
 * takes the value as a bind parameter. String-interpolating an organisation id
 * into a `SET LOCAL` statement would be an injection point in the one place that
 * decides which tenant's data is visible.
 */
export function bindTenant(organisationId: string): Prisma.Sql {
  return Prisma.sql`SELECT set_config(${ORG_SETTING}, ${organisationId}, true), set_config(${BYPASS_SETTING}, 'off', true)`;
}

/**
 * Statements that open the platform bypass.
 *
 * Deliberately noisy at the call site: a bypass is a deliberate, reviewable act,
 * and every caller has to name a reason that ends up in the logs.
 */
export function bindPlatform(): Prisma.Sql {
  return Prisma.sql`SELECT set_config(${ORG_SETTING}, '', true), set_config(${BYPASS_SETTING}, 'on', true)`;
}
