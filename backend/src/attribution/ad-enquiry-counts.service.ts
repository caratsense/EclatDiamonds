import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { MetaAdMetadataService } from '../integrations/meta-ad-metadata.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  enquiryWindow,
  groupAdEnquiries,
  repliedPct,
  type AdEnquiryCampaign,
  type AdEnquiryTally,
  type ResolvedAdvert,
} from './ad-enquiry-counts';

/**
 * Adverts resolved against Meta per request, at most.
 *
 * Each advert the resolver has not seen for six hours costs one Graph call
 * (`MetaAdMetadataService` caches both answers and failures). Fifty is far more
 * than the "teen chaar ads" the client runs at once and more than a quarter's
 * worth of creatives, and it stops a tenant with a long tail of retired
 * adverts turning this screen into a minute of Graph traffic. The adverts that
 * miss the cap are the smallest ones and are still LISTED — they are reported
 * unnamed, with their ids, never dropped.
 */
const MAX_ADS_RESOLVED = 50;

/** One row of the aggregate: an advert's enquiries at one branch, or at none. */
interface TallyRow {
  ad_id: string;
  store_id: string | null;
  enquiries: bigint;
  replied: bigint;
}

export interface AdEnquiryReport {
  windowDays: number;
  since: string;
  /** The branches these counts cover, so the screen can say whose numbers they are. */
  storeIds: string[];
  /**
   * Whether enquiries that reached NO branch are inside these numbers. Head
   * office on "All Stores" only — see `branchScope` for why.
   */
  includesUnrouted: boolean;
  totals: {
    enquiries: number;
    replied: number;
    repliedPct: number | null;
    unrouted: number;
    adverts: number;
    campaigns: number;
  };
  campaigns: AdEnquiryCampaign[];
  /**
   * Adverts past `MAX_ADS_RESOLVED` that were counted but not looked up. Listed
   * so the screen can say why a row carries an id instead of a campaign name,
   * rather than leaving it to look like a broken Meta connection.
   */
  advertsNotLookedUp: number;
}

/**
 * Which advert is bringing the most enquiries (client, 28 Nov).
 *
 * ## Why it lives in `attribution/` and not in `crm/`
 *
 * This is the same question `attribution/meta-ads/performance` answers about
 * money — "what did this advert produce" — so it belongs on the same route
 * family and behind the same `store_manager` gate. The CRM's
 * `UnconfiguredCampaignsService` counts the same threads but to answer a
 * different question (which campaigns nobody has scripted) and it is read from
 * the editor where that gap is closed; this is a report, and a manager looking
 * for one looks under Reports. The grouping shape is borrowed from it rather
 * than re-invented, which is why an unresolvable advert behaves identically on
 * both screens.
 *
 * ## No spend, and that is deliberate
 *
 * Nothing here states cost, cost-per-enquiry or ROAS. `MetaAdsInsightsService`
 * can supply measured spend, but only for an explicit ad-account and date
 * window the caller names, and only for days `AdSpendCoverage` records as
 * actually fetched — it cannot answer "the last 7 days" for whatever accounts
 * happen to be connected. A cost-per-lead figure assembled from a window that
 * was never fetched would be a made-up number about real money, so the screen
 * sends her to the performance view for spend instead of guessing it here.
 */
