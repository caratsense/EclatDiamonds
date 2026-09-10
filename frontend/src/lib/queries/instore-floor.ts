"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The floor app's own reads: the day's visits, the day's figures, and the
 * capture forms for this counter.
 *
 * Separate from `instore.ts` only because that file is the lead feed, search
 * and visit capture — the things that existed when the screen was one tab. No
 * sample data lives in either: the tabs these hooks feed used to be placeholder
 * cards, and a fixture beside a real query is how a placeholder becomes
 * something that looks finished and is not.
 */

/* --------------------------------------------------------------- visits */

export interface VisitEnquiry {
  id: string;
  /** The catalogue name where the code matched, the raw code where it did not. */
  name: string | null;
  productId: string | null;
  /** The tenant's own word — never the legacy jewellery enum. */
  category: string | null;
  sku: string | null;
  converted: boolean;
  quantity: number | null;
  notes: string | null;
  /** Why it did not convert, as the counter recorded it. */
  dropOffReason: string | null;
}

export interface FloorVisit {
  id: string;
  partyId: string | null;
  customerName: string;
  customerId: string | null;
  store: { id: string; name: string } | null;
  timeIn: string;
  /** The branch's own wall clock. */
  timeInLocal: string | null;
  timeOut: string | null;
  timeOutLocal: string | null;
  durationMin: number | null;
  /** `id` is null for rows written before attendance was recorded as an id. */
  attendedBy: { id: string | null; name: string } | null;
  purpose: string | null;
  /** Tenant-defined visit fields, exactly as recorded. */
  fields: Record<string, unknown> | null;
  outcome: string;
  status: "converted" | "walked_out" | "open";
  notes: string | null;
  /**
   * Where to ASK for the photo, not where it is stored — the object's own URL
   * never leaves the server. Fetch it with the authenticated client.
   */
  photoUrl: string | null;
  enquiries: VisitEnquiry[];
}

export interface FloorVisitsPage {
  date: string;
  timezone: string;
  items: FloorVisit[];
  nextCursor: string | null;
}

export function useFloorVisits(params: { storeId?: string; date?: string } = {}) {
  return useQuery({
    queryKey: ["instore", "visits", params],
    queryFn: async () => {
      const { data } = await api.get<FloorVisitsPage>("/instore/visits", {
        params: { ...params, limit: 50 },
      });
      return data;
    },
  });
}

/* ---------------------------------------------------------- the day */

export interface FloorDay {
  date: string;
  timezone: string;
  storeIds: string[];
  footfall: number;
  converted: number;
  walkOuts: number;
  stillIn: number;
  /**
   * Null when nobody came in. There is no rate of nothing, and "0%" reads as
   * "nobody walked out", which is a different and unfounded claim.
   */
  dropOffRate: number | null;
  openEnquiries: number;
  newLeads: number;
  myVisits: number;
  /** Null when nothing was logged — not an empty chart, which reads as "no interest". */
  topCategories: { name: string; count: number }[] | null;
}

export function useFloorDay(params: { storeId?: string; date?: string } = {}) {
  return useQuery({
    queryKey: ["instore", "today", params],
    queryFn: async () => {
      const { data } = await api.get<FloorDay>("/instore/today", { params });
      return data;
    },
  });
}

/* ---------------------------------------------------------------- forms */

export interface FloorForm {
  id: string;
  name: string;
  store: { id: string; name: string } | null;
  enabled: boolean;
  campaign: string | null;
  defaultInterest: string | null;
  createdAt: string;
  /** A path. The origin is the browser's own — the server does not guess it. */
  submitPath: string;
  submissions: {
    total: number;
    latest: {
      id: string;
      ref: string | null;
      customerName: string;
      createdAt: string;
      stage: string;
    } | null;
  };
}

export function useFloorForms(params: { storeId?: string } = {}) {
  return useQuery({
    queryKey: ["instore", "forms", params],
    queryFn: async () => {
      const { data } = await api.get<FloorForm[]>("/instore/forms", { params });
      return data;
    },
  });
}
