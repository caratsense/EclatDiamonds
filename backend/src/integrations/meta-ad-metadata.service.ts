import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphClient } from './meta-graph.client';
import { META_ADS_PROVIDER_CODE } from './meta-asset-ownership.service';

/** What an ad id resolves to. Every field is optional — Meta may omit any of them. */
export interface MetaAdMetadata {
  adSetId: string | null;
  adSetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
}

interface CacheEntry {
  value: MetaAdMetadata | null;
  expiresAt: number;
}

/**
 * How long a successful lookup is trusted.
 *
 * An ad's ad set never changes — Meta does not allow an ad to move — and its
 * name changes about as often as a showroom opens. Six hours is short enough
 * that a rename is picked up the same working day and long enough that a
 * campaign delivering thousands of clicks costs a handful of Graph calls.
 */
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a FAILED lookup is remembered.
 *
 * Deliberately much shorter, and deliberately not zero. A deleted ad, a revoked
 * token or a Graph outage would otherwise put one failing request in front of
 * every inbound message from that ad — turning an ad-routing problem into a
 * messaging outage. Ten minutes is long enough to absorb a burst and short
 * enough that fixing the token restores routing without a redeploy.
 */
const FAILURE_TTL_MS = 10 * 60 * 1000;

/** Cap on remembered ads, so a long-running process cannot grow without bound. */
const MAX_ENTRIES = 5_000;

/**
 * Resolves a Meta ad id to the ad set and campaign it belongs to.
 *
 * ## Why this exists
 *
 * A Click-to-WhatsApp referral carries `source_id` — the AD id — and nothing
 * else. No ad set, no campaign, and no geography of any kind.
 *
 * Routing on the ad id alone means a rule per ad. A jewellery retailer runs a
 * new ad for every collection, so that is a config change every week per
 * showroom, and the failure mode of forgetting one is silent: those customers
 * land in the head-office queue and nobody notices for a fortnight.
 *
 * Resolving the ad to its AD SET lets one rule per showroom cover every ad that
 * showroom will ever run. The ad set name is the natural key because the
 * marketing team already names ad sets after the branch — "Lead Campaign Kala
 * Ghoda", "Lead Campaign Udaipur".
 *
 * ## Why not the ad's geographic targeting
 *
 * It was the obvious idea and it does not work. Measured against Éclat's real
 * account: six of their eight showroom ad sets carry NO geo targeting at all,
 * the Bandra ad set targets the whole of Mumbai, and four of their showrooms
 * (Bandra, Bandra Broadway, Kala Ghoda, Borivali) are in that one city.
 * Targeting cannot separate showrooms that share a city, and most of the time
 * it is not set.
 *
 * ## Failure is not an error
 *
 * Every path returns `null` rather than throwing. A lookup that fails means the
 * name-matching rules do not fire, which means no store is chosen, which means
 * the thread waits in the head-office queue. That is the correct outcome: a
 * guessed branch sends a customer to the wrong showroom, and nobody finds out
 * from the software.
 */
@Injectable()
export class MetaAdMetadataService {
  private readonly logger = new Logger(MetaAdMetadataService.name);

  /**
   * Process-local, deliberately not a table.
   *
   * A restart costs one Graph call per ad still in circulation, which is a few
   * dozen requests spread over the minutes after a deploy. Persisting it would
   * buy that back at the price of a schema, a migration and a staleness policy
   * — and the cache would then need invalidating when somebody renames an ad
   * set, which the TTL handles for free. Promote it to a table if the call
   * volume ever justifies the machinery; nothing outside this file would change.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
  ) {}

  /**
   * Resolve one ad id for one tenant, from cache when possible.
   *
   * Keyed by tenant as well as ad id: two organisations could in principle hold
   * the same ad id through different connections, and one tenant must never
   * read a name resolved with another's token.
   */
  async resolve(organisationId: string, adId: string): Promise<MetaAdMetadata | null> {
    const id = (adId ?? '').trim();
    // Meta ad ids are numeric. Refusing anything else keeps a hostile referral
    // out of a Graph path, which `MetaGraphClient` would reject anyway — this
    // is the cheaper of the two rejections and it never reaches the network.
    if (!/^\d{1,40}$/.test(id)) return null;

    const key = `${organisationId}:${id}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value = await this.fetch(organisationId, id);
    this.remember(key, value);
    return value;
  }

  private async fetch(organisationId: string, adId: string): Promise<MetaAdMetadata | null> {
    const integration = await this.prisma.integration.findFirst({
      where: {
        organisationId,
        providerCode: META_ADS_PROVIDER_CODE,
        status: { not: 'disabled' },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!integration) {
      // Not an error worth logging per message: a tenant with no Meta Ads
      // connection simply routes by ad id and tag, as it did before.
      return null;
    }

    try {
      const response = await this.graph.getForIntegration<GraphAdResponse>(
        organisationId,
        integration.id,
        adId,
        { fields: 'id,adset{id,name},campaign{id,name}' },
      );
      return {
        adSetId: text(response?.adset?.id),
        adSetName: text(response?.adset?.name),
        campaignId: text(response?.campaign?.id),
        campaignName: text(response?.campaign?.name),
      };
    } catch (error) {
      // The ad id is safe to log — it is already public in the ad's URL — and
      // without it a routing complaint cannot be traced back to one ad.
      this.logger.warn(
        `Could not resolve Meta ad ${adId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private remember(key: string, value: MetaAdMetadata | null) {
    if (this.cache.size >= MAX_ENTRIES) {
      // Oldest insertion first — Map preserves insertion order. Crude next to a
      // true LRU, and adequate: the working set is "ads currently being clicked",
      // which turns over on its own.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (value ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
    });
  }

  /** Drop everything. For tests, and for a rename that must be picked up now. */
  clearCache() {
    this.cache.clear();
  }
}

interface GraphAdResponse {
  id?: string;
  adset?: { id?: string; name?: string };
  campaign?: { id?: string; name?: string };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;
}
