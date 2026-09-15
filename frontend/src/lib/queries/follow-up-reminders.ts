"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** The tenant's default for a follow-up reminder nobody timed by hand. */
export interface FollowUpReminderSettings {
  /** Local "HH:MM" at the branch. */
  defaultTimeLocal: string;
  /** Days before the follow-up date; 0 is on the day. */
  defaultDaysBefore: number;
}

const KEY = ["follow-up-reminders", "settings"] as const;

export function useFollowUpReminderSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data } = await api.get<FollowUpReminderSettings>("/crm/follow-up-reminders/settings");
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSaveFollowUpReminderSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<FollowUpReminderSettings>) => {
      const { data } = await api.put<FollowUpReminderSettings>("/crm/follow-up-reminders/settings", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** "10:00 on the follow-up date" / "09:15 the day before". */
export function describeDefaultReminder(s: FollowUpReminderSettings | undefined): string {
  if (!s) return "at the tenant's default time";
  if (s.defaultDaysBefore === 0) return `at ${s.defaultTimeLocal} on the follow-up date`;
  if (s.defaultDaysBefore === 1) return `at ${s.defaultTimeLocal} the day before`;
  return `at ${s.defaultTimeLocal}, ${s.defaultDaysBefore} days before`;
}
