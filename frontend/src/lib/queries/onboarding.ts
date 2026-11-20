"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Welcome-guide progress (Module: onboarding).
 *
 * Kept on the server, keyed to the user account, because shop tablets are
 * shared: a browser-local flag let the first person to close the guide hide it
 * from everyone who signed in after them, and made it start over for the same
 * person on their phone. These hooks are the only readers of that state.
 */

export interface TourState {
  /** Times the guide has opened on its own for this account. */
  views: number;
  maxViews: number;
  /** Automatic openings still to come. */
  viewsLeft: number;
  /** Finished, or explicitly turned off. */
  done: boolean;
  /** The one flag the tour component acts on. */
  autoOpen: boolean;
}

const TOUR_KEY = ["onboarding", "tour"] as const;

/** GET /onboarding/tour — where this account stands. */
export function useTourState(enabled: boolean) {
  return useQuery({
    queryKey: TOUR_KEY,
    queryFn: async () => {
      const { data } = await api.get<TourState>("/onboarding/tour");
      return data;
    },
    enabled,
    // Progress only changes through the mutations below, which write the fresh
    // state straight into the cache. Refetching on every window focus would just
    // be a request per tab switch.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * POST /onboarding/tour/viewed — count one automatic opening.
 * Called only when the guide opens by itself, never when it is reopened by hand
 * from the user menu, so a refresher is always free.
 */
export function useRecordTourView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<TourState>("/onboarding/tour/viewed");
      return data;
    },
    onSuccess: (state) => qc.setQueryData(TOUR_KEY, state),
  });
}

/** POST /onboarding/tour/done — finished, or "don't show this again". */
export function useFinishTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<TourState>("/onboarding/tour/done");
      return data;
    },
    onSuccess: (state) => qc.setQueryData(TOUR_KEY, state),
  });
}
