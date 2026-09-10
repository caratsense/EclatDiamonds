"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The administration surface for connected messaging and advertising accounts.
 *
 * One rule runs through every type in this file: nothing here ever carries a
 * secret. A token is written once, encrypted server-side, and afterwards the API
 * reports only that one exists — so there is no shape in this module that could
 * hold a token even by accident, and no screen that could render one back.
 *
 * The second rule is that "connected" has to mean something. The health and
 * template types below distinguish what somebody typed in from what the provider
 * actually confirmed, because an administration screen that blurs the two sends
 * an operator away to wait for leads that will never arrive.
 */

/* ------------------------------------------------------------ Connection */

export interface IntegrationConfigInput {
  integrationId: string;
  config: Record<string, unknown>;
}

/** Replace the non-secret settings of a connection (account ids, options). */
export function useUpdateIntegrationConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ integrationId, config }: IntegrationConfigInput) =>
      (await api.patch(`/integrations-registry/${integrationId}/config`, { config })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["integrations-registry"] }),
  });
}

/* ---------------------------------------------------------------- Health */

export type ConnectionState =
  | "not_configured"
  | "connected"
  | "needs_attention"
  | "failed"
  | "disabled";

export interface AssetHealth {
  id: string;
  kind: string;
  externalId: string;
  name: string | null;
  /** True only after a live provider call read this asset back by id. */
  verified: boolean;
  lastVerifiedAt: string | null;
  error: string | null;
}

export interface IntegrationHealth {
  integrationId: string;
  providerCode: string;
  name: string;
  state: ConnectionState;
  lastHealthAt: string | null;
  lastSyncAt: string | null;
  error: string | null;
  /** Presence only. The credential itself never leaves the server. */
  credentialPresent: boolean;
  assets: AssetHealth[];
}

export const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  not_configured: "Not set up",
  connected: "Connected",
  needs_attention: "Needs attention",
  failed: "Failed",
  disabled: "Switched off",
};

export function useMetaHealth(integrationId: string | null) {
  return useQuery({
    queryKey: ["meta-health", integrationId],
    enabled: Boolean(integrationId),
    queryFn: async () =>
      (await api.get<IntegrationHealth>(`/integrations/meta/${integrationId}/health`)).data,
  });
}

/** Run a live check now. Rate-limited server-side; a refresh returns the stored verdict. */
export function useCheckMetaHealth(integrationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await api.post<IntegrationHealth>(`/integrations/meta/${integrationId}/health/check`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["meta-health", integrationId] });
      void qc.invalidateQueries({ queryKey: ["integrations-registry"] });
    },
  });
}

/* ---------------------------------------------------------------- Assets */

export type MetaAssetKind = "page" | "form" | "ad_account";

export const META_ASSET_LABEL: Record<MetaAssetKind, string> = {
  page: "Page",
  form: "Lead form",
  ad_account: "Ad account",
};

export function useRegisterMetaAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      integrationId: string;
      kind: MetaAssetKind;
      externalId: string;
      name?: string;
    }) => (await api.post("/integrations/meta/assets", input)).data,
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ["meta-health", input.integrationId] });
      void qc.invalidateQueries({ queryKey: ["integrations-registry"] });
    },
  });
}

/* ------------------------------------------------------------- Templates */

export type ProviderTemplateStatus =
  | "APPROVED"
  | "PENDING"
  | "IN_APPEAL"
  | "REJECTED"
  | "PAUSED"
  | "DISABLED"
  | "PENDING_DELETION"
  | "DELETED"
  | "REMOVED"
  | "UNKNOWN";

export interface MessageTemplateRow {
  id: string;
  externalId: string;
  name: string | null;
  isActive: boolean;
  /** True only when the provider itself last reported APPROVED. */
  providerOwnershipVerified: boolean;
  lastVerifiedAt: string | null;
  lastError: string | null;
  integration: { id: string; name: string; providerCode: string; status: string };
  metadata: {
    channel: string;
    languageCode: string;
    category: string;
    /** What an operator recorded here. Never what authorises a send. */
    approvalStatus: string;
    providerStatus: ProviderTemplateStatus;
    providerSyncedAt: string | null;
    variables: string[];
    recordedAt: string;
  };
}

