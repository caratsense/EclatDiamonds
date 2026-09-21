"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import { LEAD_STAGES, type LeadStage } from "@/lib/mock/crm";
import type { PartyAttribution } from "@/lib/queries/crm-ai";

/**
 * CaratOS CRM (Phase A3/A11) — Customer 360, the unified inbox and the
 * configurable pipelines.
 *
 * No hook here sends an organisation id. The tenant is resolved server-side from
 * the session, so there is nothing for a client to get wrong or to tamper with.
 */

/* ------------------------------------------------------------ Customer 360 */

export interface ContactPoint {
  id: string;
  kind: string;
  value: string;
  valueNormalized: string;
  isPrimary: boolean;
  verifiedAt: string | null;
  source: string | null;
}

export interface TimelineEvent {
  id: string;
  type: string;
  summary: string;
  occurredAt: string;
  channel: string | null;
  entityType: string | null;
  entityId: string | null;
  actorUser: { id: string; name: string; role?: string } | null;
  store: { id: string; name: string } | null;
  metadata?: Record<string, unknown> | null;
}

export interface Customer360 {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    city: string | null;
    state: string | null;
    gstin: string | null;
    birthday: string | null;
    anniversary: string | null;
    isBlacklisted: boolean;
    attributes: Record<string, unknown> | null;
    createdAt: string;
  };
  identity: { contactPoints: ContactPoint[]; openMergeReviews: number };
  summary: {
    scope: "all_stores" | "your_stores";
    /** Says out loud whether these totals cover every branch or only the user's. */
    scopeNote: string;
    leadCount: number;
    visitCount: number;
    saleCount: number;
    totalSpend: string;
    totalPaid: string;
    firstSeen: string;
    lastActivityAt: string | null;
  };
  leads: {
    id: string;
    ref: string;
    stage: string;
    source: string;
    value: string | null;
    outcome: string;
    interest: string | null;
    createdAt: string;
    owner: { id: string; name: string } | null;
    store: { id: string; name: string } | null;
  }[];
  conversations: ConversationRow[];
  visits: {
    id: string;
    purpose: string;
    outcome: string;
    createdAt: string;
    store: { id: string; name: string } | null;
  }[];
  productInteractions: {
    id: string;
    kind: string;
    sku: string | null;
    occurredAt: string;
    notes: string | null;
    channel: string | null;
    product: { id: string; sku: string; name: string; imageUrl: string | null } | null;
    user: { id: string; name: string } | null;
  }[];
  quotes: { id: string; ref: string; status: string; kind: string; createdAt: string }[];
  returns: {
    id: string;
    ref: string;
    /** ReturnType enum — return / exchange / buyback / repair / old-gold. */
    type: string;
    status: string;
    item: string | null;
    value: string | null;
    createdAt: string;
    store: { id: string; name: string } | null;
  }[];
  /** Outstanding only — a completed follow-up is already on the timeline. */
  followUps: {
    id: string;
    seq: number;
    dueDate: string;
    note: string | null;
    lead: { id: string; ref: string; interest: string | null } | null;
  }[];
  sales: {
    id: string;
    docNo: string;
    docType: string;
    docDate: string;
    totalAmount: string;
    store: { id: string; name: string } | null;
  }[];
  payments: {
    id: string;
    mode: string;
    amount: string;
    paidAt: string;
    reference: string | null;
    reversesPaymentId: string | null;
  }[];
  timeline: TimelineEvent[];
  timelineNextCursor: string | null;
  /**
   * Real attribution (Phase A10) — the same payload the dedicated endpoint
   * returns, embedded so the profile renders in one round trip. `unattributed`
   * stays an explicit state: the goal was never to produce a source, it was to
   * stop implying one.
   */
  attribution: PartyAttribution;
}

export function useCustomer360(partyId: string | null) {
  const storeKey = useStoreKey();
  return useQuery({
    queryKey: ["crm", "customer360", partyId, storeKey],
    enabled: !!partyId,
    queryFn: async () => (await api.get<Customer360>(`/crm/customers/${partyId}`)).data,
  });
}

export interface LookupResult {
  found: boolean;
  /**
   * The number belongs to a customer a colleague looks after. Nothing about them
   * is returned — enough to avoid opening a duplicate record, and no more.
   */
  restricted?: boolean;
  reason?: string;
  customer?: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    city: string | null;
    createdAt: string;
  };
}

