"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Tenant-defined labels on a lead.
 *
 * Deliberately separate from the ad-set routing hooks. Routing tags decide which
 * branch an inbound click belongs to and are written by the attribution engine;
 * these are written by a salesperson about a person they spoke to. One screen
 * shows both, which is exactly why the hooks must not be shared — a marketing
 * rule change must never re-label somebody's leads.
 */

export interface LeadTag {
  id: string;
  name: string;
  colour: string | null;
  isActive: boolean;
  sortOrder: number;
  /** How many leads carry it. Absent on the per-lead read. */
  leadCount?: number;
}

const KEY = ["lead-tags"] as const;

/** The tenant's vocabulary. Retired tags only when a settings screen asks. */
export function useLeadTags(includeInactive = false) {
  return useQuery({
    queryKey: [...KEY, { includeInactive }],
    queryFn: async () => {
      const { data } = await api.get<LeadTag[]>("/lead-tags", {
        params: includeInactive ? { includeInactive: true } : undefined,
      });
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useLeadTagsFor(leadId: string | null) {
  return useQuery({
    queryKey: [...KEY, "lead", leadId],
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data } = await api.get<LeadTag[]>(`/lead-tags/lead/${leadId}`);
      return data;
    },
  });
}

/**
 * Replace the tags on a lead with exactly this set.
 *
 * A set, not add/remove: two people editing the same lead converge on a state
 * instead of racing to append. The server treats it the same way.
 */
export function useSetLeadTags(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tagIds: string[]) => {
      const { data } = await api.put<LeadTag[]>(`/lead-tags/lead/${leadId}`, { tagIds });
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData([...KEY, "lead", leadId], data);
      // The board shows tag chips on the card, and counts change in settings.
      void qc.invalidateQueries({ queryKey: ["crm"] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useCreateLeadTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; colour?: string }) => {
      const { data } = await api.post<LeadTag>("/lead-tags", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateLeadTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: {
      id: string;
      name?: string;
      colour?: string;
      isActive?: boolean;
      sortOrder?: number;
    }) => {
      const { data } = await api.patch<LeadTag>(`/lead-tags/${id}`, input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * Retire a tag. The response says how many leads still carry it, because that
 * is the number the person clicking needs to see before they are surprised by it.
 */
export function useRetireLeadTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ retired: true; stillOnLeads: number }>(
        `/lead-tags/${id}`,
      );
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
