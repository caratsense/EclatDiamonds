import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Campaigns and saved audiences.
 *
 * Deliberately industry-neutral throughout: nothing here knows what a tenant
 * sells. The field list a builder offers comes from SEGMENT_FIELD_GROUPS below,
 * whose labels are written for any business, plus whatever custom fields the
 * tenant itself defined.
 */

export type CampaignStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "scheduled"
  | "expanding"
  | "queued"
  | "sending"
  | "completed"
  | "partially_failed"
  | "cancelled"
  | "failed";

export interface CampaignCounts {
  targeted: number;
  excluded: number;
  pending: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  dead: number;
  cancelled: number;
}

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  channel: string;
  status: CampaignStatus;
  segmentId: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  bodyPreview: string | null;
  storeIds: string[];
  scheduledAt: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  expandedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  createdAt: string;
  counts: CampaignCounts;
}

export interface SegmentCondition {
  field: string;
  op: string;
  value?: unknown;
}

export interface SegmentDefinition {
  match: "all" | "any";
  conditions: SegmentCondition[];
}

export interface AudienceSegment {
  id: string;
  name: string;
  description: string | null;
  definition: SegmentDefinition;
  updatedAt: string;
}

export interface AudiencePreview {
  total: number;
  contactable: number;
  consentCheckedAtSend: boolean;
  excluded: { noContactPoint: number; blocked: number };
  reasons: string[];
  sample: {
    id: string;
    name: string;
    contact: string | null;
    city: string | null;
    storeId: string | null;
    blocked: boolean;
  }[];
  sampleCapped: boolean;
  evaluatedAt: string;
}

export interface CampaignRecipientRow {
  id: string;
  partyId: string | null;
  contact: string | null;
  status: string;
  exclusionReason: string | null;
  lastError: string | null;
  sentAt: string | null;
}

/**
 * The fields a person can build an audience from, grouped the way someone
 * thinks about their customers rather than the way the tables are laid out.
 *
 * Mirrors SEGMENT_FIELDS in the backend DSL. Kept as a plain constant rather
 * than fetched, because the compiler that understands these fields ships with
 * the backend release — a list fetched at runtime could offer a field the
 * deployed compiler does not know.
 */
export const SEGMENT_FIELD_GROUPS: {
  label: string;
  fields: { field: string; label: string; ops: { op: string; label: string }[]; hint?: string }[];
}[] = [
  {
    label: "Who they are",
    fields: [
      {
        field: "party.type",
        label: "Record type",
        ops: [{ op: "in", label: "is one of" }],
        hint: "customer, supplier, staff",
      },
      { field: "party.city", label: "City", ops: [{ op: "in", label: "is one of" }, { op: "contains", label: "contains" }] },
      { field: "party.state", label: "State", ops: [{ op: "in", label: "is one of" }] },
      {
        field: "party.createdAt",
        label: "Added",
        ops: [
          { op: "within_days", label: "in the last (days)" },
          { op: "older_than_days", label: "more than (days) ago" },
        ],
      },
      {
        field: "party.importBatchId",
        label: "Came from an import",
        ops: [
          { op: "is_set", label: "yes" },
          { op: "is_not_set", label: "no" },
        ],
      },
    ],
  },
  {
    label: "Where they came from",
    fields: [
      { field: "lead.stage", label: "Enquiry stage", ops: [{ op: "in", label: "is one of" }] },
      { field: "lead.source", label: "Enquiry source", ops: [{ op: "in", label: "is one of" }] },
      {
        field: "lead.createdAt",
        label: "Enquiry raised",
        ops: [
          { op: "within_days", label: "in the last (days)" },
          { op: "older_than_days", label: "more than (days) ago" },
        ],
      },
    ],
  },
  {
    label: "What they have done",
    fields: [
      {
        field: "interaction.lastAt",
        label: "Last activity",
        ops: [
          { op: "within_days", label: "in the last (days)" },
          { op: "older_than_days", label: "nothing for (days)" },
        ],
      },
      {
        field: "transaction.orderCount",
        label: "Has ever bought",
        ops: [
          { op: "lte", label: "never (enter 0)" },
          { op: "gte", label: "at least once (enter 1)" },
        ],
      },
      {
        field: "transaction.totalSpend",
        label: "An order worth at least",
        ops: [{ op: "gte", label: "at least" }],
      },
      { field: "intent.score", label: "Intent score", ops: [{ op: "gte", label: "at or above" }, { op: "lte", label: "at or below" }] },
    ],
  },
  {
    label: "May we contact them",
    fields: [
      {
        field: "consent.marketing",
        label: "Marketing consent",
        ops: [{ op: "eq", label: "is" }],
        hint: "Rechecked for every person at send time regardless of this rule.",
      },
    ],
  },
];

