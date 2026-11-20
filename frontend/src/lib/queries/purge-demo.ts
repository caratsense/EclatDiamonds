import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** The phrase the server insists on before it deletes anything. */
export const PURGE_CONFIRM_PHRASE = "DELETE DEMO DATA";

export interface PurgePreview {
  dryRun: true;
  message: string;
  /** Proof that real data arrived — the server refuses to purge without it. */
  realDataFound: Record<string, number>;
  wouldDelete: Record<string, number>;
  storesToDelete: string[];
  storesKept: string[];
  usersToDelete: string[];
  usersKept: string[];
}

export interface PurgeResult {
  dryRun: false;
  message: string;
  deleted: Record<string, number>;
  storesKept: string[];
  usersKept: string[];
  realDataFound: Record<string, number>;
}

/**
 * The dry run. Sending no confirmation is what makes it a dry run, so this is
 * safe to fetch whenever the screen is open — nothing is deleted.
 */
export function usePurgePreview(enabled: boolean) {
  return useQuery({
    queryKey: ["sync", "purge-demo", "preview"],
    enabled,
    // Always ask the server again: the answer changes as real data arrives.
    staleTime: 0,
    queryFn: async () => {
      const { data } = await api.post<PurgePreview>("/sync/purge-demo", {});
      return data;
    },
  });
}

/** The real thing. Only ever called with the phrase typed by a person. */
export function usePurgeDemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (confirm: string) => {
      const { data } = await api.post<PurgeResult>("/sync/purge-demo", { confirm });
      return data;
    },
    // Half the app was reading rows that no longer exist.
    onSuccess: () => qc.invalidateQueries(),
  });
}
