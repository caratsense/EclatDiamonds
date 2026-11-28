import { Injectable } from '@nestjs/common';

import { MetaAdMetadataService } from '../integrations/meta-ad-metadata.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdSetRulesService, resolveAdSetRule } from './adset-rules.service';
import {
  groupUnconfiguredCampaigns,
  type UnconfiguredCampaign,
  type UnscriptedAd,
} from './unconfigured-campaigns';

/**
 * How far back an unconfigured campaign is worth reporting.
 *
 * A month, because a campaign that stopped delivering before that is history
 * and a list that never clears is a list nobody reads. Short enough that
 * everything on it is still worth configuring, long enough that a campaign
 * someone launched three weeks ago and forgot is still on it.
 */
const WINDOW_DAYS = 30;

/**
 * Adverts resolved per request, at most.
 *
 * Each unresolved ad id costs one Graph call, cached for six hours by
 * `MetaAdMetadataService`. Twenty-five is far more than the handful of live
 * campaigns a jewellery chain runs at once, and it stops a tenant with a long
 * tail of dead adverts turning this screen into a minute of Graph traffic.
 */
const MAX_ADS = 25;

/**
 * Which campaigns have brought in enquiries that no script answers.
 *
 * Derived from the threads themselves — `Conversation.sourceAdId` where
 * `matchedRuleId` is null — rather than from anything Meta reports, because the
 * question is not "which campaigns exist" (the editor's picker already answers
 * that) but "which campaigns have sent us real customers nobody is answering".
 * Only the threads can say that.
 */
@Injectable()
export class UnconfiguredCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: AdSetRulesService,
    private readonly adMetadata: MetaAdMetadataService,
  ) {}

  async list(organisationId: string): Promise<{
    campaigns: UnconfiguredCampaign[];
    /** The window these counts cover, so the screen can say what it is showing. */
    sinceDays: number;
  }> {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const perAd = await this.prisma.conversation.groupBy({
      by: ['sourceAdId'],
      where: {
        organisationId,
        // The whole definition of the gap: an advert brought them in and no
        // rule claimed them.
        matchedRuleId: null,
        sourceAdId: { not: null },
        createdAt: { gte: since },
      },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: MAX_ADS,
    });

    const rules = await this.rules.list(organisationId);
    const ads: UnscriptedAd[] = [];
    for (const row of perAd) {
      const adId = row.sourceAdId;
      if (!adId) continue;
      const meta = await this.adMetadata.resolve(organisationId, adId);
      /*
       * A rule added AFTER those threads arrived is not a gap.
       *
       * `matchedRuleId` records what matched on the day the thread opened, so
       * the campaign the client configured this morning would otherwise stay on
       * this list for a month, sending her to configure what is already
       * configured — and a list with nothing to act on is the one that gets
       * ignored when something real appears.
       *
       * Asked of the same resolver routing itself uses, so the screen and the
       * router can never disagree about whether an advert is covered.
       */
      if (
        resolveAdSetRule(rules, {
          adId,
          adSetId: meta?.adSetId ?? undefined,
          adSetName: meta?.adSetName ?? undefined,
          campaignId: meta?.campaignId ?? undefined,
          campaignName: meta?.campaignName ?? undefined,
        })
      ) {
        continue;
      }
      ads.push({
        adId,
        enquiries: row._count._all,
        // `_max.createdAt` cannot be null for a group that exists; the window's
        // start is the honest floor rather than a thrown error on a read.
        lastEnquiryAt: row._max.createdAt ?? since,
        campaignId: meta?.campaignId ?? null,
        campaignName: meta?.campaignName ?? null,
      });
    }

    return { campaigns: groupUnconfiguredCampaigns(ads), sinceDays: WINDOW_DAYS };
  }
}
