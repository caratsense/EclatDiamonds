"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { CatalogueConflictView } from "@/lib/queries/products";

/**
 * Head office's view of the website + Gati catalogue integration
 * (docs/modules/05-catalogue-sources.md, "Catalogue sync"). Every route here is
 * head-office only on the server; the page checks the role only to explain.
 */

export interface CatalogueSyncRun {
  id: string;
  source: string;
  mode: string;
  dryRun: boolean;
  /** running | done | partial | failed */
  status: string;
  nextPage?: number;
  pageSize?: number;
  expected?: number | null;
  received?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  tombstoned?: number;
  conflicted?: number;
  failed?: number;
  imagesExpected?: number;
  imagesReceived?: number;
  imagesQueued?: number;
  /** Dry-run preview and per-item failures. */
  detail?: Record<string, unknown> | null;
  lastError?: string | null;
  startedAt: string;
  heartbeatAt?: string | null;
  finishedAt?: string | null;
}

/** GET /catalogue-integration/health (WebsiteCatalogueService.health). */
export interface CatalogueHealth {
  website?: {
    /** Address saved? The Eclat feed is public, so a token is optional. */
    configured?: boolean;
    /** Token stored? Never the token itself. */
    tokenStored?: boolean;
    host?: string | null;
    baseUrl?: string | null;
    credentialLastUsedAt?: string | null;
    lastRun?: Partial<CatalogueSyncRun> | null;
    lastSuccessAt?: string | null;
    /** What the website said it has on the last complete run… */
    sourceTotal?: number | null;
    /** …against what we hold as live listings. */
    listingsActive?: number | null;
    /** In the feed and its total, but unpublished or deleted on the website. */
    listingsUnpublished?: number | null;
    listingsTombstoned?: number | null;
  } | null;
  gati?: {
    productsSyncedAt?: string | null;
    stockSyncedAt?: string | null;
    imagesSyncedAt?: string | null;
  } | null;
  catalogue?: {
    products?: number;
    variants?: number;
    imagesBySource?: Record<string, number>;
    missingCad?: number;
  } | null;
  /** Open conflicts by kind. */
  conflictsOpen?: Record<string, number> | null;
  embeddings?: {
    byStatus?: Record<string, number>;
    latestVersions?: Record<string, string | null> | null;
  } | null;
}

const KEY = ["catalogue-integration"] as const;

export function useCatalogueHealth(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "health"],
    enabled,
    queryFn: async () => (await api.get<CatalogueHealth>("/catalogue-integration/health")).data,
    // A run in flight moves the numbers; otherwise it is a static screen.
    refetchInterval: (q) => (q.state.data?.website?.lastRun?.status === "running" ? 5_000 : false),
  });
}

export function useCatalogueRuns(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "runs"],
    enabled,
    queryFn: async () => {
      const { data } = await api.get<CatalogueSyncRun[] | { items: CatalogueSyncRun[] }>(
        "/catalogue-integration/runs",
      );
      return Array.isArray(data) ? data : (data.items ?? []);
    },
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running") ? 5_000 : false),
  });
}

export type ConflictStatus = "open" | "resolved" | "ignored";

export function useCatalogueConflicts(status: ConflictStatus, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "conflicts", status],
    enabled,
    queryFn: async () => {
      const { data } = await api.get<CatalogueConflictView[] | { items: CatalogueConflictView[] }>(
        "/catalogue-integration/conflicts",
        { params: { status } },
      );
      return Array.isArray(data) ? data : (data.items ?? []);
    },
  });
}

function useIntegrationMutation<V, R>(call: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Resolve / ignore a conflict; `resolution.productId` links an ambiguous match. */
export function useUpdateConflict() {
  return useIntegrationMutation(
    async ({ id, status, resolution }: { id: string; status: ConflictStatus; resolution?: Record<string, unknown> }) =>
      (await api.patch<CatalogueConflictView>(`/catalogue-integration/conflicts/${id}`, { status, resolution })).data,
  );
}

/**
 * Store the website service token. WRITE-ONLY: the response only says it is
 * configured, and nothing here ever reads the token back.
 */
export function useSaveWebsiteCredential() {
  return useIntegrationMutation(
    async (body: { token?: string; baseUrl: string }) =>
      (await api.post<{ configured: boolean }>("/catalogue-integration/website/credential", body)).data,
  );
}

/** Queues the run as a job and returns at once; progress shows in /runs. */
export function useStartWebsiteSync() {
  return useIntegrationMutation(
    async (body: { mode: "full" | "resume"; dryRun: boolean }) =>
      (
        await api.post<{ runId: string; jobId: string; status: string }>(
          "/catalogue-integration/website/sync",
          body,
        )
      ).data,
  );
}
