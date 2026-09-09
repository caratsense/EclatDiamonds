import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { AuthUser } from './auth-user';
import { pathAllowedForPack } from '../config/entitlements';

/**
 * Industry entitlement gate (multi-market phase 2, MM-01).
 *
 * Runs alongside `RolesGuard`, and answers a different question. `RolesGuard`
 * asks "is this person senior enough?"; this asks "does this tenant's product
 * include this module at all?". A clinic's head of operations is as senior as it
 * gets and still has no Finance module.
 *
 * ## Why the path, and not a decorator
 *
 * The obvious design is `@Capability('finance')` on each controller. It was not
 * available: the vertical controllers belong to other owners, and scattering the
 * same annotation across twenty files is exactly the duplication the brief rules
 * out. One central registry (`config/entitlements.ts`) keyed by route prefix
 * keeps the whole policy legible in one screen and testable without a running
 * server — and, because it is a registry rather than a decorator, a test can
 * enumerate every controller in the tree and fail on one nobody classified.
 *
 * ## What it deliberately does NOT do
 *
 * It never touches machine principals. A CaratOS Connect agent is already
 * confined to the routes marked `@AllowMachine()` — ingestion, which is
 * universal — and re-deciding that here could only ever subtract from a contract
 * another agent owns. It also never runs when no principal was resolved, so
 * `@Public()` routes are unaffected.
 *
 * ## Universal routes are open; vertical modules fail closed
 *
 * A tenant with no resolvable pack keeps the whole universal suite, because the
 * registry answers "no capability required" for those paths before any pack is
 * consulted — which is what a half-finished onboarding needs. On a path the
 * registry classifies as vertical, an unresolvable pack is refused: the honest
 * answer to "does this organisation's industry include Finance?" when we cannot
 * tell is no, and the universal-outage risk that once argued for the opposite is
 * gone now that every controller is classified.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthUser | undefined;

    // No principal: a @Public() route, already decided by JwtAuthGuard.
    if (!user) return true;
    // A machine's reach is defined by @AllowMachine, not by an industry.
    if (user.isMachine) return true;

    // `originalUrl` first: it is the full request path including the controller
    // prefix, which is what the map is written against. `req.route.path` is the
    // matched pattern and, depending on how the router mounted, can arrive
    // without that prefix — matching a shorter string here would silently let a
    // gated route through.
    const path: string = req.originalUrl ?? req.url ?? '/';
    const verdict = pathAllowedForPack(user.industryPackCode, path);
    if (verdict.allowed) return true;

    // Names the module rather than the URL: the person reading this is an admin
    // wondering why a link 404s for their team, not an attacker probing.
    throw new ForbiddenException(
      `This module is not part of your organisation's industry setup. ` +
        `Ask an administrator to enable "${verdict.capability}" by changing your ` +
        `industry in Settings → Business configuration.`,
    );
  }
}
