"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { useStoreKey } from "@/lib/queries/keys";
import { useNotificationStream } from "@/lib/queries/notifications";
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

/* --------------------------------------------------------- Customer notes */

export interface CustomerNote {
  id: string;
  kind: string;
  text: string;
  createdAt: string;
  /** Denormalised at write time, so it survives the author leaving. */
  authorName: string | null;
  leadId: string | null;
  /** True when it was written against one opportunity rather than the person. */
  onLead: boolean;
}

/** Notes about this customer, including any left on their leads. Newest first. */
export function useCustomerNotes(partyId: string | null) {
  return useQuery({
    queryKey: ["crm", "customer-notes", partyId],
    enabled: !!partyId,
    queryFn: async () =>
      (await api.get<CustomerNote[]>(`/crm/customers/${partyId}/notes`)).data,
  });
}

export function useAddCustomerNote(partyId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { text: string; kind?: string }) =>
      (await api.post<CustomerNote>(`/crm/customers/${partyId}/notes`, input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "customer-notes", partyId] });
      // The note also lands on the customer's timeline.
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
  party?: {
    id: string;
    name: string;
    phone: string | null;
    /**
     * Tags the branch has put on this customer's OPEN leads, deduplicated and
     * with retired tags dropped. Empty when nobody has tagged them — which is
     * rendered as no chip, never as a placeholder.
     */
    tags?: { id: string; name: string; colour: string | null }[];
  } | null;
  assignedUser: { id: string; name: string } | null;
  store?: { id: string; name: string } | null;
  _count?: { messages: number };
  /**
   * The newest message in the thread, for the list preview. Null when nothing
   * has been said yet — render that as "No messages yet", never as filler.
   */
  lastMessage?: {
    /** Already truncated and de-signed by the server. May be empty. */
    preview: string;
    direction: string;
    authorType: string;
    /** The staff member who sent it, when a person did. */
    authorName: string | null;
  } | null;
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
    /**
     * Which Meta surface the ad was tapped on. Null is genuinely unknown —
     * render nothing rather than defaulting to Facebook.
     */
    platform?: "instagram" | "facebook" | "messenger" | null;
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
  /**
   * The advert this message arrived from, when it arrived from one.
   *
   * Per MESSAGE, not per conversation, and that is the point: the conversation
   * row holds first touch and is never rewritten, so a customer's second ad
   * click is invisible there. Here every click shows on the message it brought
   * in. Null on every message except the first of an ad-originated thread.
   */
  ad: {
    adId: string | null;
    headline: string | null;
    body: string | null;
    sourceUrl: string | null;
    platform: string | null;
    thumbnailUrl: string | null;
  } | null;
  /**
   * What an approved template showed the customer, for a bubble with nothing
   * of its own to show.
   *
   * A template send names a shape the provider holds; the words and the header
   * picture never pass through our message row, so `body` and `mediaUrl` are
   * both null and the bubble was empty. Resolved on read from the template the
   * send named, with this recipient's own values substituted — null on an
   * ordinary typed message.
   */
  template: {
    name: string | null;
    /** 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'TEXT', or null for no header. */
    headerFormat: string | null;
    headerText: string | null;
    /** Meta's own CDN address for the approved file. Expires; best-effort. */
    headerImageUrl: string | null;
    body: string | null;
    footerText: string | null;
  } | null;
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
  /** Conversations no ad brought in. Head office only; the server refuses others. */
  nonAd?: boolean;
  /**
   * Which Meta surface the ad was tapped on — 'instagram' | 'facebook' |
   * 'messenger', or 'unknown' for an ad lead whose referral had no readable
   * source. Distinct from `channel`: one advert runs on both platforms and
   * both send the customer to WhatsApp, so channel cannot separate them.
   */
  sourcePlatform?: string;
  /** Every thread belonging to one customer, newest first. */
  partyId?: string;
  /**
   * Threads a BROADCAST started — any of them, or one campaign's.
   *
   * A customer who was sent a broadcast and then replied has one thread, which
   * is theirs; this finds it by the message the broadcast put in it rather
   * than by labelling the conversation, which would rewrite what that thread
   * is every time another broadcast touched it.
   */
  broadcast?: boolean;
  campaignId?: string;
}) {
  // No `storeId` parameter: the branch travels on `X-Store-Id` with every
  // request, and the server narrows the inbox to it. Sending it here as well
  // would be a second branch control that could disagree with the top bar.
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
            nonAd: params.nonAd ? "true" : undefined,
            sourcePlatform: params.sourcePlatform,
            partyId: params.partyId,
            broadcast: params.broadcast ? "true" : undefined,
            campaignId: params.campaignId,
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
    /*
     * A queued message is a promise still in motion, and the screen has to find
     * out how it ended.
     *
     * The outbox worker settles a send a second or two after the reply is
     * posted, and this query was fetched once when the thread opened and once
     * on the send. So a message that failed kept its "waiting to send" clock
     * until somebody reloaded the page — which is how a store manager sent the
     * same photograph to one customer three times in under a minute. Polling
     * only while something is actually queued; React Query leaves
     * `refetchIntervalInBackground` off, so a tab nobody is looking at is quiet.
     */
    refetchInterval: (q) =>
      q.state.data?.messages.some((m) => m.direction === "outbound" && m.status === "queued")
        ? 4_000
        : false,
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
    mutationFn: async (input: {
      body?: string;
      /** From `useAttachPhoto` — the server only accepts a key it just issued. */
      mediaUrl?: string;
      mediaType?: string;
      mediaFilename?: string;
    }) =>
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
 * Put a photograph in private storage, ready for the next reply to carry.
 *
 * Separate from sending because the two happen at different moments: the
 * salesperson picks the photo, sees it attached, then writes the line that
 * goes with it. The key that comes back is scoped to this conversation — the
 * server refuses any other, so there is nothing useful to tamper with.
 */
export function useAttachPhoto(conversationId: string) {
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (
        await api.post<{
          mediaUrl: string;
          mediaType: string;
          mediaFilename: string;
          bytes: number;
        }>(`/crm/conversations/${conversationId}/attachments`, form)
      ).data;
    },
  });
}