@Injectable()
export class AdEnquiryCountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly adMetadata: MetaAdMetadataService,
  ) {}

  async report(
    user: AuthUser,
    opts: { storeId?: string; days?: number } = {},
  ): Promise<AdEnquiryReport> {
    const { windowDays, since } = enquiryWindow(opts.days);
    // Throws if the caller named a branch outside their scope, rather than
    // quietly widening to everything they can see.
    const storeIds = this.scope.effectiveStoreIds(user, opts.storeId);
    const includesUnrouted = this.includesUnrouted(user, opts.storeId);

    const empty: AdEnquiryReport = {
      windowDays,
      since: since.toISOString(),
      storeIds,
      includesUnrouted,
      totals: {
        enquiries: 0,
        replied: 0,
        repliedPct: null,
        unrouted: 0,
        adverts: 0,
        campaigns: 0,
      },
      campaigns: [],
      advertsNotLookedUp: 0,
    };
    // A person assigned to no branch at all reads nothing — an empty `IN ()`
    // would be a SQL error, and widening to the organisation would hand them
    // the chain.
    if (!storeIds.length && !includesUnrouted) return empty;

    const rows = await this.tally(user.organisationId, since, storeIds, includesUnrouted);
    if (!rows.length) return empty;

    const tallies = await this.withBranchNames(user.organisationId, rows);
    const resolved = await this.resolveAdverts(user.organisationId, tallies);
    const campaigns = groupAdEnquiries(tallies, resolved);

    const enquiries = tallies.reduce((n, t) => n + t.enquiries, 0);
    const replied = tallies.reduce((n, t) => n + t.replied, 0);
    const adIds = new Set(tallies.map((t) => t.adId));
    return {
      ...empty,
      totals: {
        enquiries,
        replied,
        repliedPct: repliedPct(enquiries, replied),
        unrouted: tallies.reduce((n, t) => n + (t.storeId === null ? t.enquiries : 0), 0),
        adverts: adIds.size,
        campaigns: campaigns.length,
      },
      campaigns,
      advertsNotLookedUp: Math.max(adIds.size - MAX_ADS_RESOLVED, 0),
    };
  }

  /**
   * Who may read an enquiry that reached no branch.
   *
   * The same rule the inbox follows (`ConversationsService.visibility` and its
   * `branchClause`), and for the same two reasons. A thread at no branch
   * belongs to nobody yet, so it fails closed to head office — otherwise every
   * one of eleven managers reads the same unplaced enquiries as if they were
   * theirs. And a CHOSEN branch means that branch (client, 28 Nov: "when she
   * clicks on Mumbai Bandra only the Mumbai Bandra chats should be there"), so
   * picking one drops the unrouted column rather than adding other people's
   * strays to a branch's figures.
   *
   * The consequence is stated on the screen: a manager's "no branch" count is
   * zero because those enquiries are not theirs to see, not because there are
   * none.
   */
  private includesUnrouted(user: AuthUser, requestedStoreId?: string): boolean {
    if (requestedStoreId && requestedStoreId !== 'all') return false;
    return user.role === 'head_office';
  }

  /**
   * Enquiries per advert per branch, and how many of them were written to
   * twice, in one pass over the ad-originated threads.
   *
   * Raw SQL because the reply count needs a per-thread HAVING over its inbound
   * messages, which Prisma cannot express without first reading every thread
   * id into the process — and a report that reads rows into memory to count
   * them is one `take:` away from reporting a page as the truth. The correlated
   * count rides the `Message(conversationId, sentAt)` index, once per
   * ad-originated thread in the window and never once per message in the table.
   */
  private async tally(
    organisationId: string,
    since: Date,
    storeIds: string[],
    includesUnrouted: boolean,
  ): Promise<TallyRow[]> {
    const branches = storeIds.length
      ? Prisma.sql`c."storeId" IN (${Prisma.join(storeIds)})`
      : Prisma.sql`FALSE`;
    const branchScope = includesUnrouted
      ? Prisma.sql`(${branches} OR c."storeId" IS NULL)`
      : branches;

    return this.prisma.$queryRaw<TallyRow[]>(Prisma.sql`
      SELECT t.ad_id,
             t.store_id,
             COUNT(*)::bigint AS enquiries,
             COUNT(*) FILTER (WHERE t.inbound > 1)::bigint AS replied
      FROM (
        SELECT c."sourceAdId" AS ad_id,
               c."storeId"    AS store_id,
               (
                 SELECT COUNT(*)
                 FROM "Message" m
                 WHERE m."conversationId" = c."id"
                   AND m."direction" = 'inbound'
               ) AS inbound
        FROM "Conversation" c
        WHERE c."organisationId" = ${organisationId}
          -- Staff notice threads go out through the same outbox and are not
          -- customers who answered an advert.
          AND c."audience" = 'customer'
          AND c."sourceAdId" IS NOT NULL
          AND c."createdAt" >= ${since}
          AND ${branchScope}
      ) t
      GROUP BY t.ad_id, t.store_id
    `);
  }

  /** Branch ids carry no meaning on a screen; the names do. */
  private async withBranchNames(
    organisationId: string,
    rows: TallyRow[],
  ): Promise<AdEnquiryTally[]> {
    const storeIds = [...new Set(rows.map((r) => r.store_id).filter((id): id is string => !!id))];
    const stores = storeIds.length
      ? await this.prisma.store.findMany({
          where: { id: { in: storeIds }, organisationId },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(stores.map((s) => [s.id, s.name]));
    return rows.map((r) => ({
      adId: r.ad_id,
      storeId: r.store_id,
      storeName: r.store_id ? (names.get(r.store_id) ?? null) : null,
      enquiries: Number(r.enquiries),
      replied: Number(r.replied),
    }));
  }

  /**
   * Ask Meta what each advert is, busiest advert first.
   *
   * Busiest first because the cap has to bite somewhere, and the advert at the
   * top of the ranking is the one she opened the screen to read. A null answer
   * — a deleted ad, an expired token, a Graph outage, or an advert past the cap
   * — leaves the row named by its id and nothing else, which is what
   * `groupAdEnquiries` reports as `named: false`.
   */
  private async resolveAdverts(
    organisationId: string,
    tallies: AdEnquiryTally[],
  ): Promise<Map<string, ResolvedAdvert | null>> {
    const perAd = new Map<string, number>();
    for (const t of tallies) perAd.set(t.adId, (perAd.get(t.adId) ?? 0) + t.enquiries);
    const busiestFirst = [...perAd.entries()]
      .sort(([aId, a], [bId, b]) => b - a || aId.localeCompare(bId))
      .slice(0, MAX_ADS_RESOLVED)
      .map(([adId]) => adId);

    const resolved = new Map<string, ResolvedAdvert | null>();
    for (const adId of busiestFirst) {
      const meta = await this.adMetadata.resolve(organisationId, adId);
      resolved.set(
        adId,
        meta
          ? {
              campaignId: meta.campaignId,
              campaignName: meta.campaignName,
              adSetName: meta.adSetName,
            }
          : null,
      );
    }
    return resolved;
  }
}
