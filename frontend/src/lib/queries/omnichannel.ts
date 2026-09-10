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
  return useQuery({
    queryKey: ["crm", "omnichannel", "summary", params],
    queryFn: async () => {
      const { data } = await api.get<OmnichannelSummary>("/crm/omnichannel/summary", { params });
      return data;
    },
  });
}
