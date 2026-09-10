"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, Inbox, Megaphone, Send, TrendingUp, User as UserIcon } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useConversationThread,
  useConversations,
  useQueueCounts,
  useSendReply,
  useUpdateConversation,
} from "@/lib/queries/crm";
import { ChannelStatus } from "@/components/crm/channel-status";
import { AssignConversationDialog } from "@/components/crm/assign-conversation-dialog";
import { QualificationPanel } from "@/components/crm/qualification-panel";
import { IntentAnalysisPanel } from "@/components/crm/intent-analysis-panel";
import { AiDraftPanel } from "@/components/crm/ai-draft-panel";
import { RoutingAuditTrail, RoutingConflictPanel } from "@/components/crm/routing-conflict-panel";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

/**
 * The unified inbox (CaratOS Phase A3/A11/2B).
 *
 * Channel-neutral: nothing on this screen knows what WhatsApp or Instagram is.
 * A thread is a thread, and its `channel` is a label. Industry-neutral too — a
 * conversation, a customer, a location and a team member, with no vocabulary
 * belonging to any one trade.
 *
 * THE HONESTY THAT MATTERS HERE: a reply is saved and shown as QUEUED, not sent.
 * Nothing in this system can deliver to a messaging provider until an
 * integration is connected, and a salesperson who believes a customer received
 * their message when nobody did is worse off than one who is told plainly.
 */

/**
 * The operational queues.
 *
 * Every one of these narrows what the SERVER returns; none is a client-side
 * filter over a wider result set, and the counts beside them are counted by the
 * server under the same rules. Backend authorization is the authority, so a
 * queue cannot become a way to see something the caller is not entitled to —
 * the central storeless queue in particular is head-office only and simply comes
 * back empty for everyone else.
 *
 * `key` doubles as the `?queue=` value and as the key of the counts response.
 */
const QUEUES = [
  { key: "open", label: "Open", params: { status: "open" } },
  { key: "mine", label: "Assigned to me", params: { mine: true } },
  { key: "unassigned", label: "Unassigned", params: { handling: "unassigned" } },
  { key: "human", label: "Needs a person", params: { handling: "human" } },
  { key: "ai", label: "With the assistant", params: { handling: "ai" } },
  { key: "review", label: "Routing review", params: { routingReview: true } },
  { key: "unknown", label: "Unidentified", params: { unidentified: true } },
  { key: "closed", label: "Closed", params: { status: "closed" } },
] as const;

type QueueKey = (typeof QUEUES)[number]["key"];

const isQueueKey = (v: string | null): v is QueueKey =>
  QUEUES.some((q) => q.key === v);

/**
 * Next 16 requires a client component that calls `useSearchParams` to sit under
 * a Suspense boundary: without one the production build fails outright with
 * "Missing Suspense boundary with useSearchParams". It works in dev either way,
 * which is exactly why this is easy to ship broken.
 */
export default function ConversationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ConversationsInbox />
    </Suspense>
  );
}

/**
 * Both the selected queue and the open thread live in the URL.
 *
 * There is no local mirror of either, so there is nothing to synchronise: a
 * refresh, a bookmark and a pasted link all land on exactly what the sender was
 * looking at. This replaces an earlier keyed-remount that existed only to keep
 * local state and the URL from disagreeing — with the URL as the single source
 * there is no disagreement to manage, and no effect.
 */
