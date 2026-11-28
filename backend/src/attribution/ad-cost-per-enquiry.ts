import { Prisma } from '@prisma/client';

import { decimalOrZero } from './meta-ads-insights.util';

/**
 * What each WhatsApp enquiry cost.
 *
 * ## The request
 *
 * The client, 28 Nov, runs three or four adverts at once and cannot tell which
 * one is worth the money. `ad-enquiry-counts.ts` answers how many enquiries
 * each advert brought; this answers what she paid for them. The two are
 * deliberately separate modules: the count needs no Meta connection and must
 * keep working when the token expires, and the money must never be able to
 * change the count.
 *
 * ## META'S "LEADS" AND OUR ENQUIRIES ARE NOT THE SAME NUMBER
 *
 * Measured against her live account on 28 Nov, for campaign
 * "blue diamond 24/11": Meta reports 3 `onsite_conversion.lead` actions. We
 * hold 167 WhatsApp enquiries from that same campaign.
 *
 * Both are correct. Meta counts lead-FORM submissions; we count people who
 * actually wrote to us on WhatsApp. They are different events, and a
 * Click-to-WhatsApp advert produces the second without ever producing the
 * first. So the two are kept in separate objects on every row — `meta` and
 * `ours` — and nothing in this file adds them, averages them, prefers one, or
 * divides one into the other. A single blended "leads" figure would look
 * authoritative on a screen about real money and would not be true.
 *
 * ## The window, stated once
 *
 * Meta reports spend against the days IT delivered on, by its own attribution
 * rules. We count enquiries by `Conversation.createdAt`. These do not line up:
 * a tap on the 29th that writes to us on the 2nd is spend in one bucket and an
 * enquiry in another.
 *
 * The honest definition chosen here, rather than papering over it: ONE
 * account-local calendar window, read on two clocks. Spend is what Meta
 * attributes to delivery on `dateFrom..dateTo` in the ad account's timezone;
 * enquiries are threads created within the UTC instants those same local days
 * span. Nothing is shifted, padded or re-attributed to close the gap — doing so
 * would invent an attribution model nobody specified and leave the enquiry
 * count unable to be reconciled with the inbox. The gap is returned in
 * `window` instead, labelled, so the screen can say it out loud.
 *
 * And because both halves must be the SAME window for a division to mean
 * anything, both snapshots carry the instants they were counted over. If they
 * disagree every cost is null with status `window_mismatch`. That is the check
 * most worth having: a rolling "last 30 days" enquiry count divided by a
 * calendar month of spend produces a plausible number about two different
 * periods.
 *
 * ## Zero means free; null means unknown
 *
 * An advert with spend and no enquiries has no cost per enquiry — not an
 * infinite one, and certainly not 0.00. An advert with enquiries and no spend
 * (organic reach, or a window it did not deliver in) has none either. An ad
 * Meta would not resolve, a failed insights call and a paused advert with no
 * rows in the window are all "not known". Every one of those returns null with
 * a status naming which it was, and a campaign holding even one of them is
 * marked `partial` rather than summed as if the missing adverts were free.
 */

/** What Meta reported for one advert over the window, already validated. */
export interface AdSpend {
  adId: string;
  adName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  /** A decimal STRING in the snapshot's currency. Never a JS number. */
  spend: string;
  /** A 64-bit count, so a string — it is never arithmetic against money. */
  impressions: string | null;
  /** Meta's OWN lead-form count. Not our enquiries. See the header. */
  leads: number | null;
  linkClicks: number | null;
}

/** Everything Meta would say about one ad account over one window. */
export interface AdSpendSnapshot {
  /** The account-local calendar window asked of Meta. */
  dateFrom: string;
  dateTo: string;
  timezone: string;
  /**
   * The UTC instants those local days span. The enquiry side must have been
   * counted over exactly these, which is what `sameWindow` checks.
   */
  from: string;
  to: string;
  /** The AD ACCOUNT's currency, read from Meta. Never assumed to be INR. */
  currency: string;
  /**
   * False when the insights call did not answer. NOTHING is then known about
   * any advert's spend, which is not the same as every advert spending zero.
   */
  available: boolean;
  unavailableReason: string | null;
  adverts: AdSpend[];
}