/**
 * Open a thread with a number that has never written in.
 *
 * The 24-hour customer-care window is the whole reason this is not just
 * `useSendReply` with a phone number. A customer who has not messaged has no
 * open window, so the first thing out must be an approved template — the server
 * returns 400 with that sentence if a bare body is sent, and the composer is
 * built to prevent reaching that point rather than to report it afterwards.
 *
 * Returns the conversation it started so the caller can open the thread.
 */
/**
 * The two ContactPoint namespaces a WhatsApp send matches, in the order this
 * dialog asks about them.
 *
 * A number held as a customer's phone and the same number held on their
 * WhatsApp are SEPARATE rows: `ContactPoint` is unique on
 * (organisation, kind, normalised value), so resolving 'whatsapp' alone cannot
 * see a customer the showroom created from the counter — every lead, check-in,
 * quote and invoice resolves as 'phone' (`IdentityService.resolveForRecord`).
 * `sendToContact` matches `kind in ('whatsapp','phone')`, so asking about only
 * one of them would create a SECOND customer carrying the typed name, the
 * chosen branch and the chosen tags, while the thread that was actually opened
 * stayed headed by the original. 'whatsapp' leads because this is a WhatsApp
 * door and that is the kind a new record is created under.
 */
const SEND_MATCHES_KINDS = ["whatsapp", "phone"] as const;

/**
 * Add tags without removing any.
 *
 * `PUT /lead-tags/party/:id` REPLACES the set — which is right where a person
 * is editing a customer's chips and can see what they are removing, and wrong
 * here: this dialog knows only what the sender just picked, and a tag a
 * colleague recorded is not theirs to drop. Same principle as the name.
 *
 * Order is kept so the chips do not reshuffle: what the customer already had,
 * then what was just added.
 */
export function mergeTagIds(existing: string[], picked: string[]): string[] {
  return [...new Set([...existing, ...picked])];
}

/**
 * The send failed, and the sentence has to say what DID happen first.
 *
 * The customer record is written before the message goes (see below for why),
 * so a refused send can leave a customer saved and no message sent. "Could not
 * start that conversation" on its own sends somebody back to retype a name
 * that is already on file.
 *
 * The known cause, stated because the message alone is baffling: a SALESPERSON
 * naming a brand-new customer is refused with "Customer not found", because
 * `assertPartyAccess` reads the new party through `readableParty` — the
 * customers that salesperson is already working with — and a record created a
 * second ago is not one of them yet. Every other role goes through.
 */
export class ThreadStartError extends Error {
  constructor(
    message: string,
    /** What the identity step managed to do before the send was refused. */
    readonly customer?: ResolvedCustomer,
  ) {
    super(message);
    this.name = "ThreadStartError";
  }
}

/** What happened to the tags the sender picked. */
export interface AppliedTags {
  /** Names now on the customer because of this send. Empty when they all were. */
  added: string[];
  /**
   * Set when the tags could not be written. The message still went — tagging is
   * the recoverable half, and the customer screen can finish the job.
   */
  failed?: string;
}