/**
 * The showroom lookup. Read-only by design — it never creates a customer, so a
 * salesperson can safely check "do we know this number?" without leaving a
 * half-filled record behind if the answer is no.
 *
 * A query rather than a mutation despite being a POST: it reads, it is keyed by
 * the value looked up, and it is disabled until that value is complete — which
 * is what makes the debounce a caller would otherwise need unnecessary.
 *
 * Deliberately uncached (`gcTime: 0`). A colleague may have created this
 * customer a minute ago, and a stale "new to us" produces exactly the duplicate
 * record the lookup exists to prevent.
 */
export function useCustomerLookup(
  value: string | null,
  options: { kind?: string; onFound?: (customer: NonNullable<LookupResult["customer"]>) => void } = {},
) {
  const { kind = "phone", onFound } = options;
  return useQuery({
    queryKey: ["crm", "lookup", kind, value],
    enabled: !!value,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const { data } = await api.post<LookupResult>("/crm/customers/lookup", {
        kind,
        value,
      });
      if (data.found && data.customer) onFound?.(data.customer);
      return data;
    },
  });
}

export function useRecordInteraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      kind: string;
      partyId?: string;
      leadId?: string;
      productId?: string;
      sku?: string;
      storeId?: string;
      channel?: string;
      notes?: string;
    }) => (await api.post("/crm/customers/interactions", input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "customer360"] });
    },
  });
}

export function useLinkContact(partyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: string; value: string; isPrimary?: boolean }) =>
      (await api.post(`/crm/customers/${partyId}/contacts`, input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "customer360", partyId] });
    },
  });
}

/* --------------------------------------------------------------- Inbox */

export interface ConversationRow {
  id: string;
  channel: string;
  status: string;
  handling: string;
  subject: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  handoffReason: string | null;
  party?: { id: string; name: string; phone: string | null } | null;
  assignedUser: { id: string; name: string } | null;
  store?: { id: string; name: string } | null;
  _count?: { messages: number };
  /** Set when a later ad would have routed this thread elsewhere. */
  routingReviewRequired?: boolean;
  /** The automation rule that routed this, by name. Null if it was deleted. */
  matchedRuleName?: string | null;
  /**
   * What the provider actually told us. A null field means "not provided" and
   * must be rendered as such — never as zero, organic, or a guessed value.
   */
  source?: {
    adId: string | null;
    adSetId: string | null;
    campaignId: string | null;
    /** Presence only. The click id itself is never sent to the browser. */
    clickId: boolean;
    evidence: "measured" | null;
  };
}

export interface MessageRow {
  id: string;
  direction: string;
  authorType: string;
  body: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  status: string;
  /** Why a send failed. Null unless `status` is 'failed'. */
  error: string | null;
  sentAt: string;
  authorUser: { id: string; name: string } | null;
}

export function useConversations(params: {
  status?: string;
  handling?: string;
  channel?: string;
  mine?: boolean;
  /** Threads a later ad tried to reroute. Head office and store managers act on these. */
  routingReview?: boolean;
  /** Inbound traffic not yet linked to a customer. */
  unidentified?: boolean;
  storeId?: string;
  /** Every thread belonging to one customer, newest first. */
  partyId?: string;
}) {
  const storeKey = useStoreKey();
  return useQuery({
    queryKey: ["crm", "conversations", params, storeKey],
    queryFn: async () =>
      (
        await api.get<ConversationRow[]>("/crm/conversations", {
          params: {
            status: params.status,
            handling: params.handling,
            channel: params.channel,
            mine: params.mine ? "true" : undefined,
            routingReview: params.routingReview ? "true" : undefined,
            unidentified: params.unidentified ? "true" : undefined,
            storeId: params.storeId,
            partyId: params.partyId,
          },
        })
      ).data,
  });
}

/**
 * How many threads are in each queue — counted by the SERVER, under the same
 * visibility rules as the list.
 *
 * Counting client-side would count the page that happened to be fetched (the
 * list is capped), and would tell a user how much work exists in a queue they
 * are not allowed to read. The keys match the queue tabs one-for-one.
 */
export function useQueueCounts() {
  const storeKey = useStoreKey();
  return useQuery({
    queryKey: ["crm", "conversations", "queues", storeKey],
    queryFn: async () =>
      (await api.get<Record<string, number>>("/crm/conversations/queues")).data,
  });
}

/* --------------------------------------------------- Routing conflicts */

/** One side of a disputed routing decision. Names are null when the referenced
 *  location, person or rule has since been removed — never back-filled. */
export interface RoutingSide {
  storeId: string | null;
  storeName: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  ruleId: string | null;
  ruleName: string | null;
}