/**
 * Our own count for one advert.
 *
 * Structurally what `AdEnquiryReport` already produces per advert, restated
 * here rather than imported so this file has no opinion about how the count is
 * gathered and can be tested without it.
 */
export interface AdEnquiryCount {
  adId: string;
  campaignId: string | null;
  campaignName: string | null;
  /** Threads this advert opened in the window. */
  enquiries: number;
  /** How many of those customers wrote a second time — not our reply rate. */
  replied: number;
}

export interface AdEnquirySnapshot {
  /** The instants these counts cover, for the `sameWindow` check. */
  from: string;
  to: string;
  adverts: AdEnquiryCount[];
}

/** How much of the money is known. `partial` can only happen to a campaign. */
export type AdSpendStatus = 'measured' | 'partial' | 'not_returned' | 'spend_unavailable';

/** Why there is no cost figure, when there is not one. */
export type AdCostStatus =
  | 'measured'
  | 'window_mismatch'
  | 'spend_unknown'
  | 'incomplete_spend'
  | 'no_spend'
  | 'no_enquiries'
  | 'no_replies';

/** Meta's side of a row. Every number here came from Meta. */
export interface AdCostMetaSide {
  /** Null whenever `status` is not `measured` — never 0.00 to stand in for it. */
  spend: string | null;
  impressions: string | null;
  /** Meta's lead-form submissions, kept apart from `ours.enquiries`. */
  leads: number | null;
  linkClicks: number | null;
  status: AdSpendStatus;
}

/** Our side of a row. Every number here came from our own inbox. */
export interface AdCostOurSide {
  enquiries: number;
  replied: number;
}

export interface AdCostAdvert {
  adId: string;
  /** Meta's creative name ("blue diamond 24/11 broad"). Null when unresolved. */
  adName: string | null;
  meta: AdCostMetaSide;
  ours: AdCostOurSide;
  costPerEnquiry: string | null;
  costPerEnquiryStatus: AdCostStatus;
  costPerReply: string | null;
  costPerReplyStatus: AdCostStatus;
}

export interface AdCostCampaign {
  /** Row identity: the campaign when either side named one, else the advert. */
  key: string;
  campaignId: string | null;
  campaignName: string | null;
  meta: AdCostMetaSide;
  ours: AdCostOurSide;
  costPerEnquiry: string | null;
  costPerEnquiryStatus: AdCostStatus;
  costPerReply: string | null;
  costPerReplyStatus: AdCostStatus;
  adverts: AdCostAdvert[];
}

/** The window, said out loud, because the two halves of it are not the same. */
export interface AdCostWindow {
  dateFrom: string;
  dateTo: string;
  timezone: string;
  spendFrom: string;
  spendTo: string;
  enquiryFrom: string;
  enquiryTo: string;
  /** What Meta's number is about: the days it delivered on. */
  spendBasis: 'meta_delivery_day';
  /** What ours is about: when the customer actually wrote to us. */
  enquiryBasis: 'conversation_created_at';
  /** False makes every cost null: two periods cannot be divided into each other. */
  sameWindow: boolean;
}

export interface AdCostReport {
  window: AdCostWindow;
  /** The ad account's currency. Nothing here is converted into another. */
  currency: string;
  spendAvailable: boolean;
  spendUnavailableReason: string | null;
  totals: {
    meta: AdCostMetaSide;
    ours: AdCostOurSide;
    costPerEnquiry: string | null;
    costPerEnquiryStatus: AdCostStatus;
    costPerReply: string | null;
    costPerReplyStatus: AdCostStatus;
    adverts: number;
    campaigns: number;
  };
  campaigns: AdCostCampaign[];
  note: string;
}

const NOTE =
  "Meta's spend and our enquiry counts are two separate measurements and are never combined. " +
  "Meta's 'leads' are lead-form submissions; ours are customers who wrote to us on WhatsApp — " +
  'a Click-to-WhatsApp advert produces the second without producing the first, so the two ' +
  'numbers differ by design and neither is adjusted to match the other. Spend covers the days ' +
  'Meta delivered on; enquiries cover when the customer wrote, over the same account-local ' +
  'window. A cost is null, never zero, whenever spend is unknown, incomplete, or nil, and ' +
  'whenever nothing arrived to divide it by. No currency conversion is performed.';

