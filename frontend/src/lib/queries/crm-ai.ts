"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * CRM qualification + attribution (Phase A9/A10).
 *
 * Kept apart from `jewelry-similarity.ts` deliberately: that is the visual
 * pipeline (image → embedding → nearest product) and this is the text one
 * (conversation → signals → score). They share no state, no provider and no
 * failure mode, and merging their hooks would be the first step towards merging
 * the systems behind them.
 */

/* ----------------------------------------------------------- qualification */

export interface SignalResult {
  key: string;
  label: string;
  weight: number;
  matched: boolean;
  /** The text that fired it. This is what makes a score arguable. */
  evidence?: string;
}

export interface QualificationBand {
  key: string;
  label: string;
  minScore: number;
  recommendedAction: string;
  requestHandoff?: boolean;
}

export interface QualificationSignal {
  key: string;
  label: string;
  weight: number;
  phrases: string[];
  hint?: string;
}

export interface QualificationPolicy {
  enabled: boolean;
  version: number;
  signals: QualificationSignal[];
  bands: QualificationBand[];
  questions: { key: string; prompt: string; requirement: string; required?: boolean }[];
  confidenceThreshold: number;
  minMessagesToScore: number;
  handoffAtScore: number | null;
  handoffSignals: string[];
  summarise: boolean;
}

export interface Qualification {
  id: string;
  partyId: string | null;
  leadId: string | null;
  conversationId: string | null;
  /** False when no score could be produced. `unavailableReason` says why. */
  available: boolean;
  unavailableReason: string | null;
  /** 'ai' when a provider extracted the signals, 'rules' when phrases matched. */
  method: string;
  /** Null, never zero, when nothing could be assessed — zero would mean "cold". */
  score: number | null;
  confidence: number | null;
  lowConfidence: boolean;
  band: string | null;
  bandLabel: string | null;
  recommendedAction: string | null;
  handoffRequested: boolean;
  handoffReason: string | null;
  firedSignals: SignalResult[];
  requirements: Record<string, string>;
  summary: string | null;
  policyVersion: number;
  /** True when the policy has changed since this was produced. */
  policyOutdated: boolean;
  provider: string | null;
  model: string | null;
  messagesConsidered: number;
  createdAt: string;
}

export interface QualificationSetup {
  policy: QualificationPolicy;
  defaults: QualificationPolicy;
  provider: {
    available: boolean;
    reason: string | null;
    /** 'ai' with a provider, 'rules' without. Both produce real scores. */
    mode: "ai" | "rules";
  };
}

export function useQualificationPolicy() {
  return useQuery({
    queryKey: ["crm", "qualification", "policy"],
    queryFn: async () => (await api.get<QualificationSetup>("/crm/qualification/policy")).data,
  });
}

export function useSaveQualificationPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<QualificationPolicy>) =>
      (await api.post<QualificationPolicy>("/crm/qualification/policy", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "qualification"] }),
  });
}

/* ------------------------------------------------------- ad-set automation */

export interface AdSetAutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  /**
   * `ad_id` is the only field a Click-to-WhatsApp click can satisfy today —
   * Meta sends the ad id in the referral and nothing else. The ad-set fields
   * stay available for a Marketing API adapter that can supply them.
   */
  matchField: "ad_id" | "ad_set_id" | "ad_set_name" | "tag";
  matchValue: string;
  storeId: string | null;
  assignedUserId: string | null;
  handling: "ai" | "human";
  aiContext?: string | null;
  aiGuardrails?: string | null;
}

export function useAdSetRules() {
  return useQuery({
    queryKey: ["crm", "qualification", "adset-rules"],
    queryFn: async () =>
      (await api.get<AdSetAutomationRule[]>("/crm/qualification/adset-rules")).data,
  });
}

export function useSaveAdSetRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rules: AdSetAutomationRule[]) =>
      (await api.post<AdSetAutomationRule[]>("/crm/qualification/adset-rules", { rules })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "qualification", "adset-rules"] }),
  });
}

/** The most recent assessment. `null` means nobody has assessed this yet. */
export function useLatestQualification(target: {
  partyId?: string;
  leadId?: string;
  conversationId?: string;
}) {
  const enabled = !!(target.partyId || target.leadId || target.conversationId);
  return useQuery({
    queryKey: ["crm", "qualification", "latest", target],
    enabled,
    queryFn: async () =>
      (await api.get<Qualification | null>("/crm/qualification/latest", { params: target })).data,
  });
}

export function useAssessConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) =>
      (await api.post<Qualification>(`/crm/qualification/conversations/${conversationId}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "qualification"] }),
  });
}

export function useAssessLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (leadId: string) =>
      (await api.post<Qualification>(`/crm/qualification/leads/${leadId}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "qualification"] }),
  });
}

/* -------------------------------------------------------------- attribution */

export interface AttributionTouch {
  id: string;
  channel: string;
  source: string | null;
  medium: string | null;
  position: string;
  /** 'measured' | 'declared' | 'inferred' — never collapsed into one figure. */
  evidence: string;
  campaign: { id: string; name: string; type: string } | null;
  externalCampaignId: string | null;
  externalAdSetId: string | null;
  externalAdId: string | null;
  creditModel: string | null;
  occurredAt: string;
}

