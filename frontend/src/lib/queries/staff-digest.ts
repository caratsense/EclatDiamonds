"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The morning message telling somebody what they owe a customer today.
 *
 * Two things this deliberately keeps apart. The PREVIEW is the signed-in
 * person's own list and nobody else's — it exists so they can see what they will
 * receive, not so they can read a colleague's customers, and the server enforces
 * that. The SETTINGS are organisation-wide and manager-level, because when a
 * tenant's staff get messaged is not a decision made on the shop floor.
 *
 * `whatsappSkipReason` is never treated as an error. "Not sent, because no
 * template is approved" is an ordinary Tuesday, and a screen that showed it as a
 * failure would have people chasing an outage that is not happening.
 */

export interface DigestLine {
  leadId: string;
  customerName: string;
  phone: string | null;
  dueDate: string;
  overdueDays: number;
}

export interface DigestPreview {
  userId: string;
  userName: string;
  storeId: string | null;
  businessDate: string;
  due: DigestLine[];
  overdue: DigestLine[];
  /** The exact text that would be sent. Null when it would not be. */
  whatsappBody: string | null;
  /** Why it would not be sent. Null when it would. */
  whatsappSkipReason: string | null;
}

export interface DigestSettings {
  organisationId: string;
  enabled: boolean;
  /** 0-23, read in each branch's own timezone. */
  sendHourLocal: number;
  whatsappEnabled: boolean;
  templateName: string | null;
  templateLanguage: string | null;
  updatedAt: string | null;
}

const KEY = ["staff-digest"] as const;

/** My own list, as it stands right now. Sends nothing. */
export function useDigestPreview() {
  return useQuery({
    queryKey: [...KEY, "preview"],
    queryFn: async () => {
      const { data } = await api.get<DigestPreview>("/staff-digest/preview");
      return data;
    },
    staleTime: 60_000,
  });
}

export function useDigestSettings(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "settings"],
    enabled,
    queryFn: async () => {
      const { data } = await api.get<DigestSettings>("/staff-digest/settings");
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSaveDigestSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Omit<DigestSettings, "organisationId" | "updatedAt">>) => {
      const { data } = await api.put<DigestSettings>("/staff-digest/settings", input);
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData([...KEY, "settings"], data);
      // Whether it would send, and why not, changes with the settings.
      void qc.invalidateQueries({ queryKey: [...KEY, "preview"] });
    },
  });
}
