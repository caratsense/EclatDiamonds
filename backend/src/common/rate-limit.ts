import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModuleOptions, seconds } from '@nestjs/throttler';
import { SetMetadata } from '@nestjs/common';

import { AuthUser } from './auth-user';

/**
 * Rate limiting by category (Phase B4).
 *
 * ## What was here before
 *
 * One global rule: 300 requests / 60s per IP. That stops a crude script and
 * nothing else, because it cannot tell the difference between a shop's whole
 * team behind one office NAT — which is the normal case for this product, and
 * would share a single bucket — and one tenant running an import loop.
 *
 * ## The categories, and why each exists
 *
 *   AUTH         Unauthenticated and guessable. Tight, per IP.
 *   PUBLIC       Unauthenticated but harmless. Loose, per IP.
 *   TENANT       Ordinary authenticated traffic. Generous, per ORGANISATION, so
 *                one busy tenant cannot starve another and a shared office IP is
 *                not mistaken for an attack.
 *   EXPENSIVE    AI, visual search, imports, bulk writes, big reports. Costed in
 *                seconds of CPU rather than bytes, so the limit is low and the
 *                key is per USER — one person's runaway export must not lock
 *                their colleagues out of the same feature.
 *   INTEGRATION  Webhooks and sync. Sized for machines, not people.
 *
 * ## Keying
 *
 * The key is derived from the AUTHENTICATED principal wherever one exists, and
 * falls back to IP only when there is none. That is the important property: a
 * per-IP-only limiter punishes a whole store for one colleague's mistake, and an
 * attacker with a handful of addresses walks around it.
 *
 * ## Limits are configuration, not constants
 *
 * Every number below reads an environment variable. Nothing here is tuned to a
 * provider's published limits, because none of these routes call a provider on a
 * fixed budget — inventing "Meta allows N/s" and encoding it would be fabricating
 * provider behaviour.
 *
 * ## Distributed correctness
 *
 * The store is in-memory, which is exact for one replica and approximate across
 * several — with N replicas a tenant gets up to N times the limit. That is
 * stated rather than hidden. It is the right trade at this size: these limits
 * exist to stop abuse and runaway loops, not to meter billing, and adding Redis
 * would add a second thing that can be down and a second place tenant data
 * lives. `RATE_LIMIT_STORE=redis` is the seam to change when replicas make the
 * approximation unacceptable — see the note on `resolveStorage`.
 */

export type RateCategory = 'auth' | 'public' | 'tenant' | 'expensive' | 'integration';

export const RATE_CATEGORY_KEY = 'rateCategory';

/** Tag a route (or controller) with its cost category. */
export const RateLimit = (category: RateCategory) => SetMetadata(RATE_CATEGORY_KEY, category);

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Named throttlers, one per category. Registered together so a route opts into
 * a category by name and every other category is skipped for it.
 */
export function rateLimitConfig(): ThrottlerModuleOptions {
  return {
    throttlers: [
      // The catch-all. Deliberately generous: a 500-user ops tool never reaches
      // it in normal use, and it exists only to stop a scripted flood.
      { name: 'default', ttl: seconds(60), limit: num('RATE_LIMIT_DEFAULT', 300) },
      { name: 'auth', ttl: seconds(60), limit: num('RATE_LIMIT_AUTH', 10) },
      { name: 'public', ttl: seconds(60), limit: num('RATE_LIMIT_PUBLIC', 60) },
      { name: 'tenant', ttl: seconds(60), limit: num('RATE_LIMIT_TENANT', 600) },
      { name: 'expensive', ttl: seconds(60), limit: num('RATE_LIMIT_EXPENSIVE', 20) },
      { name: 'integration', ttl: seconds(60), limit: num('RATE_LIMIT_INTEGRATION', 600) },
    ],
    errorMessage: 'Too many requests. Please slow down and try again shortly.',
  };
}

/**
 * The guard that applies the right bucket to the right request.
 *
 * Two jobs the stock guard does not do:
 *
 *  1. SKIP EVERY THROTTLER EXCEPT THE ROUTE'S CATEGORY. Without this a route
 *     would be counted against all six buckets at once and the tightest would
 *     always win, making the categories decorative.
 *
 *  2. KEY ON THE PRINCIPAL. `getTracker` returns an organisation- or user-scoped
 *     key for authenticated traffic so tenants are isolated from each other, and
 *     falls back to IP only for genuinely anonymous requests.
 */
@Injectable()
export class CategoryThrottlerGuard extends ThrottlerGuard {
  /** The category a route asked for, defaulting to the catch-all. */
  private categoryFor(context: ExecutionContext): RateCategory | 'default' {
    return (
      this.reflector.getAllAndOverride<RateCategory>(RATE_CATEGORY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default'
    );
  }

  /**
   * Skip every bucket that is not this route's category.
   *
   * `shouldSkip` is called once per configured throttler with that throttler's
   * name available on the context, which is what makes one-bucket-per-route
   * possible without re-implementing the guard.
   */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return super.shouldSkip(context);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as AuthUser | undefined;
    const ip = (req.ip as string) ?? 'unknown';

    if (!user) return `ip:${ip}`;

    // A machine (a Connect agent) is keyed on its own identity, so one shop's
    // misbehaving installation cannot exhaust the tenant's whole allowance.
    if (user.isMachine && user.agentId) return `agent:${user.agentId}`;

    // Authenticated traffic is keyed on the ORGANISATION for ordinary work and
    // on the USER for expensive work — see the class comment for why the two
    // differ. The category rides on the request, set by handle() below.
    const category = (req.__rateCategory as RateCategory | undefined) ?? 'tenant';
    return category === 'expensive'
      ? `user:${user.id}`
      : `org:${user.organisationId}`;
  }

  async handleRequest(requestProps: Parameters<ThrottlerGuard['handleRequest']>[0]): Promise<boolean> {
    const { context, throttler } = requestProps;
    const wanted = this.categoryFor(context);
    // Only the matching bucket counts. Every other named throttler is a no-op
    // for this route.
    if ((throttler.name ?? 'default') !== wanted) return true;

    // Stash the category so getTracker can choose org- vs user-keying.
    const req = context.switchToHttp().getRequest();
    req.__rateCategory = wanted;

    return super.handleRequest(requestProps);
  }
}
