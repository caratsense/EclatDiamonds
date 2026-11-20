"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { ConnectionState } from "@/lib/catalogue-connection";
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
    /** An address is saved. Says nothing about whether it works. */
    configured?: boolean;
    /** The last read-only probe of the saved address passed. */
    verified?: boolean;
    connectionState?: ConnectionState;
    /** The canonical products endpoint (…/products). */
    productsEndpoint?: string | null;
    /** Token stored? Never the token itself. */
    tokenStored?: boolean;
    host?: string | null;
    credentialLastUsedAt?: string | null;
    /** Last probe that passed. */
    lastHealthAt?: string | null;
    /** Why the saved address last failed its check. */
    lastError?: string | null;
    /** The most recent check of any address, passed or failed. */
    lastProbe?: { at: string; ok: boolean; endpoint: string; latencyMs?: number; sourceTotal?: number | null; error?: string } | null;
    lastRun?: Partial<CatalogueSyncRun> | null;
    lastSuccessAt?: string | null;
    /** What the website says it has (last complete run, else last probe)… */
    sourceTotal?: number | null;
    /** …against what we hold as live listings. */
    listingsActive?: number | null;
    /** In the feed and its total, but unpublished or deleted on the website. */
    listingsUnpublished?: number | null;
    listingsTombstoned?: number | null;
    /** Website variants stored (metal / karat / diamond options). */
    variants?: number | null;
  } | null;
  /** Background jobs (a sync, picture indexing) run only while this is on. */
  scheduler?: { enabled?: boolean } | null;
  gati?: {
    productsSyncedAt?: string | null;
    stockSyncedAt?: string | null;
    imagesSyncedAt?: string | null;
  } | null;
  catalogue?: {
    /** Every Product record: Gati, manual, import and website-only. */
    products?: number;
    /** Products carrying a website design code (matched or website-only). */
    websiteLinked?: number;
    /** Website designs with no Gati match (WEB-* records). */
    websiteOnly?: number;
    variants?: number;
    /** Active picture records, all sources. */
    imagesActive?: number;
    imagesBySource?: Record<string, number>;
    missingCad?: number;
  } | null;
  /** Open conflicts by kind. */
  conflictsOpen?: Record<string, number> | null;
  embeddings?: {
    /** Active picture records — the denominator for "indexed". */
    imagesActive?: number;
    byStatus?: Record<string, number>;
    /** source -> embedding status -> pictures */
    bySource?: Record<string, Record<string, number>>;
    productsWithIndexedImage?: number;
    productsWithoutImage?: number;
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
    // Settled, not success: a failed connection test changes the state too.
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
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
export interface ConnectionCheck {
  verified: boolean;
  productsEndpoint: string;
  sourceTotal: number | null;
  checkedAt: string;
}

export function useSaveWebsiteCredential() {
  return useIntegrationMutation(
    async (body: { token?: string; baseUrl: string }) =>
      (await api.post<ConnectionCheck & { configured: boolean; host: string }>("/catalogue-integration/website/credential", body))
        .data,
  );
}

/** Re-check the saved address (page 1, one product). Starts no sync. */
export function useTestWebsiteConnection() {
  return useIntegrationMutation(
    async () => (await api.post<ConnectionCheck>("/catalogue-integration/website/test", {})).data,
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
