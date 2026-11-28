/**
 * Which advert brought the most enquiries, and how many of those people wrote
 * back.
 *
 * ## The request
 *
 * The client, 28 Nov, in her own words: "is it possible to create a page where
 * I can see ki kaun se ad pe mujhe sabse zyada number of messages aa rahe
 * hain? Because I can see hum teen chaar ads run kar rahe hain, aur usme se
 * sab pe replies aa rahe hain. So I want like a count."
 *
 * She is running three or four adverts at once and every one of them produces
 * threads, so the inbox cannot tell her which one is worth the money. Nothing
 * here comes from Meta's reporting: the threads themselves are the measurement,
 * because they are the only record of a customer who actually arrived.
 *
 * ## Why ARRIVED and REPLIED are two different numbers
 *
 * A Click-to-WhatsApp tap sends a message on the customer's behalf — on the
 * enquiry-form adverts it arrives with their answers already filled in — so
 * every tap looks like a conversation and most of them are not one. Counting
 * taps alone would rank the advert that collects the most idle curiosity above
 * the one that brings people who want to buy.
 *
 * SO "REPLIED" MEANS THE CUSTOMER SENT A SECOND INBOUND MESSAGE. One inbound
 * is the arrival; a second is a person choosing to continue. The screen says
 * "wrote again" rather than "replied" so nobody reads it as our reply rate,
 * which is a different measure and already has its own screen (Response time).
 *
 * ## Why the grouping is pure
 *
 * One campaign runs several adverts and a referral carries only the AD id, so
 * the counts start per advert and have to be collapsed by campaign — the client
 * thinks in campaigns ("we have selected the whole campaign"), and a campaign
 * with four creatives otherwise reads as four unrelated adverts. The collapsing
 * is the part worth being able to read on its own: the counts must add up, the
 * ranking must not move when two adverts tie, and an advert Meta could not name
 * must NOT vanish — dropping it would under-count the exact thing she is
 * measuring, and would do so most when the Meta connection is broken.
 */

/** Default window. A month is the period the client reads her ad spend over. */
export const DEFAULT_WINDOW_DAYS = 30;
/**
 * The longest window this screen will answer for.
 *
 * The UI offers 7, 30 and 90. The cap exists because `?days=` is a query
 * parameter: a year of ad-originated threads is a report, and ten years is a
 * table scan somebody typed by accident.
 */
export const MAX_WINDOW_DAYS = 365;

/**
 * The window these counts cover, resolved once so the number on the screen and
 * the number in the query can never disagree.
 *
 * Clamped rather than refused, because an out-of-range `days` is worth a
 * report over the nearest sane window, not a 400 on a read. The boundary is
 * INCLUSIVE at `since` (the query is `createdAt >= since`), so a thread that
 * arrived exactly seven days ago is inside the seven-day window — a reader
 * comparing this screen with the inbox counts that thread, and a report that
 * silently excluded it would be one short with no way to tell why.
 */
export function enquiryWindow(
  days: number | undefined,
  now: Date = new Date(),
): { windowDays: number; since: Date } {
  // A missing or unreadable `days` is the default window, not zero days — the
  // DTO rejects both already, and this is what keeps a direct caller honest.
  const asked = Number.isFinite(days) ? Math.floor(days as number) : DEFAULT_WINDOW_DAYS;
  const windowDays = Math.min(Math.max(asked, 1), MAX_WINDOW_DAYS);
  return { windowDays, since: new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000) };
}

/** Enquiries from one advert that landed at one branch (or at none). */
export interface AdEnquiryTally {
  adId: string;
  /** Null for a thread no routing rule placed — see `unrouted` below. */
  storeId: string | null;
  storeName: string | null;
  /** Threads this advert opened in the window. */
  enquiries: number;
  /** How many of them carry a second inbound message. */
  replied: number;
}

/** What Meta could say about an advert, or null when it could say nothing. */
export interface ResolvedAdvert {
  campaignId: string | null;
  campaignName: string | null;
  adSetName: string | null;
}

/** One branch's share of an advert's or a campaign's enquiries. */
export interface AdEnquiryBranch {
  storeId: string;
  /** Null when the branch row is gone; the id is then all there is to show. */
  storeName: string | null;
  enquiries: number;
  replied: number;
}

export interface AdEnquiryAdvert {
  adId: string;
  /**
   * The ad set, which is how the marketing team names a branch ("Lead Campaign
   * Kala Ghoda"). Null when Meta would not say.
   */
  adSetName: string | null;
  enquiries: number;
  replied: number;
  /** Null when nothing arrived — a percentage of nothing is not 0%. */
  repliedPct: number | null;
  /** Enquiries that reached no branch at all. The 167-thread column. */
  unrouted: number;
  branches: AdEnquiryBranch[];
  /**
   * False when Meta told us nothing about this advert. It is still listed, with
   * its id — a deleted ad, an expired token and a Graph outage all answer "no
   * campaign", and those are the moments the client most needs to see that
   * clicks are still arriving.
   */
  named: boolean;
}