export interface RoutingConflict {
  id: string;
  conversationId: string;
  detectedAt: string;
  originalHandling: string | null;
  proposedHandling: string | null;
  sourceAdId: string | null;
  sourceAdSetId: string | null;
  sourceCampaignId: string | null;
  /** null while unresolved. Never deleted once set — this is the history. */
  resolution: "kept_original" | "accepted_proposed" | "manual" | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
  original: RoutingSide;
  proposed: RoutingSide;
  conversation: {
    id: string;
    channel: string;
    storeId: string | null;
    assignedUserId: string | null;
    handling: string;
    routingReviewRequired: boolean;
    party: { id: string; name: string } | null;
  };
}

/**
 * Routing conflicts. `state` defaults to open; a conversation's detail panel
 * asks for "all" so a resolved decision stays readable as history.
 */
export function useRoutingConflicts(
  params: { state?: "open" | "resolved" | "all"; conversationId?: string } = {},
  options: { enabled?: boolean } = {},
) {
  const storeKey = useStoreKey();
  return useQuery({
    queryKey: ["crm", "routing-conflicts", params, storeKey],
    enabled: options.enabled ?? true,
    queryFn: async () =>
      (
        await api.get<RoutingConflict[]>("/crm/conversations/routing-conflicts", {
          params: { state: params.state, conversationId: params.conversationId },
        })
      ).data,
  });
}

/**
 * Everything that can change when a thread is rerouted: the thread itself, the
 * lists it may have entered or left, the tab counts, and the conflict history.
 * One helper so no call site can invalidate three of the four and leave a queue
 * badge disagreeing with the list under it.
 */
function invalidateRouting(qc: ReturnType<typeof useQueryClient>, conversationId?: string) {
  if (conversationId) {
    void qc.invalidateQueries({ queryKey: ["crm", "conversation", conversationId] });
  }
  void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
  void qc.invalidateQueries({ queryKey: ["crm", "routing-conflicts"] });
  void qc.invalidateQueries({ queryKey: ["crm", "activity"] });
}

/**
 * Route a conversation: destination location, owner and handling move together
 * in ONE server call, because they are one decision. The server refuses an owner
 * who does not work at the destination — this hook does not try to second-guess
 * that, it surfaces the message.
 */
export function useAssignConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      /** null returns the thread to the central queue. Omit to leave unchanged. */
      storeId?: string | null;
      /** null clears the owner. Omit to leave unchanged. */
      assignedUserId?: string | null;
      handling?: string;
      reason?: string;
    }) =>
      (await api.post(`/crm/conversations/${conversationId}/assign`, input)).data,
    onSuccess: () => invalidateRouting(qc, conversationId),
  });
}

/**
 * Decide a routing conflict. Exactly the three outcomes the server implements —
 * there is no fourth, and none of them deletes the conflict record.
 */
export function useResolveRoutingConflict(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      conflictId: string;
      decision: "kept_original" | "accepted_proposed" | "manual";
      storeId?: string | null;
      assignedUserId?: string | null;
      handling?: string;
      note?: string;
    }) => {
      const { conflictId, ...body } = input;
      return (
        await api.post(
          `/crm/conversations/routing-conflicts/${conflictId}/resolve`,
          body,
        )
      ).data;
    },
    onSuccess: () => invalidateRouting(qc, conversationId),
  });
}

export function useConversationThread(id: string | null) {
  return useQuery({
    queryKey: ["crm", "conversation", id],
    enabled: !!id,
    queryFn: async () =>
      (
        await api.get<{ conversation: ConversationRow; messages: MessageRow[] }>(
          `/crm/conversations/${id}`,
        )
      ).data,
  });
}

/**
 * Sends a reply. `delivery.state` is "queued" when the outbox accepted it, or
 * "saved" when it was written to the thread but deliberately not sent — the
 * customer opted out, or the 24-hour window has closed. `delivery.note` says
 * which, in words meant for the person who typed it.
 * Historically this was always "queued" because
 * nothing can actually deliver to WhatsApp or Instagram until an integration is
 * connected — the UI shows that state verbatim rather than claiming "sent".
 */
export function useSendReply(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: string }) =>
      (
        await api.post<{ delivery: { state: string; note: string } }>(
          `/crm/conversations/${conversationId}/messages`,
          input,
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "conversation", conversationId] });
      void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
    },
  });
}

/**
 * Status, handling and handoff notes.
 *
 * NOT ownership: `assignedUserId` was removed from this endpoint because it
 * accepted anyone in the organisation without checking they work at the
 * conversation's location. Use `useAssignConversation`, which validates the
 * destination and the owner together. The server rejects the field outright now,
 * so sending it here fails loudly rather than quietly misrouting work.
 */