export function useStartWhatsAppThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      to: string;
      /**
       * Who this number belongs to. Optional, and it only ever NAMES A NEW
       * customer — see below for why it can never rename an existing one.
       */
      name?: string;
      /**
       * Which branch a NEW customer belongs to; "" or absent files them at no
       * branch, which is the head-office queue and a real answer.
       */
      storeId?: string;
      /** Existing tag ids to put on the customer, added to whatever they have. */
      tagIds?: string[];
      purpose?: "service" | "marketing";
      body?: string;
      templateName?: string;
      languageCode?: string;
      templateComponents?: unknown[];
    }): Promise<StartedThread> => {
      const { name, storeId, tagIds, ...send } = input;
      const typed = name?.trim();
      const picked = tagIds ?? [];

      /*
       * THE CUSTOMER RECORD IS CREATED FIRST, AND THAT ORDER IS LOAD-BEARING.
       *
       * `POST /omnichannel/messages` decides whose thread this is by looking
       * the number up in ContactPoint, and leaves an unknown number anonymous
       * rather than inventing a customer for it. So a record created after the
       * send would arrive too late and the thread would stay headed by the bare
       * number — which is the whole complaint this field answers. Created
       * before, the send finds it.
       *
       * `resolve` is asked to MATCH before it is ever asked to create, across
       * both kinds the send matches (see SEND_MATCHES_KINDS). A match is left
       * exactly as it is: its customer's name, branch and tags are NOT touched.
       * That is the same rule the inbound path follows with a WhatsApp profile
       * name (`resolveInbound` names a record it creates and never one it
       * matched) — a name a colleague took the trouble to record outranks one
       * typed into a compose box, and so does the branch they filed them at.
       */
      let customer: ResolvedCustomer | undefined;
      if (typed || picked.length) {
        for (const kind of SEND_MATCHES_KINDS) {
          const { data } = await api.post<ResolvedCustomer>("/crm/customers/resolve", {
            kind,
            value: input.to,
          });
          if (data.outcome === "matched") {
            customer = data;
            break;
          }
          // Keep the last answer: its `reason` is what explains an unusable
          // number to the sender if nothing is created either.
          customer = data;
        }

        /*
         * Only a name creates a customer — tags alone cannot, because
         * `IdentityService.resolve` refuses to create a record it would have to
         * call "9876543210".
         *
         * `storeId` is now sent, and sending it is a FIX rather than a detail.
         * A customer created with no branch is refused by the send itself:
         * `assertPartyAccess` rejects a storeless party for anybody but head
         * office, and `visibility()` hides a storeless THREAD from everybody
         * but head office — so naming a new customer used to turn the send
         * into "Customer not found" for every store manager and marketing user
         * in the building. It is the sender's own choice, intersected with
         * their scope by `assertStore` on the server; the branch picker never
         * offers one they do not hold.
         */
        if (customer?.outcome !== "matched" && typed) {
          customer = (
            await api.post<ResolvedCustomer>("/crm/customers/resolve", {
              kind: "whatsapp",
              value: input.to,
              name: typed,
              ...(storeId ? { storeId } : {}),
              createIfMissing: true,
            })
          ).data;
        }
      }

      let data: Omit<StartedThread, "customer" | "tags">;
      try {
        data = (
          await api.post<Omit<StartedThread, "customer" | "tags">>("/omnichannel/messages", {
            purpose: "service",
            ...send,
          })
        ).data;
      } catch (err) {
        const why = apiErrorMessage(err, "Could not start that conversation.");
        throw new ThreadStartError(
          customer?.outcome === "created"
            ? `${why} ${typed} was saved as a customer, but the message was not sent.`
            : why,
          customer,
        );
      }

      /*
       * TAGS GO ON LAST, AFTER THE SEND, and that order is load-bearing too.
       *
       * `/lead-tags/party/:id` reaches a customer through `readableParty`,
       * which for a SALESPERSON means the customers they are working with —
       * by an owned lead, a visit they served, or a thread assigned to them. A
       * customer created a moment ago by this dialog is none of those yet. The
       * send is what links them: `findOrCreateContactThread` assigns the new
       * thread to the sender, so by the time these two calls run the customer
       * is theirs to label.
       *
       * It is also the right way round if something fails: a tag that did not
       * stick can be applied from the customer screen, a message that did not
       * go cannot be un-sent.
       */
      let tags: AppliedTags | undefined;
      if (picked.length && customer?.partyId) {
        const partyId = customer.partyId;
        try {
          const existing = (await api.get<{ id: string; name: string }[]>(
            `/lead-tags/party/${partyId}`,
          )).data;
          const merged = mergeTagIds(
            existing.map((t) => t.id),
            picked,
          );
          const after =
            merged.length === existing.length
              ? existing
              : (await api.put<{ id: string; name: string }[]>(`/lead-tags/party/${partyId}`, {
                  tagIds: merged,
                })).data;
          const had = new Set(existing.map((t) => t.id));
          tags = { added: after.filter((t) => !had.has(t.id)).map((t) => t.name) };
        } catch (err) {
          tags = { added: [], failed: apiErrorMessage(err, "The tags could not be applied.") };
        }
      }

      return { ...data, customer, tags };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
      // The thread it just created is headed by a customer the directory and
      // Customer 360 have not seen yet.
      void qc.invalidateQueries({ queryKey: ["parties"] });
      // And that customer may have just been labelled, which the directory's
      // chips and the tag counts in Settings both read.
      void qc.invalidateQueries({ queryKey: ["lead-tags"] });
    },
  });
}