export interface AdEnquiryCampaign {
  /** Row identity: the campaign when Meta named one, else the advert itself. */
  key: string;
  campaignId: string | null;
  /** Null when the advert could not be resolved; `adverts` is then all there is. */
  campaignName: string | null;
  enquiries: number;
  replied: number;
  repliedPct: number | null;
  unrouted: number;
  branches: AdEnquiryBranch[];
  /** The campaign's adverts, best first. */
  adverts: AdEnquiryAdvert[];
}

/**
 * How many of the people an advert brought actually wrote again, as a whole
 * percent.
 *
 * NULL rather than 0 when nothing arrived. "0% of nobody replied" reads as a
 * failing advert on a screen built to rank adverts, which is the one mistake
 * this number must not make.
 */
export function repliedPct(enquiries: number, replied: number): number | null {
  if (enquiries <= 0) return null;
  return Math.round((replied / enquiries) * 100);
}

/**
 * Collapse per-advert, per-branch tallies into campaigns with their adverts
 * beneath, most enquiries first.
 *
 * Ranked by arrivals rather than by replies because that is the question as it
 * was asked ("sabse zyada number of messages"), and because the reply count is
 * right beside it for anybody who would rather rank by that.
 *
 * TIES ARE BROKEN BY ID, never left to the order the rows came back in. A
 * Postgres GROUP BY promises nothing about the order of equal counts, so two
 * adverts on four enquiries each would otherwise swap places between two
 * refreshes of the same window and make the whole ranking look untrustworthy.
 */
export function groupAdEnquiries(
  tallies: AdEnquiryTally[],
  resolved: ReadonlyMap<string, ResolvedAdvert | null>,
): AdEnquiryCampaign[] {
  const adverts = new Map<string, AdEnquiryAdvert>();
  for (const row of tallies) {
    const meta = resolved.get(row.adId) ?? null;
    let advert = adverts.get(row.adId);
    if (!advert) {
      advert = {
        adId: row.adId,
        adSetName: meta?.adSetName ?? null,
        enquiries: 0,
        replied: 0,
        repliedPct: null,
        unrouted: 0,
        branches: [],
        // Named by anything at all — a campaign or just an ad set. A campaign
        // Meta answered with an empty name is no more use than silence.
        named: !!(meta?.campaignId || meta?.campaignName || meta?.adSetName),
      };
      adverts.set(row.adId, advert);
    }
    advert.enquiries += row.enquiries;
    advert.replied += row.replied;
    if (row.storeId === null) {
      advert.unrouted += row.enquiries;
    } else {
      addBranch(advert.branches, row.storeId, row.storeName, row.enquiries, row.replied);
    }
  }

  const campaigns = new Map<string, AdEnquiryCampaign>();
  for (const advert of adverts.values()) {
    const meta = resolved.get(advert.adId) ?? null;
    /*
     * Case-folded on the name, as the unconfigured-campaigns list already does:
     * Meta returns a campaign name however it was typed, and two spellings of
     * one campaign is one campaign. An advert with no name of any kind is its
     * OWN row — merging those under a shared "no campaign" heading would invent
     * a campaign that does not exist.
     */
    const key =
      meta?.campaignId ??
      (meta?.campaignName ? `name:${meta.campaignName.toLowerCase()}` : `ad:${advert.adId}`);
    let campaign = campaigns.get(key);
    if (!campaign) {
      campaign = {
        key,
        campaignId: meta?.campaignId ?? null,
        campaignName: meta?.campaignName ?? null,
        enquiries: 0,
        replied: 0,
        repliedPct: null,
        unrouted: 0,
        branches: [],
        adverts: [],
      };
      campaigns.set(key, campaign);
    }
    campaign.enquiries += advert.enquiries;
    campaign.replied += advert.replied;
    campaign.unrouted += advert.unrouted;
    campaign.adverts.push(advert);
    for (const branch of advert.branches) {
      addBranch(campaign.branches, branch.storeId, branch.storeName, branch.enquiries, branch.replied);
    }
  }

  const ranked = [...campaigns.values()];
  for (const campaign of ranked) {
    campaign.repliedPct = repliedPct(campaign.enquiries, campaign.replied);
    campaign.branches.sort(byEnquiries((b) => b.storeId));
    campaign.adverts.sort(byEnquiries((a) => a.adId));
    for (const advert of campaign.adverts) {
      advert.repliedPct = repliedPct(advert.enquiries, advert.replied);
      advert.branches.sort(byEnquiries((b) => b.storeId));
    }
  }
  ranked.sort(byEnquiries((c) => c.key));
  return ranked;
}

function addBranch(
  branches: AdEnquiryBranch[],
  storeId: string,
  storeName: string | null,
  enquiries: number,
  replied: number,
) {
  const seen = branches.find((b) => b.storeId === storeId);
  if (seen) {
    seen.enquiries += enquiries;
    seen.replied += replied;
    // A name we have beats a name we do not; the branch row may be missing for
    // one tally and present for another.
    seen.storeName = seen.storeName ?? storeName;
    return;
  }
  branches.push({ storeId, storeName, enquiries, replied });
}

/** Most enquiries first, then by a stable id so equal counts never reorder. */
function byEnquiries<T extends { enquiries: number }>(id: (row: T) => string) {
  return (a: T, b: T) => b.enquiries - a.enquiries || id(a).localeCompare(id(b));
}