export function useUpdateConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      status?: string;
      handling?: string;
      handoffReason?: string;
    }) => (await api.patch(`/crm/conversations/${conversationId}`, input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "conversation", conversationId] });
      void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
    },
  });
}

/* ------------------------------------------------------------- Activity */

export function useActivityFeed(params: { limit?: number; types?: string } = {}) {
  const storeKey = useStoreKey();
  return useQuery({
    queryKey: ["crm", "activity", params, storeKey],
    queryFn: async () =>
      (await api.get<TimelineEvent[]>("/crm/activity", { params })).data,
  });
}

/* ------------------------------------------------------------- Pipelines */

export interface PipelineStage {
  id: string;
  code: string;
  label: string;
  sortOrder: number;
  outcome: string;
  systemValue: string | null;
  probability: number | null;
  isActive: boolean;
}

export interface Pipeline {
  id: string;
  code: string;
  name: string;
  entity: string;
  isDefault: boolean;
  stages: PipelineStage[];
}

export function usePipelines() {
  return useQuery({
    queryKey: ["crm", "pipelines"],
    queryFn: async () => (await api.get<Pipeline[]>("/crm/pipelines")).data,
  });
}

/**
 * The stage columns the lead board should actually show.
 *
 * `Lead.stage` is a closed Prisma enum, so a configured stage can only hold
 * leads if it declares which enum value it means (`systemValue`). Stages without
 * one are returned separately as `unmapped` rather than rendered as columns that
 * could never fill — a permanently-empty column reads as a bug, not as a
 * configuration gap.
 *
 * Falls back to the built-in three-stage funnel when a tenant has configured no
 * pipeline, so an organisation that never opens the configuration screen (which
 * is every existing Eclat store) sees exactly what it saw before.
 */
export function useLeadStages() {
  const { data, isLoading } = usePipelines();
  const pipeline = data?.find((p) => p.isDefault) ?? data?.[0];
  const active = pipeline?.stages.filter((s) => s.isActive) ?? [];
  const mapped = active.filter((s) => s.systemValue);

  return {
    isLoading,
    configured: mapped.length > 0,
    pipelineName: pipeline?.name ?? null,
    stages: mapped.length
      ? mapped.map((s) => ({
          id: s.systemValue as LeadStage,
          label: s.label,
          probability: s.probability,
        }))
      : LEAD_STAGES.map((s) => ({ ...s, probability: null })),
    /** Configured, but not yet tied to a lead status — surfaced, never hidden. */
    unmapped: active.filter((s) => !s.systemValue),
  };
}

export function useEnsureDefaultPipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post("/crm/pipelines/ensure-default", {})).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "pipelines"] }),
  });
}

/**
 * Add or rename a stage. Upsert on (pipeline, code): the same call creates a new
 * stage and edits an existing one, which is what the server does — a separate
 * "update" hook here would just be a second name for one endpoint.
 */
export function useUpsertStage(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      code: string;
      label: string;
      sortOrder?: number;
      outcome?: string;
      /**
       * Which `Lead.stage` enum value this means. Without it the stage is
       * display-only and no lead can sit in it — see `useLeadStages`.
       */
      systemValue?: string;
      probability?: number;
    }) => (await api.post<PipelineStage>(`/crm/pipelines/${pipelineId}/stages`, input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "pipelines"] }),
  });
}

/** Deactivate, not delete — leads already sitting in the stage keep their history. */
export function useDeactivateStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (stageId: string) =>
      (await api.delete(`/crm/pipelines/stages/${stageId}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "pipelines"] }),
  });
}

/* -------------------------------------------------------- Identity admin */

export interface MergeCandidate {
  id: string;
  matchKind: string;
  matchValue: string;
  confidence: string;
  status: string;
  reason: string | null;
  createdAt: string;
  primaryParty: { id: string; name: string; phone: string | null; createdAt: string } | null;
  duplicateParty: { id: string; name: string; phone: string | null; createdAt: string } | null;
}

export function useMergeCandidates() {
  return useQuery({
    queryKey: ["crm", "merge-candidates"],
    queryFn: async () =>
      (await api.get<MergeCandidate[]>("/crm/identity/merge-candidates")).data,
  });
}

export function useBackfillIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (limit?: number) =>
      (
        await api.post<{
          scanned: number;
          created: number;
          skippedUnparseable: number;
          conflicts: number;
          message: string;
        }>("/crm/identity/backfill", { limit })
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm"] }),
  });
}

export function useRejectMerge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reason?: string }) =>
      (
        await api.post(`/crm/identity/merge-candidates/${input.id}/reject`, {
          reason: input.reason,
        })
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm", "merge-candidates"] }),
  });
}
