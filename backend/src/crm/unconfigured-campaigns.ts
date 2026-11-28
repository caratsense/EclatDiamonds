/**
 * The campaigns bringing in enquiries that nothing is configured to answer.
 *
 * ## The incident
 *
 * The eight newest unrouted threads on 28 Nov all came from two adverts of one
 * campaign, "blue diamond 24/11", which has no rule. Routing was behaving
 * exactly as configured — no rule, no branch, no script — and the only thing
 * that said so was a `logger.warn("no campaign matched ad X")` in a container
 * log. The client is paying for those clicks and had no way to see it: from
 * the Bot Scripts screen the campaign simply does not exist, and "nothing is
 * listed" looks identical to "nothing is wrong".
 *
 * So the gap is shown where the scripts are written, with the count and the
 * most recent arrival, because those are the two numbers that turn "a campaign
 * is unconfigured" from something to deduce into something to read.
 *
 * ## Why the grouping is here and pure
 *
 * One campaign runs many adverts and a referral carries only the AD id, so the
 * rows start out per advert and have to be collapsed by campaign — otherwise a
 * campaign with six creatives reads as six problems. The collapsing is the
 * part worth being able to read on its own: the counts must add up, the newest
 * arrival must survive, and an advert Meta could not resolve must NOT vanish,
 * which is the mistake that would recreate the original silence inside the fix
 * for it.
 */

/** One advert that brought enquiries in, with whatever Meta could say about it. */
export interface UnscriptedAd {
  adId: string;
  /** Threads opened by this advert that matched no rule. */
  enquiries: number;
  /** When the most recent of them arrived. */
  lastEnquiryAt: Date;
  campaignId: string | null;
  /** Null when the ad id could not be resolved — see below. */
  campaignName: string | null;
}

/** A campaign paying for enquiries that no script answers. */
export interface UnconfiguredCampaign {
  /** Row identity: the campaign when Meta named one, else the advert itself. */
  key: string;
  campaignId: string | null;
  /** Null when the advert could not be resolved; `adIds` is then all there is. */
  campaignName: string | null;
  /** The adverts seen from it, newest arrival first. */
  adIds: string[];
  enquiries: number;
  lastEnquiryAt: string;
}

/**
 * Collapse adverts into the campaigns that ran them, newest arrival first.
 *
 * Newest first because the question being asked is "what is live and
 * unconfigured right now" — a campaign that stopped delivering a fortnight ago
 * is history, and burying today's under it is how the list stops being read.
 *
 * AN UNRESOLVED ADVERT IS STILL REPORTED, on its own row, named by nothing.
 * A deleted ad, an expired token or a Graph outage all answer "no campaign",
 * and dropping those rows would mean the clicks the client is paying for are
 * least visible exactly when the connection to Meta is broken — which is the
 * silence this list exists to end, reproduced one layer up.
 */
export function groupUnconfiguredCampaigns(ads: UnscriptedAd[]): UnconfiguredCampaign[] {
  // Newest advert first, so insertion order IS the answer's order and the first
  // row of each group carries the group's most recent arrival.
  const newestFirst = [...ads].sort(
    (a, b) => b.lastEnquiryAt.getTime() - a.lastEnquiryAt.getTime(),
  );

  const grouped = new Map<string, UnconfiguredCampaign>();
  for (const ad of newestFirst) {
    // Case-folded on the name because Meta's own campaign names come back
    // however they were typed, and two spellings of one campaign is one
    // campaign.
    const key =
      ad.campaignId ?? (ad.campaignName ? `name:${ad.campaignName.toLowerCase()}` : `ad:${ad.adId}`);
    const seen = grouped.get(key);
    if (!seen) {
      grouped.set(key, {
        key,
        campaignId: ad.campaignId,
        campaignName: ad.campaignName,
        adIds: [ad.adId],
        enquiries: ad.enquiries,
        lastEnquiryAt: ad.lastEnquiryAt.toISOString(),
      });
      continue;
    }
    seen.enquiries += ad.enquiries;
    if (!seen.adIds.includes(ad.adId)) seen.adIds.push(ad.adId);
  }

  return [...grouped.values()];
}