/** What one advert looks like while both sides are still being collected. */
interface AdvertBuild {
  adId: string;
  adName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  spend: Prisma.Decimal | null;
  impressions: bigint | null;
  leads: number | null;
  linkClicks: number | null;
  /** Meta returned a row for this advert. A row with spend "0" still counts. */
  returnedByMeta: boolean;
  enquiries: number;
  replied: number;
}

/**
 * Join Meta's money to our enquiry counts, per advert and per campaign.
 *
 * Pure: it takes the two sets of numbers and returns the joined view, so every
 * rule above is testable without a database or a network. `Prisma.Decimal` here
 * is the decimal arithmetic type the rest of the money code uses, not a client
 * — floats are never used on money anywhere in this file.
 *
 * The universe of adverts is the UNION of the two sides. An advert Meta
 * returned that brought us nothing is listed (that is the advert she most needs
 * to see), and an advert we counted that Meta did not return is listed too,
 * marked `not_returned` — the count screen already refuses to drop an advert
 * silently, and this is the same rule applied to the money.
 */
export function joinAdCostPerEnquiry(
  spend: AdSpendSnapshot,
  enquiries: AdEnquirySnapshot,
): AdCostReport {
  const sameWindow = spend.from === enquiries.from && spend.to === enquiries.to;
  // A currency that is not three letters is not a unit anything can be priced
  // in, so it is treated exactly like a failed call rather than ignored.
  const currencyKnown = /^[A-Z]{3}$/.test(spend.currency);
  const spendAvailable = spend.available && currencyKnown;

  const builds = new Map<string, AdvertBuild>();
  // Meta first: it is the only side that carries a creative name, and its
  // campaign id is the authoritative identity when both sides have one.
  if (spendAvailable) {
    for (const row of spend.adverts) {
      const build = buildFor(builds, row.adId);
      build.adName = build.adName ?? row.adName;
      build.campaignId = build.campaignId ?? row.campaignId;
      build.campaignName = build.campaignName ?? row.campaignName;
      build.spend = (build.spend ?? new Prisma.Decimal(0)).plus(decimalOrZero(row.spend));
      build.impressions = addCount(build.impressions, row.impressions);
      build.leads = addNumber(build.leads, row.leads);
      build.linkClicks = addNumber(build.linkClicks, row.linkClicks);
      build.returnedByMeta = true;
    }
  }
  for (const row of enquiries.adverts) {
    const build = buildFor(builds, row.adId);
    build.campaignId = build.campaignId ?? row.campaignId;
    build.campaignName = build.campaignName ?? row.campaignName;
    build.enquiries += row.enquiries;
    build.replied += row.replied;
  }

  const campaigns = new Map<string, AdCostCampaign>();
  const groups = new Map<string, AdvertBuild[]>();
  for (const build of builds.values()) {
    /*
     * The same key rule the count screen uses, so a row behaves identically on
     * both: the campaign id, else the case-folded campaign name (Meta returns
     * it however it was typed), else the advert's own id. An advert with no
     * name of any kind is its OWN row — merging those under a shared "no
     * campaign" heading would invent a campaign that does not exist.
     */
    const key =
      build.campaignId ??
      (build.campaignName ? `name:${build.campaignName.toLowerCase()}` : `ad:${build.adId}`);
    const group = groups.get(key);
    if (group) group.push(build);
    else groups.set(key, [build]);
  }

  for (const [key, group] of groups) {
    const adverts = group.map((build) => {
      const status = spendStatus(build.returnedByMeta ? 1 : 0, 1, spendAvailable);
      const costPerEnquiry = costPer(build.spend, build.enquiries, status, sameWindow, 'no_enquiries');
      const costPerReply = costPer(build.spend, build.replied, status, sameWindow, 'no_replies');
      const advert: AdCostAdvert = {
        adId: build.adId,
        adName: build.adName,
        meta: {
          spend: status === 'measured' && build.spend ? build.spend.toFixed(2) : null,
          impressions: status === 'measured' && build.impressions !== null ? build.impressions.toString() : null,
          leads: status === 'measured' ? build.leads : null,
          linkClicks: status === 'measured' ? build.linkClicks : null,
          status,
        },
        ours: { enquiries: build.enquiries, replied: build.replied },
        costPerEnquiry: costPerEnquiry.value,
        costPerEnquiryStatus: costPerEnquiry.status,
        costPerReply: costPerReply.value,
        costPerReplyStatus: costPerReply.status,
      };
      return advert;
    });
    adverts.sort(byCostPerEnquiry((a) => a.adId));

    const measured = group.filter((b) => b.returnedByMeta).length;
    const status = spendStatus(measured, group.length, spendAvailable);
    // The partial sum is shown rather than hidden, as the ROAS report shows
    // foreign-currency spend rather than dropping it — but `status: 'partial'`
    // travels with it and the costs below are null, so nothing reads it as the
    // campaign's whole spend.
    const total = group.reduce<Prisma.Decimal | null>(
      (sum, b) => (b.spend === null ? sum : (sum ?? new Prisma.Decimal(0)).plus(b.spend)),
      null,
    );
    const ours = {
      enquiries: group.reduce((n, b) => n + b.enquiries, 0),
      replied: group.reduce((n, b) => n + b.replied, 0),
    };
    const costPerEnquiry = costPer(total, ours.enquiries, status, sameWindow, 'no_enquiries');
    const costPerReply = costPer(total, ours.replied, status, sameWindow, 'no_replies');
    const named = group.find((b) => b.campaignId || b.campaignName);
    campaigns.set(key, {
      key,
      campaignId: named?.campaignId ?? null,
      campaignName: named?.campaignName ?? null,
      meta: {
        spend: status === 'spend_unavailable' || total === null ? null : total.toFixed(2),
        impressions: group.reduce<bigint | null>((n, b) => addBig(n, b.impressions), null)?.toString() ?? null,
        leads: group.reduce<number | null>((n, b) => addNumber(n, b.leads), null),
        linkClicks: group.reduce<number | null>((n, b) => addNumber(n, b.linkClicks), null),
        status,
      },
      ours,
      costPerEnquiry: costPerEnquiry.value,
      costPerEnquiryStatus: costPerEnquiry.status,
      costPerReply: costPerReply.value,
      costPerReplyStatus: costPerReply.status,
      adverts,
    });
  }

  const ranked = [...campaigns.values()].sort(byCostPerEnquiry((c) => c.key));
  const all = [...builds.values()];
  const measured = all.filter((b) => b.returnedByMeta).length;
  const totalStatus = spendStatus(measured, all.length, spendAvailable);
  const totalSpend = all.reduce<Prisma.Decimal | null>(
    (sum, b) => (b.spend === null ? sum : (sum ?? new Prisma.Decimal(0)).plus(b.spend)),
    null,
  );
  const totalOurs = {
    enquiries: all.reduce((n, b) => n + b.enquiries, 0),
    replied: all.reduce((n, b) => n + b.replied, 0),
  };
  const totalPerEnquiry = costPer(totalSpend, totalOurs.enquiries, totalStatus, sameWindow, 'no_enquiries');
  const totalPerReply = costPer(totalSpend, totalOurs.replied, totalStatus, sameWindow, 'no_replies');

  return {
    window: {
      dateFrom: spend.dateFrom,
      dateTo: spend.dateTo,
      timezone: spend.timezone,
      spendFrom: spend.from,
      spendTo: spend.to,
      enquiryFrom: enquiries.from,
      enquiryTo: enquiries.to,
      spendBasis: 'meta_delivery_day',
      enquiryBasis: 'conversation_created_at',
      sameWindow,
    },
    currency: spend.currency,
    spendAvailable,
    spendUnavailableReason: spendAvailable
      ? null
      : (spend.unavailableReason ??
        (currencyKnown ? null : 'The ad account currency is unknown, so no cost has a unit.')),
    totals: {
      meta: {
        spend: totalStatus === 'spend_unavailable' || totalSpend === null ? null : totalSpend.toFixed(2),
        impressions: all.reduce<bigint | null>((n, b) => addBig(n, b.impressions), null)?.toString() ?? null,
        leads: all.reduce<number | null>((n, b) => addNumber(n, b.leads), null),
        linkClicks: all.reduce<number | null>((n, b) => addNumber(n, b.linkClicks), null),
        status: totalStatus,
      },
      ours: totalOurs,
      costPerEnquiry: totalPerEnquiry.value,
      costPerEnquiryStatus: totalPerEnquiry.status,
      costPerReply: totalPerReply.value,
      costPerReplyStatus: totalPerReply.status,
      adverts: all.length,
      campaigns: ranked.length,
    },
    campaigns: ranked,
    note: NOTE,
  };
}