/** What `POST /crm/customers/resolve` says it did. */
export interface ResolvedCustomer {
  partyId: string | null;
  /**
   * `created` — this name is now the customer's name. `matched` — the number
   * was already on file and the name it already had was KEPT. `unresolved` —
   * nothing was created and `reason` says why.
   */
  outcome: "matched" | "created" | "unresolved";
  contactPointId: string | null;
  reason?: string;
}

export interface StartedThread {
  conversationId: string;
  messageId: string;
  status: string;
  deduplicated: boolean;
  policy?: { mode?: string };
  /**
   * What happened to the customer record. Absent when neither a name nor a tag
   * was given, because then no record was touched.
   */
  customer?: ResolvedCustomer;
  /** What happened to the tags. Absent when none were picked. */
  tags?: AppliedTags;
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

/* ------------------------------------------------- The inbox, kept current */

/**
 * What a pushed notification means for the inbox.
 *
 * Read off `entityType`, NOT off `kind`. Every push that concerns a thread
 * stamps `entityType: 'Conversation'` with its id — lead routing
 * (`lead_assigned`), the bot handing a customer to a person (`reminder`) and an
 * SLA breach (`reminder`) all do — whereas `kind` is shared with events that
 * have nothing to do with this screen. A leave request or a discount approval
 * must not refetch the inbox: a manager whose bell is busy would otherwise be
 * refetching the conversation list all day for events that cannot change it.
 *
 * Exported for its own sake because it is the rule, and a rule that is wrong in
 * either direction is invisible — too narrow and the inbox goes stale again,
 * too wide and every bell in the building becomes a refetch.
 */
export function inboxRefreshTarget(n: {
  kind: string;
  entityType: string | null;
  entityId: string | null;
}): { list: boolean; conversationId: string | null } {
  // `lead_assigned` is kept as a second route in because its whole subject IS a
  // conversation; if a future emit forgets the entity stamp, the list still
  // refreshes even though the open thread cannot be pinpointed.
  if (n.entityType === "Conversation") {
    return { list: true, conversationId: n.entityId };
  }
  if (n.kind === "lead_assigned") return { list: true, conversationId: null };
  return { list: false, conversationId: null };
}

/**
 * New threads and new messages appear without a refresh.
 *
 * Rides the notification stream that already exists rather than opening
 * anything of its own, and deliberately adds no polling. That stream holds ONE
 * connection per browser — six tabs each holding their own used up all six of
 * HTTP/1.1's connections to the origin and left actual page loads queued, which
 * is why the tabs elect a leader — so a second stream here would reintroduce
 * exactly that. `useNotificationStream` fires its callback in the follower tabs
 * too, from the leader's rebroadcast, so this works in every tab whether or not
 * it is the one holding the socket.
 *
 * Invalidation rather than patching the cache: the pushed row says only that
 * something changed, and the list is the authority on what it now looks like.
 *
 * KNOWN GAP, so nobody reads more into this than it does: an ordinary reply
 * from a customer emits no notification at all unless it causes a handoff, so
 * the thread it landed in is still refreshed by the open thread's own poll
 * rather than by the push. Closing that needs a server-side event per inbound
 * message.
 */
export function useLiveInbox() {
  const qc = useQueryClient();
  useNotificationStream((n) => {
    const target = inboxRefreshTarget(n);
    if (!target.list) return;
    // Matches the lists AND the queue counts, which share this prefix — a badge
    // that disagrees with the list under it is the bug that pairs them.
    void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
    if (target.conversationId) {
      void qc.invalidateQueries({
        queryKey: ["crm", "conversation", target.conversationId],
      });
    }
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
