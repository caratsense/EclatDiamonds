import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The floor / field application.
 *
 * Every hook here hits a real tenant-scoped endpoint. There is deliberately no
 * sample data in this file: the screen that used to render a hardcoded array
 * looked finished and was not, and a fixture living beside the real query is how
 * that happens again.
 */

export interface InStoreLead {
  id: string;
  ref: string | null;
  stage: string;
  source: string;
  interest: string | null;
  createdAt: string;
  lastActivity: string | null;
  customerName: string;
  customerId: string | null;
  partyId: string | null;
  customerSince: string | null;
  hasWhatsApp: boolean;
  owner: { id: string; name: string } | null;
  store: { id: string; name: string } | null;
}

export interface InStoreSearchResult {
  query: string;
  matchedOn: "contact" | "name";
  canCreate: boolean;
  items: {
    partyId: string;
    name: string;
    customerId: string | null;
    contact: string | null;
    city: string | null;
    customerSince: string;
    store: { id: string; name: string } | null;
    activeLead: {
      id: string;
      ref: string | null;
      stage: string;
      source: string;
      interest: string | null;
      createdAt: string;
    } | null;
  }[];
}

export interface ScannedItem {
  found: boolean;
  code: string;
  stockTag?: string | null;
  item?: {
    id: string;
    sku: string | null;
    name: string;
    category: string | null;
    availability: string | null;
    imageUrl: string | null;
  };
}

export interface VisitEnquiryInput {
  productId?: string;
  sku?: string;
  converted?: boolean;
  quantity?: number;
  notes?: string;
  dropOffReason?: string;
}

export function useInStoreLeads(params: { storeId?: string; stage?: string; source?: string } = {}) {
  return useQuery({
    queryKey: ["instore", "leads", params],
    queryFn: async () => {
      const { data } = await api.get<{
        total: number;
        items: InStoreLead[];
        nextCursor: string | null;
      }>("/instore/leads", { params: { ...params, limit: 50 } });
      return data;
    },
  });
}

/**
 * Search runs only once the caller has typed enough, and the API enforces the
 * same floor. A three-character minimum on both sides means a stray keystroke
 * cannot ask the server to scan the whole tenant.
 */
export function useInStoreSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["instore", "search", q],
    enabled: q.length >= 3,
    queryFn: async () => {
      const { data } = await api.get<InStoreSearchResult>("/instore/search", { params: { q } });
      return data;
    },
  });
}

export function useInStoreProfile(partyId: string | undefined) {
  return useQuery({
    queryKey: ["instore", "customer", partyId],
    enabled: Boolean(partyId),
    queryFn: async () => {
      const { data } = await api.get(`/instore/customers/${partyId}`);
      return data as Record<string, unknown>;
    },
  });
}

export function useScanItem() {
  return useMutation({
    mutationFn: async (code: string) => {
      const { data } = await api.get<ScannedItem>("/instore/scan", { params: { code } });
      return data;
    },
  });
}

export function useRecordVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      partyId: string;
      storeId?: string;
      purpose?: string;
      notes?: string;
      fields?: Record<string, unknown>;
      enquiries?: VisitEnquiryInput[];
    }) => {
      const { data } = await api.post<{
        checkInId: string;
        enquiries: number;
        converted: boolean;
        partiallyConverted: boolean;
      }>("/instore/visits", input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["instore"] });
    },
  });
}
