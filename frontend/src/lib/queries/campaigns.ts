import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

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

/**
 * Where one `{{n}}` gets its value when a broadcast goes out.
 *
 * Mirrors VARIABLE_SOURCES in the backend's campaign-variables. `fallback` is
 * not optional for anything read off the customer: Meta refuses a message with
 * a blank value in it, so a customer with no name recorded would fail the send
 * rather than merely read oddly.
 */
export type CampaignVariableSource =
  | "customer_first_name"
  | "customer_name"
  | "branch_name"
  | "fixed";

export interface CampaignVariable {
  slot: number;
  source: CampaignVariableSource;
  text?: string;
  fallback: string;
}

export const CAMPAIGN_VARIABLE_SOURCES: { value: CampaignVariableSource; label: string }[] = [
  { value: "customer_first_name", label: "Customer's first name" },
  { value: "customer_name", label: "Customer's full name" },
  { value: "branch_name", label: "Their branch" },
  { value: "fixed", label: "The same wording for everyone" },
];

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  channel: string;
  status: CampaignStatus;
  segmentId: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  templateVariables: CampaignVariable[] | null;
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
  /** Contactable less the blocked — the figure the campaign later calls `targeted`. */
  sendable: number;
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
  fields: {
    field: string;
    label: string;
    ops: { op: string; label: string }[];
    hint?: string;
    /**
     * A fixed vocabulary, when the field has one.
     *
     * `value` is the database's own word and `label` is the one a jeweller
     * uses. Typing into these used to be possible and produced "Something went
     * wrong": the text went to Postgres as an enum value and was refused, so a
     * plausible word like "customer" on Enquiry stage crashed the preview
     * instead of matching nobody.
     */
    options?: { value: string; label: string }[];
  }[];
}[] = [
  {
    label: "Who they are",
    fields: [
      {
        /*
         * Tags, first in the list because they are how the client segments:
         * "Meta Leads", "Walk-in Leads", a tag per branch. Both operators are
         * offered — the exclusion is the half she asked for by name, and the
         * compiler honours it with a real NOT rather than silently including.
         *
         * "Has ALL of these" is one rule per tag with Match set to "all of
         * these"; there is no separate operator to learn.
         */
        field: "party.tag",
        label: "Tag",
        ops: [
          { op: "in", label: "has any of" },
          { op: "not_in", label: "does not have" },
        ],
        hint: "Picked from your own tags — Meta Leads, Walk-in Leads, a branch tag",
      },
      {
        field: "party.type",
        label: "Record type",
        ops: [{ op: "in", label: "is one of" }],
        options: [
          { value: "customer", label: "Customer" },
          { value: "supplier", label: "Supplier" },
          { value: "staff", label: "Staff" },
          { value: "salesperson", label: "Salesperson" },
          { value: "branch", label: "Branch" },
          { value: "account", label: "Account" },
        ],
      },
      {
        /*
         * The branch a customer belongs to.
         *
         * The chips under the rules already narrow a broadcast to branches,
         * but only as a filter over the whole audience. As a RULE it composes:
         * "at Bandra OR tagged Meta Leads", or "everyone except Head Office".
         * The client asked for it beside City, and the compiler has always
         * understood the field — it was simply never offered.
         *
         * Options are the tenant's own branches, so they are filled in by the
         * screen from the session rather than listed here.
         */
        field: "party.storeId",
        label: "Branch",
        ops: [
          { op: "in", label: "is one of" },
          { op: "not_in", label: "is not one of" },
        ],
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
      {
        field: "lead.stage",
        label: "Enquiry stage",
        ops: [{ op: "in", label: "is one of" }],
        options: [
          { value: "inquiry", label: "Enquiry" },
          { value: "quotation", label: "Quotation sent" },
          { value: "order_placed", label: "Order placed" },
        ],
      },
      {
        field: "lead.source",
        label: "Enquiry source",
        ops: [{ op: "in", label: "is one of" }],
        options: [
          { value: "walk_in", label: "Walk-in" },
          { value: "phone", label: "Phone" },
          { value: "whatsapp", label: "WhatsApp" },
          { value: "website", label: "Website" },
          { value: "instagram", label: "Instagram" },
          { value: "meta_ads", label: "Meta ad or lead form" },
          { value: "referral", label: "Referral" },
          { value: "imported", label: "Imported from a file" },
        ],
      },
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

/**
 * The recipient list, a page at a time.
 *
 * The endpoint has always paged — it returns a cursor and takes one — and the
 * screen never used it: it loaded fifty rows and printed "showing the first
 * 50" underneath. On a broadcast of 204 that hid three quarters of the people
 * involved, including most of the ones who had not received it, which is the
 * part anybody opening this screen came to look at.
 */
export function useCampaignRecipients(id: string | undefined, status?: string) {
  return useInfiniteQuery({
    queryKey: keys.recipients(id ?? "", status),
    enabled: Boolean(id),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<{ items: CampaignRecipientRow[]; nextCursor: string | null }>(
        `/campaigns/${id}/recipients`,
        {
          params: {
            ...(status ? { status } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
            limit: 50,
          },
        },
      );
      return data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
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
      templateVariables?: CampaignVariable[];
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
  /*
   * "Sent", not "Sent with failures".
   *
   * A broadcast that reached 125 people and skipped 78 who had no usable
   * number is a broadcast that worked. Leading with the failure made the
   * owner read a successful send as a broken one, and his instruction was
   * plain: report what went out. The skipped are still counted, named and
   * explained on the broadcast itself — they are just not the headline.
   */
  partially_failed: "Sent",
  cancelled: "Cancelled",
  failed: "Failed",
};