/**
 * A cost, or an honest reason there is not one.
 *
 * The order of these checks is the whole point, so it is spelled out:
 *
 *  1. A window mismatch comes first because it is the only failure that would
 *     otherwise produce a *plausible* number — one period's money over another
 *     period's enquiries looks exactly like a real cost per enquiry.
 *  2. Spend we do not have cannot be divided. Missing is not zero.
 *  3. A campaign missing some of its adverts' spend is incomplete, not cheap.
 *  4. NIL spend before NIL enquiries: an advert that did not spend in this
 *     window has no cost of any kind, and that is the more specific fact than
 *     "nothing arrived". So spend "0" with no enquiries reads `no_spend`.
 *  5. Only then the empty denominator, which is the actual division by zero.
 */
function costPer(
  spend: Prisma.Decimal | null,
  denominator: number,
  status: AdSpendStatus,
  sameWindow: boolean,
  emptyDenominator: 'no_enquiries' | 'no_replies',
): { value: string | null; status: AdCostStatus } {
  if (!sameWindow) return { value: null, status: 'window_mismatch' };
  if (status === 'spend_unavailable' || status === 'not_returned' || spend === null) {
    return { value: null, status: 'spend_unknown' };
  }
  if (status === 'partial') return { value: null, status: 'incomplete_spend' };
  if (spend.isZero()) return { value: null, status: 'no_spend' };
  if (denominator <= 0) return { value: null, status: emptyDenominator };
  return { value: spend.div(denominator).toFixed(2), status: 'measured' };
}