function ConversationsInbox() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get("queue");
  const queue: QueueKey = isQueueKey(raw) ? raw : "open";
  /*
   * One customer's threads, arrived at from somewhere else in the product.
   *
   * "Chat" on a lead card, a floor task or a calling row is one tap: it lands
   * on that person's newest conversation with no queue to hunt through and no
   * dialog in between. Before this, the link carried the party id and this
   * screen ignored it — every one of those buttons opened the general inbox and
   * left the salesperson to find the thread by name.
   */
  const partyId = searchParams.get("partyId");

  const navigate = (next: {
    queue?: QueueKey;
    thread?: string | null;
    partyId?: string | null;
  }) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next.queue !== undefined) {
      params.set("queue", next.queue);
      // Choosing a queue means leaving the single-customer view. Keeping both
      // would show a queue label above a list that ignores it.
      params.delete("partyId");
      params.delete("thread");
    }
    if (next.partyId !== undefined) {
      if (next.partyId) params.set("partyId", next.partyId);
      else params.delete("partyId");
    }
    if (next.thread !== undefined) {
      if (next.thread) params.set("thread", next.thread);
      else params.delete("thread");
    }
    // `replace`, not `push`: flicking between queues is browsing, not a trail of
    // steps somebody wants to walk back through one at a time.
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const active = QUEUES.find((q) => q.key === queue)!;
  // The party filter is applied by the SERVER, under the same visibility rules
  // as every queue — asking for a customer whose threads sit in a branch this
  // caller cannot read returns nothing, not that branch's inbox.
  const list = useConversations(partyId ? { partyId } : active.params);
  const counts = useQueueCounts();

  /*
   * Opening a customer opens their newest thread, without writing to the URL.
   *
   * Derived rather than pushed into the address bar by an effect: an effect
   * would render the empty right-hand pane first and correct it a frame later,
   * and would fight the back button. An explicit `?thread=` still wins, so a
   * shared link keeps pointing at the thread it named.
   */
  const selected =
    searchParams.get("thread") ?? (partyId ? (list.data?.[0]?.id ?? null) : null);
  const partyName = partyId ? (list.data?.[0]?.party?.name ?? null) : null;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Conversations"
        purpose="Every customer message, on every channel, in one place."
      />

      <ChannelStatus />

      {partyId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/80 bg-card px-3 py-2 text-sm shadow-sm">
          <Badge variant="secondary">Customer</Badge>
          <span className="font-medium">
            {partyName ?? (list.isLoading ? "Loading…" : "This customer")}
          </span>
          <span className="text-muted-foreground">
            {list.isLoading
              ? ""
              : list.data?.length
                ? `· ${list.data.length} thread${list.data.length === 1 ? "" : "s"}`
                : "· no conversations yet"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => navigate({ partyId: null, thread: null })}
          >
            Show all threads
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {QUEUES.map((q) => {
          const n = counts.data?.[q.key];
          return (
            <Button
              key={q.key}
              size="sm"
              variant={queue === q.key ? "default" : "outline"}
              onClick={() => navigate({ queue: q.key })}
              aria-current={queue === q.key ? "page" : undefined}
            >
              {q.label}
              {/* Only rendered once the server has answered. A "0" while the
                  count is still loading reads as "nothing to do here". */}
              {typeof n === "number" && (
                <Badge variant="secondary" className="ml-1.5">
                  {n}
                </Badge>
              )}
            </Button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Threads</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {list.isLoading ? (
              <>
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </>
            ) : list.isError ? (
              <QueueError error={list.error} onRetry={() => list.refetch()} />
            ) : !list.data?.length ? (
              <p className="text-sm text-muted-foreground">
                {partyId
                  ? "No conversation with this customer yet. One opens as soon as they message you, or when you send them the first message from a connected channel."
                  : "Nothing in this queue. Inbound customer messages appear once a messaging channel is connected in Settings → Integrations."}
              </p>
            ) : (
              list.data.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate({ thread: c.id })}
                  className={`w-full rounded-md border px-3 py-2 text-left transition hover:bg-accent ${
                    selected === c.id ? "border-primary bg-accent" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">
                      {c.party?.name ?? "Unknown sender"}
                    </span>
                    <Badge variant="secondary">{c.channel}</Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {c.handling === "ai" ? (
                      <Bot className="h-3 w-3" />
                    ) : (
                      <UserIcon className="h-3 w-3" />
                    )}
                    <span>{c.handling}</span>
                    {c.assignedUser && <span>· {c.assignedUser.name}</span>}
                    {c.lastMessageAt && (
                      <span>· {new Date(c.lastMessageAt).toLocaleDateString()}</span>
                    )}
                  </div>
                  {/* Where this came from. Shown only when the provider actually
                      told us — an absent ad id is not rendered as "organic". */}
                  {c.source?.adId && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <Megaphone className="h-3 w-3" aria-hidden="true" />
                        Ad {c.source.adId}
                      </Badge>
                      {c.source.evidence === "measured" && (
                        <Badge variant="outline" className="text-[10px]">measured</Badge>
                      )}
                      {c.matchedRuleName && (
                        <Badge variant="outline" className="text-[10px]">{c.matchedRuleName}</Badge>
                      )}
                      {c.store && (
                        <Badge variant="outline" className="text-[10px]">{c.store.name}</Badge>
                      )}
                    </div>
                  )}
                  {/* A later ad wanted a different location. The thread stayed put
                      on purpose; this asks a person to decide. */}
                  {c.routingReviewRequired && (
                    <p className="mt-1 text-xs text-amber-600">
                      Routing review — a later ad pointed to another location
                    </p>
                  )}
                  {/* An unidentified sender is stated, not hidden — someone has to
                      decide who they are before the thread means anything. */}
                  {!c.party && (
                    <p className="mt-1 text-xs text-amber-600">Not linked to a customer</p>
                  )}
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {selected ? (
          <div className="space-y-4">
            <Thread id={selected} />
            {/* Routing sits directly under the thread: the decision is about this
                conversation, and the evidence for it is the messages above. */}
            {/* Assistant drafts sit directly under the thread: the reply being
                judged and the messages it answers must be readable together. */}
            <AiDraftPanel conversationId={selected} />
            <RoutingConflictPanel conversationId={selected} />
            {/* Who moved this thread and when, from the audit log. Renders
                nothing for a salesperson — the endpoint refuses them. */}
            <RoutingAuditTrail conversationId={selected} />
            {/* Qualification sits under the thread it was derived from, so the
                evidence quoted in it is a scroll away from the messages it came
                out of. */}
            <QualificationPanel conversationId={selected} />
          </div>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <EmptyState
                icon={Inbox}
                title="Pick a conversation"
                description="Select a thread on the left to read it and reply."
              />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * A failed queue read, with the reason and a way out.
 *
 * A 403 is called out separately because it is not a transient failure and
 * retrying will not help — the user needs to know it is a permission, not a
 * glitch.
 */
function QueueError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 403) {
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to this queue. Ask an administrator if you think you
        should.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-destructive">
        {apiErrorMessage(error, "Could not load this queue.")}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const { data, isLoading, isError, error, refetch } = useConversationThread(id);
  const send = useSendReply(id);
  const update = useUpdateConversation(id);
  const [draft, setDraft] = useState("");
  const [showIntent, setShowIntent] = useState(false);
  const role = useSession((s) => s.role);
  // The server requires store_manager+ to reroute. This only decides whether to
  // render a control that would 403 — it is a courtesy, not the control itself.
  const canReassign = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6">
          <p className="text-sm text-destructive">
            {apiErrorMessage(error, "Could not open this conversation.")}
          </p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { conversation, messages } = data;

  const onSend = async () => {
    if (!draft.trim() || send.isPending) return;
    try {
      const result = await send.mutateAsync({ body: draft });
      setDraft("");
      // Report exactly what happened. `queued` is not `sent`.
      toast.success(
        result.delivery?.state === "queued" ? "Reply saved" : "Reply sent",
        { description: result.delivery?.note },
      );
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save the reply."));
    }
  };

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">
            {conversation.party ? (
              <Link href={`/customers/${conversation.party.id}`} className="hover:underline">
                {conversation.party.name}
              </Link>
            ) : (
              "Unknown sender"
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {conversation.channel} · {conversation.status} · handled by {conversation.handling}
          </p>
          {/* Where the thread lives and who owns it, stated rather than implied
              by whichever queue happened to be open. */}
          <p className="mt-1 text-xs text-muted-foreground">
            {conversation.store?.name ?? "No location"} ·{" "}
            {conversation.assignedUser?.name ?? "Nobody assigned"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            The colour comes from the VARIANT, not from a hardcoded one.

            This carried `text-emerald-600` alongside `variant="default"`, so
            pressing it filled the button with the primary colour and left the
            label green on top of it — unreadable, and the last emerald left on
            a screen where emerald now means "succeeded" and nothing else.
          */}
          <Button
            size="sm"
            variant={showIntent ? "default" : "outline"}
            className="gap-1 text-xs"
            aria-pressed={showIntent}
            onClick={() => setShowIntent((v) => !v)}
          >
            <TrendingUp className="h-3.5 w-3.5" />
            Intent
            <Badge variant="secondary" className="ml-0.5 px-1 py-0 text-[9px] uppercase">
              Beta
            </Badge>
          </Button>
          {canReassign && (
            <AssignConversationDialog
              conversationId={id}
              current={{
                storeId: conversation.store?.id ?? null,
                assignedUserId: conversation.assignedUser?.id ?? null,
                handling: conversation.handling,
              }}
            />
          )}
          {conversation.handling !== "human" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                update.mutate({ handling: "human", handoffReason: "Taken over manually" })
              }
            >
              Take over
            </Button>
          )}
          {conversation.status !== "closed" && (
            <Button size="sm" variant="ghost" onClick={() => update.mutate({ status: "closed" })}>
              Close
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {showIntent && (
          <IntentAnalysisPanel
            conversationId={id}
            partyId={conversation.party?.id}
            onClose={() => setShowIntent(false)}
            onApplyAction={(text) => setDraft((prev) => (prev ? prev + "\n" + text : text))}
          />
        )}
        <div className="max-h-[26rem] space-y-3 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages in this thread.</p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  m.direction === "inbound"
                    ? "bg-muted"
                    : "ml-auto bg-primary text-primary-foreground"
                }`}
              >
                <p className="whitespace-pre-wrap">{m.body ?? "(attachment)"}</p>
                <p className="mt-1 text-[11px] opacity-70">
                  {m.authorType === "ai" ? "Assistant" : m.authorUser?.name ?? m.authorType}
                  {" · "}
                  {new Date(m.sentAt).toLocaleString()}
                  {/* Delivery state is shown on the message itself, so a queued
                      reply can never be mistaken for a delivered one. */}
                  {m.direction === "outbound" && m.status !== "sent" ? ` · ${m.status}` : ""}
                </p>
              </div>
            ))
          )}
        </div>

        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a reply…"
            rows={3}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Replies are saved to the conversation. They reach the customer once a messaging
              integration is connected.
            </p>
            <Button size="sm" onClick={onSend} disabled={send.isPending || !draft.trim()}>
              <Send className="mr-1 h-3.5 w-3.5" />
              {send.isPending ? "Saving…" : "Reply"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