export interface TemplateSyncResult {
  integrationId: string;
  syncedAt: string;
  providerTemplates: number;
  approved: number;
  removed: number;
  discovered: number;
}

export function useMessageTemplates(integrationId?: string) {
  return useQuery({
    queryKey: ["omnichannel", "templates", integrationId ?? "all"],
    queryFn: async () =>
      (
        await api.get<MessageTemplateRow[]>("/omnichannel/templates", {
          params: integrationId ? { integrationId } : undefined,
        })
      ).data,
  });
}

export function useSyncTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (integrationId: string) =>
      (
        await api.post<TemplateSyncResult>(
          `/omnichannel/integrations/${integrationId}/templates/sync`,
        )
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["omnichannel", "templates"] }),
  });
}

export function useQueueTemplateSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (integrationId: string) =>
      (
        await api.post<{ queued: boolean; jobId: string; deduplicated: boolean }>(
          `/omnichannel/integrations/${integrationId}/templates/sync/queue`,
        )
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

/* --------------------------------------------------------------- Consent */

export type ConsentStatus = "granted" | "revoked";
export type ConsentPurpose = "service" | "marketing";

export interface ConsentSnapshot {
  state: "granted" | "revoked" | "unknown";
  purpose: string;
  channel: string;
  eventId?: string;
  occurredAt?: string;
  expiresAt?: string;
  source?: string;
}

export function useConsent(partyId: string | null, channel: string, purpose: ConsentPurpose) {
  return useQuery({
    queryKey: ["omnichannel", "consent", partyId, channel, purpose],
    enabled: Boolean(partyId),
    queryFn: async () =>
      (
        await api.get<ConsentSnapshot>(`/omnichannel/consents/${partyId}`, {
          params: { channel, purpose },
        })
      ).data,
  });
}

export function useRecordConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      partyId: string;
      channel: string;
      purpose: "service" | "marketing" | "all";
      status: ConsentStatus;
      source?: string;
      reference?: string;
    }) => (await api.post("/omnichannel/consents", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["omnichannel", "consent"] }),
  });
}

/* ---------------------------------------------------------------- Outbox */

export type OutboxStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export interface OutboxRow {
  id: string;
  conversationId: string;
  body: string | null;
  status: OutboxStatus;
  direction: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  conversation: {
    id: string;
    channel: string;
    storeId: string | null;
    party: { id: string; name: string } | null;
  } | null;
  /** The durable delivery job behind this message, when one exists. */
  job: {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
    runAt: string;
  } | null;
}

export const OUTBOX_STATUS_LABEL: Record<OutboxStatus, string> = {
  queued: "Waiting to send",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
};

/**
 * `queued` is the honest state for a message nobody has transmitted yet. It is
 * NOT "sent": reporting a message as sent when no provider was contacted would
 * be a lie a salesperson then repeats to a customer.
 */
export function useOutbox(status?: OutboxStatus) {
  return useQuery({
    queryKey: ["omnichannel", "outbox", status ?? "all"],
    queryFn: async () =>
      (
        await api.get<OutboxRow[]>("/omnichannel/outbox", {
          params: { ...(status ? { status } : {}), limit: 200 },
        })
      ).data,
    refetchInterval: 30_000,
  });
}

export function useRetryMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) =>
      (await api.post(`/omnichannel/outbox/${messageId}/retry`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["omnichannel", "outbox"] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}

export function useSweepOutbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post("/omnichannel/outbox/sweep")).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["omnichannel", "outbox"] }),
  });
}

/**
 * A message a person may act on right now.
 *
 * Delivered work is finished and must not be re-sent; a job still pending or
 * running will move on its own, and pressing retry on it would only duplicate
 * effort. What is left is the queue worth showing someone.
 */