const keys = {
  campaigns: ["campaigns"] as const,
  campaign: (id: string) => ["campaigns", id] as const,
  recipients: (id: string, status?: string) => ["campaigns", id, "recipients", status ?? "all"] as const,
  audiences: ["audiences"] as const,
};

export function useCampaigns(status?: string) {
  return useQuery({
    queryKey: [...keys.campaigns, status ?? "all"],
    queryFn: async () => {
      const { data } = await api.get<Campaign[]>("/campaigns", {
        params: status ? { status } : undefined,
      });
      return data;
    },
  });
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: keys.campaign(id ?? ""),
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await api.get<Campaign>(`/campaigns/${id}`);
      return data;
    },
    /**
     * A campaign that is still going out changes without anyone touching the
     * page, so the detail screen polls while it is in flight and stops the
     * moment it is not. Polling a finished campaign forever is how a dashboard
     * quietly becomes the busiest client of the API.
     */
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["expanding", "queued", "sending"].includes(status) ? 5000 : false;
    },
  });
}

export function useCampaignRecipients(id: string | undefined, status?: string) {
  return useQuery({
    queryKey: keys.recipients(id ?? "", status),
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await api.get<{ items: CampaignRecipientRow[]; nextCursor: string | null }>(
        `/campaigns/${id}/recipients`,
        { params: { ...(status ? { status } : {}), limit: 50 } },
      );
      return data;
    },
  });
}

export function useAudiences() {
  return useQuery({
    queryKey: keys.audiences,
    queryFn: async () => {
      const { data } = await api.get<AudienceSegment[]>("/audiences");
      return data;
    },
  });
}

export function useAudiencePreview() {
  return useMutation({
    mutationFn: async (input: { definition?: SegmentDefinition; segmentId?: string; storeIds?: string[] }) => {
      const { data } = await api.post<AudiencePreview>("/audiences/preview", input);
      return data;
    },
  });
}

export function useSaveAudience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; description?: string; definition: SegmentDefinition }) => {
      const { data } = await api.post<AudienceSegment>("/audiences", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.audiences }),
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string;
      channel?: string;
      segmentId?: string;
      definition?: SegmentDefinition;
      templateName?: string;
      templateLanguage?: string;
      bodyPreview?: string;
      storeIds?: string[];
      scheduledAt?: string;
    }) => {
      const { data } = await api.post<Campaign>("/campaigns", input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.campaigns }),
  });
}

function useCampaignAction<TBody>(path: (id: string) => string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body?: TBody }) => {
      const { data } = await api.post<Campaign>(path(id), body ?? {});
      return data;
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: keys.campaigns });
      void qc.invalidateQueries({ queryKey: keys.campaign(variables.id) });
    },
  });
}

export const useSubmitCampaign = () => useCampaignAction((id) => `/campaigns/${id}/submit`);
export const useApproveCampaign = () => useCampaignAction((id) => `/campaigns/${id}/approve`);
export const useCancelCampaign = () =>
  useCampaignAction<{ reason?: string }>((id) => `/campaigns/${id}/cancel`);
export const useRetryCampaign = () => useCampaignAction((id) => `/campaigns/${id}/retry`);

/** Wording a person can act on, for each state the API can report. */
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Waiting for approval",
  approved: "Approved",
  scheduled: "Scheduled",
  expanding: "Building the list",
  queued: "Queued",
  sending: "Sending",
  completed: "Sent",
  partially_failed: "Sent with failures",
  cancelled: "Cancelled",
  failed: "Failed",
};
