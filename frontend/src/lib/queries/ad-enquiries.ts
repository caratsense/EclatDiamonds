"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Which advert brought the most enquiries (client, 28 Nov).
 *
 * Every figure is the server's own aggregate over the whole window. Nothing on
 * the screen counts the rows it happens to be holding — a ranking derived from
 * one page of threads reports that page as the truth, which on a screen whose
 * entire job is a ranking would be the bug wearing the feature's clothes.
 */

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
  /** The ad set, which is how the marketing team names a branch. Null when Meta would not say. */
  adSetName: string | null;
  enquiries: number;
  /** Threads where the customer sent a SECOND inbound message. */
  replied: number;
  /** Null when nothing arrived — a percentage of nothing is not 0%. */
  repliedPct: number | null;
  /** Enquiries that reached no branch at all. */
  unrouted: number;
  branches: AdEnquiryBranch[];
  /** False when Meta told us nothing about this advert. Still listed, with its id. */
  named: boolean;
}

export interface AdEnquiryCampaign {
  key: string;
  campaignId: string | null;
  /** Null when the advert could not be resolved; `adverts` is then all there is. */
  campaignName: string | null;
  enquiries: number;
  replied: number;
  repliedPct: number | null;
  unrouted: number;
  branches: AdEnquiryBranch[];
  adverts: AdEnquiryAdvert[];
}

export interface AdEnquiryReport {
  windowDays: number;
  since: string;
  /** The branches these counts cover, so the screen can say whose numbers they are. */
  storeIds: string[];
  /** Whether enquiries that reached no branch are inside these numbers. */
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
  /** Adverts counted but not looked up against Meta, so the screen can say why. */
  advertsNotLookedUp: number;
}

/** The windows the screen offers, as the client described them. */
export const AD_ENQUIRY_WINDOWS = [7, 30, 90] as const;

export function useAdEnquiries(days: number) {
  return useQuery({
    queryKey: ["attribution", "ad-enquiries", days],
    // Every advert the server has not resolved for six hours costs it one Graph
    // call. Five minutes here stops flicking between 7 and 30 days and back
    // from re-asking what would answer the same.
    staleTime: 5 * 60 * 1000,
    queryFn: async () =>
      (await api.get<AdEnquiryReport>("/attribution/meta-ads/enquiries", { params: { days } }))
        .data,
  });
}
