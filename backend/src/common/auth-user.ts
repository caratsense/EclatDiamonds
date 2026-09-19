import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * The authenticated principal resolved by JwtAuthGuard and attached to req.user.
 *
 * `storeIds` is the FULL set of stores this user may read/write, already resolved
 * from UserStore assignments + role rank. `head_office` gets `allStores: true`
 * (no storeId filter at all). This is the single source of truth for store-scoping.
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /**
   * The organisation (tenant) this user belongs to. Resolved from the DB user,
   * NEVER from the token payload or any request-supplied value. Every store in
   * `storeIds` belongs to this organisation, so organisation isolation rides on
   * store scope for store-scoped queries; use `StoreScopeService.orgFilter` for
   * organisation-level / nullable-store models.
   */
  organisationId: string;
  /**
   * Stores the user may read/write — for head_office this is EVERY store OF THIS
   * ORGANISATION (never all stores globally), for lower roles their assignments.
   */
  storeIds: string[];
  /**
   * The screens this person may open and at what level (auth/access.ts): their
   * role's defaults with head office's per-person changes applied. Absent for
   * machines.
   */
  access?: import('../auth/access').AccessMap;
  /**
   * Set by ModuleAccessGuard when this request is served at a different level
   * than the person's own role (e.g. a salesperson head office gave Inventory
   * to): the role they actually hold. Audit lines should name the real role.
   */
  actingAs?: import('@prisma/client').Role;
  /**
   * true for head_office: sees every store of their organisation. It no longer
   * means "no filter" — `storeIds` is authoritative and organisation-bounded.
   */
  allStores: boolean;
  /**
   * Set when this principal is a MACHINE (a CaratOS Connect agent), not a person.
   *
   * The agent needs head-office-equivalent reach to bulk-write its organisation's
   * records, so it carries that role — but role alone cannot distinguish "the
   * owner signed in" from "a PC in a back office is pushing rows". Routes that
   * destroy data check this flag and refuse, because a token sitting on a shop
   * machine must never be able to wipe the tenant.
   *
   * Absent (undefined) for every human. Machines set it explicitly.
   */
  isMachine?: boolean;
  /** Which agent, when `isMachine` — for audit lines and log correlation. */
  agentId?: string;
  /** Hash of the exact agent token accepted at the request authentication edge. */
  agentTokenHash?: string;
  /** Server configuration generation observed at that same authentication edge. */
  agentConfigRevision?: string;
  /** Connector identity resolved from the enrolled agent, never request input. */
  connectorSourceSystem?: string;
  /**
   * The industry pack applied to this user's organisation, read in the same
   * query that already fetches the organisation's status — so the entitlement
   * gate costs no extra round trip.
   *
   * Null for a tenant that has never had a pack applied, which
   * `config/entitlements.ts` treats as "impose nothing".
   */
  industryPackCode?: string | null;
  /**
   * Modules this organisation has switched off, read in the same query as the
   * pack code so the entitlement gate still costs no extra round trip.
   *
   * Empty for almost every tenant. Present on the principal rather than fetched
   * in the guard because the guard runs on every request and must not query.
   */
  disabledCapabilities?: readonly string[];
}

/** @CurrentUser() — inject the resolved AuthUser into a controller method. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);