export function isManuallyRetryable(row: OutboxRow): boolean {
  if (row.status === "sent" || row.status === "delivered" || row.status === "read") return false;
  if (row.job && (row.job.status === "pending" || row.job.status === "running")) return false;
  return true;
}

/* ------------------------------------------------------------------ Jobs */

export interface DurableJob {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  createdAt: string;
  payload?: unknown;
}

export const LEAD_ADS_JOB_KINDS = ["meta.lead_ads.fetch", "meta_lead_ads.fetch"] as const;

export function useJobsByKind(kind?: string, status?: string) {
  return useQuery({
    queryKey: ["jobs", "list", kind ?? "all", status ?? "all"],
    queryFn: async () =>
      (
        await api.get<DurableJob[]>("/jobs", {
          params: { ...(kind ? { kind } : {}), ...(status ? { status } : {}), limit: 200 },
        })
      ).data,
    refetchInterval: 30_000,
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/jobs/${id}/retry`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

/* ------------------------------------------------------- Spend and ROAS */

export interface AdPerformanceRow {
  externalCampaignId: string;
  campaignId: string | null;
  label: string;
  currency: string;
  measuredSpend: string;
  declaredCampaignSpend: string | null;
  declaredSpendScope: string | null;
  impressions: string;
  clicks: string;
  measuredRevenue: string;
  declaredRevenue: string;
  measuredSales: number;
  declaredSales: number;
  measuredRoas: string | null;
  measuredRoasStatus:
    | "measured"
    | "currency_mismatch"
    | "incomplete_spend_window"
    | "zero_denominator";
  spendAssociation: "observed_in_account" | "not_observed_in_account";
  mappingStatus: "mapped" | "unmapped" | "ambiguous";
}

export interface AdPerformance {
  model: "first_touch" | "last_touch";
  integrationId: string;
  adAccountAssetId: string;
  dateFrom: string;
  dateTo: string;
  timezone: string;
  currency: string;
  currencies: {
    spend: string;
    revenue: string;
    mismatch: boolean;
    foreignSpend: { currency: string; measuredSpend: string }[];
  };
  coverage: {
    complete: boolean;
    completedDays: number;
    expectedDays: number;
    missingDates: string[];
  };
  totals: {
    measuredSpend: string;
    measuredSpendCurrency: string;
    measuredRevenue: string;
    measuredRevenueCurrency: string;
    unjoinedMeasuredRevenue: string;
    declaredRevenue: string;
    measuredRoas: string | null;
    measuredRoasStatus: AdPerformanceRow["measuredRoasStatus"];
    currencyMismatch: boolean;
  };
  rows: AdPerformanceRow[];
  note: string;
}

export const ROAS_STATUS_REASON: Record<AdPerformanceRow["measuredRoasStatus"], string> = {
  measured: "Measured from provider spend and click-backed revenue.",
  currency_mismatch:
    "Spend and revenue are not in one currency. No conversion rate has been supplied, so no ratio is shown.",
  incomplete_spend_window:
    "Some days in this range have not been fully ingested, so the spend total is not final.",
  zero_denominator: "No measured spend in this range, so a ratio would divide by zero.",
};

export interface AdPerformanceQuery {
  integrationId: string;
  adAccountAssetId: string;
  dateFrom: string;
  dateTo: string;
  model?: "first_touch" | "last_touch";
}

export function useAdPerformance(query: AdPerformanceQuery | null) {
  return useQuery({
    queryKey: ["attribution", "meta-ads", query],
    enabled: Boolean(query?.integrationId && query?.adAccountAssetId),
    queryFn: async () =>
      (await api.get<AdPerformance>("/attribution/meta-ads/performance", { params: query! })).data,
    retry: false,
  });
}

export function useSyncAdSpend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<AdPerformanceQuery, "model">) =>
      (await api.post("/attribution/meta-ads/sync", input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["attribution", "meta-ads"] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}
