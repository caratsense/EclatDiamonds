import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The omnichannel headline numbers.
 *
 * Everything here is measured server-side. Nothing on this screen is derived by
 * counting rows the client happens to be holding — a page of leads is not a
 * total, and a chart drawn from one is wrong the moment the list is paginated.
 */

export interface OmnichannelSummary {
  windowDays: number;
  since: string;
  storeIds: string[];
  totals: {
    leads: number;
    visits: number;
    enquiries: number;
    customers: number;
    newLeadsWithVisits: number;
  };
  bySource: { source: string; label: string; count: number }[];
  channels: {
    paidSocial: number;
    organicSocial: number;
    messaging: number;
    website: number;
    walkIn: number;
    phone: number;
    referral: number;
    imported: number;
  };
  /** Null when nothing has been assessed — a chart of zeroes would be a lie. */
  intent: { key: string; label: string; count: number }[] | null;
  intentAssessed: number;
  funnel: { key: string; label: string; count: number | null }[];
}

export function useOmnichannelSummary(params: { storeId?: string; days?: number } = {}) {
  /*
   * AN EMPTY BRANCH IS NOT A BRANCH.
   *
   * The server validates `storeId` as 1-40 characters, so `?storeId=` — which
   * is what axios sends for an empty string — comes back 400 Bad Request and
   * every figure on the card goes blank. Production logged exactly that while
   * the client was reading the screen and telling us the lead analytics were
   * not showing data.
   *
   * Dropped here rather than patched at the call sites: there are two of them
   * today and the next one would make the same mistake. "No branch" and "this
   * branch" are the only two things this parameter can mean, and an empty
   * string is the first of them.
   */
  const storeId = params.storeId?.trim() || undefined;
  const query = { ...params, storeId };
  return useQuery({
    queryKey: ["crm", "omnichannel", "summary", query],
    queryFn: async () => {
      const { data } = await api.get<OmnichannelSummary>("/crm/omnichannel/summary", {
        params: query,
      });
      return data;
    },
  });
}