function spendStatus(measured: number, total: number, spendAvailable: boolean): AdSpendStatus {
  if (!spendAvailable) return 'spend_unavailable';
  if (measured === 0) return 'not_returned';
  if (measured < total) return 'partial';
  return 'measured';
}

/**
 * Cheapest enquiry first, which is the ranking the question asks for, then
 * everything with no cost, then by a stable id.
 *
 * TIES ARE BROKEN BY ID rather than left to the order the rows arrived in. Two
 * adverts on the same cost would otherwise swap places between two refreshes of
 * the same window and make the whole ranking look untrustworthy — the same
 * reason the enquiry count sorts this way.
 */
function byCostPerEnquiry<T extends { costPerEnquiry: string | null }>(id: (row: T) => string) {
  return (a: T, b: T) => {
    if (a.costPerEnquiry !== null && b.costPerEnquiry !== null) {
      const order = decimalOrZero(a.costPerEnquiry).comparedTo(decimalOrZero(b.costPerEnquiry));
      if (order !== 0) return order;
    } else if (a.costPerEnquiry !== b.costPerEnquiry) {
      return a.costPerEnquiry === null ? 1 : -1;
    }
    return id(a).localeCompare(id(b));
  };
}

function buildFor(builds: Map<string, AdvertBuild>, adId: string): AdvertBuild {
  const existing = builds.get(adId);
  if (existing) return existing;
  const created: AdvertBuild = {
    adId,
    adName: null,
    campaignId: null,
    campaignName: null,
    spend: null,
    impressions: null,
    leads: null,
    linkClicks: null,
    returnedByMeta: false,
    enquiries: 0,
    replied: 0,
  };
  builds.set(adId, created);
  return created;
}

/** Counts stay unknown until one is seen; a sum of nothing is not zero. */
function addCount(total: bigint | null, value: string | null): bigint | null {
  if (value === null) return total;
  return (total ?? 0n) + BigInt(value);
}

function addBig(total: bigint | null, value: bigint | null): bigint | null {
  if (value === null) return total;
  return (total ?? 0n) + value;
}

function addNumber(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}