export interface PartyAttribution {
  status: "attributed" | "unattributed";
  reason: string | null;
  touches: AttributionTouch[];
  firstTouch: {
    channel: string;
    source: string | null;
    campaign: { id: string; name: string } | null;
    evidence: string;
    occurredAt: string;
  } | null;
  lastTouch: PartyAttribution["firstTouch"];
  revenue: { sales: number; total: string; note: string } | null;
}

export function usePartyAttribution(partyId: string | null) {
  return useQuery({
    queryKey: ["crm", "attribution", "party", partyId],
    enabled: !!partyId,
    queryFn: async () =>
      (await api.get<PartyAttribution>(`/crm/attribution/party/${partyId}`)).data,
  });
}

export interface CampaignPerformance {
  model: "first_touch" | "last_touch";
  rows: {
    campaignId: string | null;
    label: string;
    spend: string | null;
    sales: number;
    measuredRevenue: string;
    declaredRevenue: string;
    /** Null unless there is BOTH measured revenue and known spend. */
    measuredRoas: string | null;
  }[];
  note: string;
}

export function useCampaignAttribution(model: "first_touch" | "last_touch" = "last_touch") {
  return useQuery({
    queryKey: ["crm", "attribution", "campaigns", model],
    queryFn: async () =>
      (await api.get<CampaignPerformance>("/crm/attribution/campaigns", { params: { model } })).data,
  });
}

/* -------------------------------------------------------- CaratOS Connect */

export interface ConnectAgent {
  id: string;
  name: string;
  sourceSystem: string;
  storeId: string | null;
  store: { id: string; name: string } | null;
  /** Derived at read time from lastSeenAt, so it cannot contradict the timestamp. */
  status: "enrolled" | "active" | "stale" | "error" | "revoked";
  statusReason: string;
  /** Only the prefix. The token is unrecoverable by design. */
  tokenPrefix: string;
  agentVersion: string | null;
  hostname: string | null;
  os: string | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastStats: Record<string, unknown> | null;
  config: Record<string, unknown>;
  revokedAt: string | null;
  createdAt: string;
}

export function useConnectAgents() {
  return useQuery({
    queryKey: ["connect", "agents"],
    queryFn: async () => (await api.get<ConnectAgent[]>("/integration/connect/agents")).data,
    refetchInterval: 60_000,
  });
}

export function useEnrolAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; sourceSystem: string; storeId?: string }) =>
      (
        await api.post<{ agent: ConnectAgent; token: string; warning: string }>(
          "/integration/connect/agents",
          input,
        )
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["connect", "agents"] }),
  });
}

export function useRotateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ agent: ConnectAgent; token: string }>(`/integration/connect/agents/${id}/rotate`))
        .data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["connect", "agents"] }),
  });
}

export function useRevokeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/integration/connect/agents/${id}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["connect", "agents"] }),
  });
}

/* ------------------------------------------------------- WhatsApp sender */

export interface WhatsAppSenderState {
  usable: boolean;
  scope: "tenant" | "platform_env" | "none";
  /** True when this organisation is borrowing the platform's number. */
  shared: boolean;
  reason: string | null;
  integrationId: string | null;
  phoneNumberIdSuffix: string | null;
  oauth: { implemented: boolean; note: string };
}

export function useWhatsAppSender() {
  return useQuery({
    queryKey: ["integrations", "whatsapp", "sender"],
    queryFn: async () =>
      (await api.get<WhatsAppSenderState>("/integrations/whatsapp/sender")).data,
  });
}

/* ------------------------------------------------------ AI drafts (2C) */

/**
 * A reply the assistant proposed, and the evidence for it.
 *
 * Nothing here has been sent. `message.status` is `draft` until a person
 * decides, then `queued` (approved/edited) or `rejected` — never `sent`, which
 * belongs to a transport that is not connected yet.
 */
export interface AiDraft {
  id: string;
  conversationId: string;
  messageId: string;
  provider: string;
  model: string;
  /** Prisma Decimal arrives as a string; parse before comparing. */
  confidence: string;
  latencyMs: number | null;
  policyVersion: string;
  review: "pending" | "approved" | "edited" | "rejected";
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null;
  createdAt: string;
  message: { id: string; body: string | null; status: string; sentAt: string };
  /** What the draft was written from. A deleted source says so rather than vanishing. */
  sources: { id: string; title: string | null; deleted: boolean }[];
}

export function useAiDrafts(
  params: { conversationId?: string; state?: "pending" | "reviewed" | "all" } = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["crm", "ai-drafts", params],
    enabled: options.enabled ?? true,
    queryFn: async () =>
      (await api.get<AiDraft[]>("/crm/ai/drafts", { params })).data,
  });
}

/**
 * Approve (optionally with edits) or reject.
 *
 * The server distinguishes approved from edited, so this hook does not need to:
 * send the body only when the reviewer actually changed it.
 */
export function useReviewAiDraft(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      draftId: string;
      decision: "approve" | "reject";
      body?: string;
      note?: string;
    }) => {
      const { draftId, decision, ...rest } = input;
      return (await api.post(`/crm/ai/drafts/${draftId}/${decision}`, rest)).data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "ai-drafts"] });
      void qc.invalidateQueries({ queryKey: ["crm", "conversation", conversationId] });
      void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
      void qc.invalidateQueries({ queryKey: ["crm", "activity"] });
    },
  });
}
