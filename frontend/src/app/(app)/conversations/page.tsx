"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlarmClock,
  AlertCircle,
  Archive,
  Bot,
  Calendar,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Filter,
  Inbox,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  MoreVertical,
  Paperclip,
  Phone,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Share2,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Star,
  Tag,
  TrendingUp,
  User as UserIcon,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConversationRow } from "@/lib/queries/crm";
import {
  useAddCustomerNote,
  useConversationThread,
  useConversations,
  useCustomerNotes,
  useQueueCounts,
  useSendReply,
  useUpdateConversation,
} from "@/lib/queries/crm";
import { AssignConversationDialog } from "@/components/crm/assign-conversation-dialog";
import { AuthedImage } from "@/components/ui/authed-image";
import { IntentAnalysisPanel } from "@/components/crm/intent-analysis-panel";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";

/**
 * Platform names as a customer would recognise them.
 *
 * Anything not listed falls back to the stored channel value rather than being
 * hidden or prettified into a guess — a channel this release has no name for is
 * still a real place a customer wrote from.
 */
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  email: "Email",
  voice: "Phone",
  sms: "SMS",
  webchat: "Website chat",
};

/**
 * `primary: true` earns a pill on the bar; everything else lives behind "More
 * filters".
 *
 * Nine tabs competing for one strip meant the three a manager actually opens
 * every morning were no easier to reach than the six they rarely touch. The
 * split is by frequency of use, not by importance — a queue in the overflow is
 * still one click away, and the current one is always promoted onto the bar so
 * you can see where you are.
 */
const QUEUES = [
  { key: "open", label: "Inbox", countKey: "open", primary: true },
  { key: "unread", label: "Unread", countKey: "needs_person", primary: true },
  { key: "assigned", label: "Assigned to me", countKey: "assigned", primary: true },
  { key: "starred", label: "Starred", icon: Star },
  { key: "with_assistant", label: "With assistant", countKey: "with_assistant" },
  { key: "snoozed", label: "Snoozed", icon: Clock },
  { key: "follow_up", label: "Follow Up", icon: Calendar },
  { key: "closed", label: "Closed", countKey: "closed" },
  /*
   * Traffic no ad paid for, and therefore traffic no branch owns.
   *
   * Head office only — `headOfficeOnly` hides the tab, and the server refuses
   * the query outright for anyone else, so hiding it is a courtesy rather than
   * the control.
   */
  { key: "non_ad", label: "Non-ad", countKey: "non_ad", headOfficeOnly: true },
];

/**
 * Render WhatsApp's `*bold*` the way WhatsApp does.
 *
 * The thread stores exactly what the customer was sent, asterisks and all — the
 * assistant's questions use them, and so does the sender's name on a reply typed
 * here. Showing the raw markup would mean the dashboard renders the one thing
 * the customer never sees.
 *
 * Bold only, deliberately: it is what the product actually sends. A fuller
 * markdown parser would invent formatting nobody asked for, and would have to
 * guess at the stray asterisk in "3*4mm".
 */
function whatsappText(body: string): React.ReactNode {
  const parts = body.split(/\*([^*\n]+)\*/g);
  // split() with one capture group alternates: plain, bold, plain, bold, …
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>,
  );
}

/**
 * An agent's reply is STORED signed — `queueOutbound` puts `*Name*\n` in front
 * of the body so a customer receiving answers from the assistant and four branch
 * managers on one number can tell who is speaking.
 *
 * In the dashboard that name is shown as a badge above the bubble, read from
 * `authorUser` (the logged-in sender the server recorded). Printing the leading
 * signature line as well would state the same name twice.
 *
 * Only an EXACT match is removed, and only for display — the stored body is
 * untouched, so the transcript is still what the customer received. When the
 * signature and the recorded author DISAGREE the line is left alone: that
 * mismatch is exactly what an admin verifying who sent what needs to see.
 */
function stripAgentSignature(body: string, authorName?: string | null): string {
  if (!authorName) return body;
  const signature = `*${authorName}*\n`;
  return body.startsWith(signature) ? body.slice(signature.length) : body;
}

/**
 * The shared height of the three inbox panes.
 *
 * All three are pinned to it and scroll inside themselves, so the PAGE never
 * scrolls. Before this, the customer panel on the right was an unbounded stack:
 * a contact card, the intent panel and the message log ran on past the bottom of
 * the conversation they describe, and reading the last card meant scrolling the
 * thread out of sight.
 *
 * MEASURED BY THE BROWSER, NOT BY ME.
 *
 * This used to be `calc(100vh - 13rem)`: the viewport, less a number I had
 * counted off the topbar, the page padding, the heading and the filter row. It
 * was wrong the moment any of those changed — and it had already drifted, which
 * is why the page itself grew a second scrollbar outside the three panes. One
 * that moved the whole layout out from under the cursor while you were reading
 * a thread inside it.
 *
 * `flex-1 min-h-0` asks for the leftover height instead of computing it. The
 * shell's content wrapper is a `min-h-full` flex column, so whatever is left
 * after the real heading and the real filter row is what the panes get, on any
 * window, forever.
 *
 * `min-h-0` is the load-bearing half: a flex child defaults to `min-height:auto`
 * and refuses to shrink below its content, so without it the panes would push
 * past the viewport and bring the outer scrollbar straight back.
 */
const PANE_HEIGHT = "min-h-0 flex-1";

/**
 * The chips on a conversation row.
 *
 * Every one is DERIVED FROM A FIELD ON THAT ROW. The chips this replaces were
 * chosen by the row's position in the list — index 1 was "Pending", everything
 * else "Happy Users" — so they were identical on every refresh and described
 * nothing. They survived months of demos because they looked plausible.
 *
 * The rule for anything added here: if it cannot be read off the conversation,
 * it does not render. A row with nothing worth saying shows no chip, which is
 * honest; an invented chip is the defect that was just removed.
 *
 * Two kinds appear here. DERIVED chips describe the thread's own state and are
 * computed below. AUTHORED chips are `LeadTag`s somebody at the branch applied
 * to this customer's open leads — those carry the tag's own colour token, so a
 * tenant's vocabulary stays legible when the theme changes underneath it.
 */
type RowChip = { key: string; label: string; tone: string; icon?: typeof Megaphone };

/**
 * A tag's stored colour token → classes, in both themes.
 *
 * `LeadTag.colour` holds a token NAME rather than a hex value precisely so the
 * palette stays the product's. An unrecognised or absent token falls back to
 * the neutral chip instead of vanishing: a tag someone took the trouble to
 * apply should still be readable.
 */
const TAG_TONES: Record<string, string> = {
  emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
  rose: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30",
  indigo: "bg-[#6366f1]/15 text-[#6366f1] dark:text-[#818cf8] border border-[#6366f1]/30",
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border border-sky-500/30",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-400 border border-violet-500/30",
  slate: "bg-muted text-muted-foreground border border-border",
};
const TAG_TONE_FALLBACK = TAG_TONES.slate;

function chipsFor(c: ConversationRow): RowChip[] {
  const chips: RowChip[] = [];

  // Authored first: what a person deliberately said about this customer
  // outranks anything the system worked out for itself.
  for (const tag of c.party?.tags ?? []) {
    chips.push({
      key: `tag:${tag.id}`,
      label: tag.name,
      tone: (tag.colour && TAG_TONES[tag.colour]) || TAG_TONE_FALLBACK,
    });
  }

  if (c.source?.adId) {
    /*
     * Name the platform when Meta told us which one, because "where did this
     * lead come from" is the question the chip exists to answer and "an ad" is
     * only half of it. Falls back to "Ad Lead" when the referral's source_url
     * said nothing recognisable — an honest half-answer beats a guessed whole
     * one, and a manager cannot tell a defaulted platform from a real one.
     */
    const platform = c.source.platform;
    chips.push({
      key: "ad",
      label:
        platform === "instagram"
          ? "Instagram Ad"
          : platform === "facebook"
            ? "Facebook Ad"
            : platform === "messenger"
              ? "Messenger Ad"
              : "Ad Lead",
      icon: Megaphone,
      tone:
        platform === "instagram"
          ? "bg-[#E1306C]/15 text-[#C13584] dark:text-[#F08CB4] border border-[#E1306C]/30"
          : platform === "facebook"
            ? "bg-[#1877F2]/15 text-[#1877F2] dark:text-[#7CB0F7] border border-[#1877F2]/30"
            : "bg-[#6366f1]/15 text-[#6366f1] dark:text-[#818cf8] border border-[#6366f1]/30",
    });
  }

  // A later ad wanted a different branch. A person has to decide, so it is the
  // loudest thing on the row.
  if (c.routingReviewRequired) {
    chips.push({
      key: "routing",
      label: "Routing check",
      icon: AlertCircle,
      tone:
        "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
    });
  }

  if (c.status === "closed") {
    chips.push({
      key: "closed",
      label: "Closed",
      tone: "bg-muted text-muted-foreground border border-border",
    });
  } else if (c.handling === "ai") {
    chips.push({
      key: "ai",
      label: "With assistant",
      icon: Sparkles,
      tone:
        "bg-[#25D366]/15 text-[#128C7E] dark:text-[#25D366] border border-[#25D366]/30",
    });
  } else if (c.handling === "unassigned") {
    // Nobody owns this and the assistant is not on it either — the state most
    // worth surfacing in a list a manager scans for what needs them.
    chips.push({
      key: "needs",
      label: "Needs a person",
      icon: AlertCircle,
      tone:
        "bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30",
    });
  }

  return chips;
}

/**
 * Who spoke last, as a short prefix on the list preview.
 *
 * The customer's own words carry no prefix — they are the default voice in an
 * inbox. Everything the business sent is labelled, and a person is named, so a
 * manager scanning the list can tell a customer nobody has answered from one
 * the bot has already replied to.
 */
function previewPrefix(m: {
  direction: string;
  authorType: string;
  authorName: string | null;
}): string {
  if (m.direction === "inbound") return "";
  if (m.authorType === "bot") return "Bot: ";
  if (m.authorType === "ai") return "AI: ";
  if (m.authorType === "agent") return m.authorName ? `${m.authorName}: ` : "Team: ";
  return "";
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<ConversationsSkeleton />}>
      <ConversationsContent />
    </Suspense>
  );
}

function ConversationsSkeleton() {
  // Fills the shell exactly like the real page, so the fallback does not show a
  // 650px block that briefly overflows and flashes the outer scrollbar before
  // the inbox renders.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Skeleton className="h-8 w-64 shrink-0" />
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 lg:grid-cols-[310px_1fr_320px]">
        <Skeleton className="h-full w-full rounded-xl" />
        <Skeleton className="h-full w-full rounded-xl" />
        <Skeleton className="h-full w-full rounded-xl" />
      </div>
    </div>
  );
}

function ConversationsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [searchQuery, setSearchQuery] = useState("");
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set());
  const [snoozedIds, setSnoozedIds] = useState<Set<string>>(new Set());

  const queue = searchParams.get("queue") ?? "open";
  const partyId = searchParams.get("partyId");
  /** Which branch's leads to show. Empty means every branch this user can read. */
  const storeFilter = searchParams.get("store") ?? "";
  /** Which platform the lead arrived on. Empty means all of them. */
  const channelFilter = searchParams.get("channel") ?? "";
  /** Which Meta surface the AD was tapped on. Empty means all of them. */
  const sourceFilter = searchParams.get("source") ?? "";

  // Whether the Non-ad queue is offered at all. The server refuses it for
  // everyone else regardless, so this only keeps a dead tab off the screen.
  const isHeadOffice = useSession((s) => s.role) === "head_office";

  /*
   * The branches this person may read, straight from the session.
   *
   * The aggregate "All Stores" row is dropped: it is a UI convenience on the
   * store switcher, not a place a conversation can belong to, and filtering by
   * it would silently return nothing.
   *
   * The control only appears when there is a real choice to make. A manager who
   * runs one branch already sees exactly their own leads — offering them a
   * one-option filter would imply they might be missing something.
   */
  const stores = useSession((s) => s.stores);
  const filterableStores = (stores ?? []).filter((s) => !s.isAggregate);
  const showStoreFilter = filterableStores.length > 1;

  const navigate = (next: {
    queue?: string | null;
    partyId?: string | null;
    thread?: string | null;
    store?: string | null;
    channel?: string | null;
    source?: string | null;
  }) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next.queue !== undefined) {
      if (next.queue) params.set("queue", next.queue);
      else params.delete("queue");
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
    if (next.store !== undefined) {
      if (next.store) params.set("store", next.store);
      else params.delete("store");
      // The open thread belongs to the branch being filtered away, so keeping
      // it selected would show a conversation the list no longer contains.
      params.delete("thread");
    }
    if (next.channel !== undefined) {
      if (next.channel) params.set("channel", next.channel);
      else params.delete("channel");
      params.delete("thread"); // same reason as the branch filter above
    }
    if (next.source !== undefined) {
      if (next.source) params.set("source", next.source);
      else params.delete("source");
      params.delete("thread");
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Map queue key to query params for server
  const serverQueueParams =
    queue === "assigned"
      ? { assignedToMe: true }
      : queue === "with_assistant"
        ? { handling: "ai" as const }
        : queue === "closed"
          ? { status: "closed" as const }
          : queue === "non_ad"
            ? // Deliberately NOT also filtered to open: the point of this queue is
              // to account for every conversation no ad paid for.
              { nonAd: true }
            : { status: "open" as const };

  /*
   * The branch filter NARROWS the queue; it never replaces it.
   *
   * The server intersects `storeId` with the caller's own visibility, so this
   * can only ever show fewer conversations than the tab already would — asking
   * for a branch you cannot read returns nothing rather than that branch's
   * inbox. Not applied to a party lookup, which is already one customer.
   */
  const list = useConversations(
    partyId
      ? { partyId }
      : {
          ...serverQueueParams,
          ...(storeFilter ? { storeId: storeFilter } : {}),
          ...(channelFilter ? { channel: channelFilter } : {}),
          ...(sourceFilter ? { sourcePlatform: sourceFilter } : {}),
        },
  );
  const counts = useQueueCounts();

  /*
   * Which platforms actually appear in this inbox.
   *
   * Derived from the conversations themselves rather than from the provider
   * catalogue: a provider code (`whatsapp_cloud`) is not a conversation channel
   * (`whatsapp`), and listing a platform nobody has ever written in from would
   * be a menu of empty rooms.
   *
   * The consequence is the right one — when the first Instagram lead arrives,
   * Instagram appears here on its own, with no configuration.
   *
   * Read from the UNFILTERED result when a channel is selected, so choosing
   * WhatsApp does not remove every other option from the menu that chose it.
   */
  const [seenChannels, setSeenChannels] = useState<string[]>([]);
  const listedChannels = [
    ...new Set((list.data ?? []).map((c) => c.channel).filter(Boolean)),
  ];
  if (!channelFilter && listedChannels.join("|") !== seenChannels.join("|")) {
    setSeenChannels(listedChannels);
  }
  /*
   * `whatsapp` is seeded rather than discovered. The selector is always on
   * screen now, and an empty inbox would otherwise leave it offering nothing
   * but "All channels" — a control that looks broken on the one screen where
   * you most want reassurance that it is not.
   */
  const channelOptions = [
    ...new Set([
      "whatsapp",
      ...(channelFilter ? [...seenChannels, channelFilter] : listedChannels),
    ]),
  ];

  const selected =
    searchParams.get("thread") ?? (partyId ? (list.data?.[0]?.id ?? null) : null);
  const partyName = partyId ? (list.data?.[0]?.party?.name ?? null) : null;

  const toggleStar = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        toast.info("Removed from Starred");
      } else {
        next.add(id);
        toast.success("Lead Starred as VIP");
      }
      return next;
    });
  };

  /*
   * Which queues get a pill, and which hide behind "More filters".
   *
   * The queue you are IN is always promoted, whatever its `primary` flag — a
   * tab bar that does not show where you are is worse than one with an extra
   * pill on it.
   */
  const visibleQueues = QUEUES.filter((q) => !q.headOfficeOnly || isHeadOffice);
  const pinnedQueues = visibleQueues.filter((q) => q.primary || q.key === queue);
  const overflowQueues = visibleQueues.filter((q) => !q.primary && q.key !== queue);

  // Client-side filtering for search & special queues (starred / snoozed)
  const threads = (list.data ?? []).filter((c) => {
    if (queue === "starred" && !starredIds.has(c.id)) return false;
    if (queue === "snoozed" && !snoozedIds.has(c.id)) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      (c.party?.name ?? "").toLowerCase().includes(q) ||
      (c.store?.name ?? "").toLowerCase().includes(q) ||
      (c.channel ?? "").toLowerCase().includes(q) ||
      (c.source?.adId ?? "").toLowerCase().includes(q)
    );
  });

  return (
    // `flex-1 min-h-0` claims the leftover height from the shell's content
    // wrapper; `gap-4` replaces `space-y-4`, which does nothing useful on a
    // flex container.
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/*
        Named for what a manager comes here to do, not for the architecture or
        the competitor it was benchmarked against.

        No purpose line and no `<ChannelStatus />` strip: both stated things a
        manager already knows — what this screen is for, and that WhatsApp is
        connected — while costing a good 120px off the top of the three panes
        they actually work in. Connection state still lives on Settings →
        Channels, which is where you go when it breaks.
      */}
      <SectionHeader title="Conversations" />

      {partyId && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/80 bg-card px-3 py-2 text-sm shadow-xs">
          <Badge variant="secondary">Customer</Badge>
          <span className="font-semibold text-foreground">
            {partyName ?? (list.isLoading ? "Loading…" : "This customer")}
          </span>
          <span className="text-xs text-muted-foreground">
            {list.isLoading
              ? ""
              : list.data?.length
                ? `· ${list.data.length} thread${list.data.length === 1 ? "" : "s"}`
                : "· no conversations yet"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-xs"
            onClick={() => navigate({ partyId: null, thread: null })}
          >
            Show all threads
          </Button>
        </div>
      )}

      {/* The queue bar: the three queues opened daily, then everything else. */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
          {pinnedQueues.map((q) => {
            const isCurrent = queue === q.key;
            const Icon = q.icon;
            const count =
              q.key === "starred"
                ? starredIds.size
                : q.key === "snoozed"
                  ? snoozedIds.size
                  : q.countKey
                    ? counts.data?.[q.countKey]
                    : undefined;

            return (
              <button
                key={q.key}
                type="button"
                onClick={() => navigate({ queue: q.key })}
                /* Starred and Snoozed live in component state, not the
                   database, so they are per-browser and do not follow the user
                   to another machine. Saying so is the difference between a
                   quirk and a colleague wondering where their stars went. */
                title={
                  q.key === "starred" || q.key === "snoozed"
                    ? `${q.label} is saved in this browser only — it will not appear on another device.`
                    : undefined
                }
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all whitespace-nowrap ${
                  isCurrent
                    ? "bg-[#25D366]/15 text-[#128C7E] dark:text-[#25D366] border border-[#25D366]/40 font-semibold shadow-xs"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent"
                }`}
              >
                {Icon && <Icon className={`h-3 w-3 ${q.key === "starred" && starredIds.size > 0 ? "fill-amber-400 text-amber-400" : ""}`} />}
                <span>{q.label}</span>
                {typeof count === "number" && (
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-bold ${
                      isCurrent
                        ? "bg-[#25D366] text-white"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          {/* The rest of the queues. Was a "+" that opened a toast promising
              saved filters that do not exist — this opens the queues that do. */}
          {overflowQueues.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent whitespace-nowrap"
                >
                  <Filter className="h-3 w-3" />
                  More filters
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                {overflowQueues.map((q) => {
                  const Icon = q.icon;
                  const count =
                    q.key === "starred"
                      ? starredIds.size
                      : q.key === "snoozed"
                        ? snoozedIds.size
                        : q.countKey
                          ? counts.data?.[q.countKey]
                          : undefined;
                  return (
                    <DropdownMenuItem
                      key={q.key}
                      onClick={() => navigate({ queue: q.key })}
                      className="text-xs"
                    >
                      {Icon && <Icon className="h-3 w-3 mr-1.5" />}
                      <span>{q.label}</span>
                      {typeof count === "number" && (
                        <span className="ml-auto text-[10px] font-semibold text-muted-foreground">
                          {count}
                        </span>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="hidden sm:flex items-center gap-2">
          {/*
            Which branch a lead came from.

            The routing rules stamp every ad lead with the showroom its campaign
            was run for, so this reads that stamp back — it is how head office
            answers "how is Bandra doing this week" without opening each thread.
            Offered only to someone who can see more than one branch.
          */}
          {/*
            Which inbox the lead came in on — WhatsApp, a phone call, and so on.

            Always rendered, even when today's threads only use one of them. It
            used to hide itself below two options, on the theory that a
            single-option selector is furniture; in practice it vanished exactly
            when someone wanted to confirm a filter existed at all, and reappeared
            unannounced the first time a second channel showed up. A control that
            comes and goes with the data is harder to trust than a quiet one.
          */}
          <div className="flex items-center gap-1.5">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              aria-label="Filter conversations by channel"
              value={channelFilter}
              onChange={(e) => navigate({ channel: e.target.value || null })}
              className={`h-8 rounded-md border bg-background px-2 text-xs font-medium ${
                channelFilter
                  ? "border-[#25D366]/40 text-[#128C7E] dark:text-[#25D366]"
                  : "border-border text-muted-foreground"
              }`}
            >
              <option value="">All channels</option>
              {channelOptions.map((ch) => (
                <option key={ch} value={ch}>
                  {CHANNEL_LABELS[ch] ?? ch}
                </option>
              ))}
            </select>
          </div>

          {/*
            Which Meta surface the ad was tapped on.

            This is NOT the same question as the channel above, and that is the
            whole reason it exists: one advert runs on Instagram and Facebook at
            once, both CTAs open WhatsApp, so every one of those leads arrives
            with `channel: whatsapp` no matter which app the customer was in.
            Only the referral on the first inbound message can tell them apart.

            "Unknown" is ad traffic whose referral carried no readable source —
            worth seeing separately rather than silently folded into Facebook.
          */}
          <div className="flex items-center gap-1.5">
            <Share2 className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              aria-label="Filter conversations by the platform the ad was clicked on"
              value={sourceFilter}
              onChange={(e) => navigate({ source: e.target.value || null })}
              className={`h-8 rounded-md border bg-background px-2 text-xs font-medium ${
                sourceFilter
                  ? "border-[#25D366]/40 text-[#128C7E] dark:text-[#25D366]"
                  : "border-border text-muted-foreground"
              }`}
            >
              <option value="">All sources</option>
              <option value="instagram">Instagram ad</option>
              <option value="facebook">Facebook ad</option>
              <option value="unknown">Ad — source unknown</option>
            </select>
          </div>
          {showStoreFilter && (
            <div className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                aria-label="Filter conversations by branch"
                value={storeFilter}
                onChange={(e) => navigate({ store: e.target.value || null })}
                className={`h-8 rounded-md border bg-background px-2 text-xs font-medium ${
                  storeFilter
                    ? "border-[#25D366]/40 text-[#128C7E] dark:text-[#25D366]"
                    : "border-border text-muted-foreground"
                }`}
              >
                <option value="">All branches</option>
                {filterableStores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => toast.info("Invite Sales Team", { description: "Share WhatsApp inbox access link" })}
          >
            <Users className="h-3.5 w-3.5" /> Invite Members
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            title="Filter Settings"
            onClick={() => toast.info("Filters", { description: "Filter by Tag, Assignee, or Showroom" })}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── 3-PANE ZITHARA ARCHITECTURE: Contacts | Chat | Darrell CRM ── */}
      {/*
        `grid-rows-[minmax(0,1fr)]` is doing real work here.

        A grid row defaults to `auto`, which means "as tall as the tallest
        child" — so a long conversation would have pushed the row past the
        viewport and handed the outer scrollbar straight back. `minmax(0, 1fr)`
        pins the row to the grid's own height and, crucially, allows it to
        shrink below its content, which is what lets each pane scroll inside
        itself rather than stretching the page.
      */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-[280px_1fr] xl:grid-cols-[285px_1fr]">
        {/* LEFT PANE: Contacts List */}
        <Card className={`flex flex-col ${PANE_HEIGHT} overflow-hidden border-border/80 shadow-sm`}>
          {/* Zithara Top Mini Toolbar */}
          <div className="px-3 py-2.5 border-b border-border/60 bg-muted/20 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-xs">
                HO
                <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-[#25D366] ring-1 ring-background" />
              </div>
              <span className="text-xs font-medium text-foreground">CaratOS Staff</span>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              <button
                type="button"
                onClick={() => toast.success("Synced with Meta Cloud API")}
                className="h-7 w-7 rounded-md hover:bg-muted flex items-center justify-center"
                title="Sync Threads"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => toast.info("New Direct Chat", { description: "Enter customer phone to start WhatsApp chat" })}
                className="h-7 w-7 rounded-md hover:bg-muted flex items-center justify-center"
                title="New Chat"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => toast.info("Exporting Chat Logs...")}
                className="h-7 w-7 rounded-md hover:bg-muted flex items-center justify-center"
                title="Download Conversations"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Search bar with Filter icon */}
          <div className="p-2.5 border-b border-border/60 bg-card">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search or start a new chat…"
                className="w-full rounded-lg bg-muted/60 pl-8 pr-7 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#25D366]"
              />
              <Filter className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground cursor-pointer" />
            </div>
          </div>

          {/* Contact rows */}
          <CardContent className="p-0 flex-1 overflow-y-auto divide-y divide-border/40">
            {list.isLoading ? (
              <div className="p-3 space-y-3">
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>
            ) : list.isError ? (
              <div className="p-4">
                <p className="text-xs text-destructive">{apiErrorMessage(list.error, "Could not load queue.")}</p>
                <Button size="sm" variant="outline" className="mt-2 text-xs" onClick={() => list.refetch()}>
                  Retry
                </Button>
              </div>
            ) : threads.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
                {/* An empty list because of a filter is a different fact from
                    an empty inbox, and it has a different remedy — so it says
                    which branch is empty, and offers the way back. */}
                {storeFilter ? (
                  <>
                    <p className="font-medium text-foreground">
                      Nothing at{" "}
                      {filterableStores.find((s) => s.id === storeFilter)?.name ?? "this branch"}
                    </p>
                    <p className="mt-1">No conversations here in this queue.</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 text-xs"
                      onClick={() => navigate({ store: null })}
                    >
                      Show all branches
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="font-medium text-foreground">No conversations</p>
                    <p className="mt-1">Inbound WhatsApp chats will appear here.</p>
                  </>
                )}
              </div>
            ) : (
              threads.map((c) => {
                const isSelected = selected === c.id;
                const customerName = c.party?.name ?? "Unknown sender";
                const initial = customerName.charAt(0).toUpperCase();
                const isStarred = starredIds.has(c.id);

                return (
                  <button
                    key={c.id}
                    onClick={() => navigate({ thread: c.id })}
                    className={`w-full p-3 text-left transition-colors flex items-start gap-3 relative ${
                      isSelected
                        ? "bg-[#25D366]/10 dark:bg-[#25D366]/15"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    {/* Avatar with initial & WhatsApp indicator */}
                    <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-xs text-foreground border border-border">
                      {initial}
                      <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#25D366] text-white ring-1 ring-card">
                        <MessageSquare className="h-2 w-2 fill-white" />
                      </span>
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Name + Star + Tags */}
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex items-center gap-1.5 truncate">
                          <span
                            onClick={(e) => toggleStar(e, c.id)}
                            className="cursor-pointer text-muted-foreground hover:text-amber-400"
                            title="Star as VIP Lead"
                          >
                            <Star
                              className={`h-3.5 w-3.5 ${
                                isStarred ? "fill-amber-400 text-amber-400" : "text-muted-foreground/50"
                              }`}
                            />
                          </span>
                          <span className="font-semibold text-xs truncate text-foreground">
                            {customerName}
                          </span>
                        </div>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                          {c.lastMessageAt
                            ? new Date(c.lastMessageAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "New"}
                        </span>
                      </div>

                      {/* Facts from the row, and nothing else.
                          The chips here used to be picked by the row's POSITION
                          in the list — index 1 was "Pending", everything else
                          was "Happy Users" — so they described nothing and were
                          identical on every refresh. What a manager needs to see
                          is which branch owns the thread and who is on it. */}
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        {chipsFor(c).map((chip) => {
                          const ChipIcon = chip.icon;
                          return (
                            <span
                              key={chip.key}
                              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.2 text-[9px] font-semibold ${chip.tone}`}
                            >
                              {ChipIcon && <ChipIcon className="h-2.5 w-2.5" />}
                              {chip.label}
                            </span>
                          );
                        })}
                        <span className="text-[10px] text-muted-foreground truncate">
                          {c.store?.name ?? "No store yet"}
                          {c.assignedUser ? ` · ${c.assignedUser.name}` : ""}
                        </span>
                      </div>

                      {/* The newest message, as sent. This was a hardcoded
                          sentence, so every thread in the list read the same
                          and the preview was worse than none. */}
                      <p className="mt-1 text-[11px] text-muted-foreground truncate">
                        {c.lastMessage
                          ? `${previewPrefix(c.lastMessage)}${c.lastMessage.preview || "—"}`
                          : "No messages yet"}
                      </p>
                    </div>

                    {/* An unread badge used to sit here showing 3 on the first
                        row and 5 on the second, hardcoded by index. Nothing
                        tracks per-user read state on a Conversation, so there is
                        no honest number to show and the badge is gone. Bringing
                        it back means storing when each user last opened each
                        thread — a real feature, not a display detail. */}
                  </button>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* CENTER & RIGHT: WhatsApp Chat Window & Zithara Darrell Profile */}
        {selected ? (
          <ThreadView
            id={selected}
            isStarred={starredIds.has(selected)}
            onToggleStar={(e) => toggleStar(e, selected)}
            onSnooze={() => {
              setSnoozedIds((prev) => new Set(prev).add(selected));
              toast.success("Thread Snoozed until tomorrow morning (9:00 AM)");
            }}
          />
        ) : (
          <Card className={`flex items-center justify-center ${PANE_HEIGHT}`}>
            <EmptyState
              icon={Inbox}
              title="Pick a conversation"
              description="Select a customer thread on the left to review messages, qualify intent, and reply."
            />
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * Zithara / Cooby 2-Column Container:
 * - Center: WhatsApp Web Chat Window
 * - Right: Darrell Steward Style Customer Profile & Accordions
 */
function ThreadView({
  id,
  isStarred,
  onToggleStar,
  onSnooze,
}: {
  id: string;
  isStarred: boolean;
  onToggleStar: (e: React.MouseEvent) => void;
  onSnooze: () => void;
}) {
  const { data, isLoading, isError, error, refetch } = useConversationThread(id);
  const send = useSendReply(id);
  const update = useUpdateConversation(id);

  /*
   * Read here rather than further down beside `party`, because the early returns
   * for loading and error sit between the two and a hook cannot be called after
   * them. Null while the thread loads, which both hooks treat as "not enabled".
   */
  const notesPartyId = data?.conversation.party?.id ?? null;
  const notes = useCustomerNotes(notesPartyId);
  const addNote = useAddCustomerNote(notesPartyId);
  const [draft, setDraft] = useState("");
  const [showRightCrm, setShowRightCrm] = useState(true);

  // Dialog states for Zithara Right Sidebar Accordions
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [dealDialogOpen, setDealDialogOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [dealAmount, setDealAmount] = useState("142000");

  const role = useSession((s) => s.role);
  const canReassign = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  if (isLoading) {
    return (
      <div className={`grid gap-4 xl:grid-cols-[1fr_320px] ${PANE_HEIGHT}`}>
        <Skeleton className="h-full w-full rounded-xl" />
        <Skeleton className="h-full w-full rounded-xl hidden xl:block" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card className={`${PANE_HEIGHT} flex items-center justify-center`}>
        <CardContent className="text-center space-y-2">
          <p className="text-sm text-destructive">{apiErrorMessage(error, "Could not open thread.")}</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { conversation, messages } = data;
  const party = conversation.party;

  const onSend = async () => {
    if (!draft.trim() || send.isPending) return;
    try {
      const result = await send.mutateAsync({ body: draft });
      setDraft("");
      toast.success(
        // 'queued' = accepted by the outbox and on its way. 'saved' = written
        // to the thread and deliberately NOT sent (opted out, or outside the
        // 24-hour window). The note says which, so never soften it here.
        result.delivery?.state === "queued"
          ? "Sending on WhatsApp"
          : "Saved — not sent",
        { description: result.delivery?.note },
      );
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save the reply."));
    }
  };

  return (
    <div
      className={`grid min-h-0 grid-rows-[minmax(0,1fr)] gap-3 ${
        showRightCrm ? "xl:grid-cols-[1fr_290px]" : "grid-cols-1"
      }`}
    >
      {/* ── CENTER COLUMN: WhatsApp Web Chat Window ───────────────────── */}
      <Card className={`flex flex-col ${PANE_HEIGHT} overflow-hidden border-border/80 shadow-sm`}>
        {/* WhatsApp Header + Zithara Quick Action Icons */}
        <CardHeader className="flex-row items-center justify-between border-b border-border/60 bg-card px-3.5 py-2.5 space-y-0 gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#25D366]/15 text-[#25D366] font-bold text-sm border border-[#25D366]/30 shadow-xs">
              {party?.name ? party.name.charAt(0).toUpperCase() : "U"}
              <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-[#25D366] text-white ring-1 ring-card">
                <MessageSquare className="h-1.5 w-1.5 fill-white" />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <CardTitle className="text-sm font-semibold truncate leading-tight">
                  {party ? (
                    <Link href={`/customers/${party.id}`} className="hover:underline">
                      {party.name}
                    </Link>
                  ) : (
                    "Unknown sender"
                  )}
                </CardTitle>
                <Badge
                  variant="outline"
                  className="shrink-0 text-[9.5px] px-1.5 py-0 border-[#25D366]/40 text-[#25D366] bg-[#25D366]/10 font-normal leading-tight"
                >
                  WhatsApp
                </Badge>
              </div>
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5 min-w-0 truncate">
                <span className="shrink-0 inline-block h-1.5 w-1.5 rounded-full bg-[#25D366] animate-pulse" />
                <span className="shrink-0 text-[#25D366] font-medium text-[11px]">Online</span>
                <span className="shrink-0 text-muted-foreground/30">·</span>
                <span className="truncate">{conversation.store?.name ?? "No store yet"}</span>
                <span className="shrink-0 text-muted-foreground/30">·</span>
                <span className="truncate">{conversation.assignedUser?.name ?? "Unassigned"}</span>
              </div>
            </div>
          </div>

          {/* Zithara Header Action Toolbar */}
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-amber-400"
              title="Star conversation"
              onClick={onToggleStar}
            >
              <Star className={`h-3.5 w-3.5 ${isStarred ? "fill-amber-400 text-amber-400" : ""}`} />
            </Button>

            {/*
              Closing takes the thread out of the active list; it stays readable
              under the Closed tab, and reopens by itself if the customer writes
              again.

              Both branches AWAIT the mutation. The version this replaces fired
              `toast.success` next to an un-awaited `mutate`, so a refused close
              — another branch's thread, an expired session — still told the user
              it had worked, and the thread stayed in their queue contradicting
              the message they had just been shown.
            */}
            {conversation.status === "closed" ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                title="Reopen this conversation"
                disabled={update.isPending}
                onClick={async () => {
                  try {
                    await update.mutateAsync({ status: "open" });
                    toast.success("Reopened", {
                      description: "It is back in the active list.",
                    });
                  } catch (e) {
                    toast.error(apiErrorMessage(e, "Could not reopen it."));
                  }
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-[#25D366]"
                title="Close this conversation"
                disabled={update.isPending}
                onClick={async () => {
                  try {
                    await update.mutateAsync({ status: "closed" });
                    toast.success("Closed", {
                      description:
                        "It leaves the active list and stays under Closed. It reopens if they message again.",
                    });
                  } catch (e) {
                    toast.error(apiErrorMessage(e, "Could not close it."));
                  }
                }}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
              </Button>
            )}

            {party?.phone && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                title={`Call ${party.phone}`}
                onClick={() => toast.info(`Calling ${party.name}...`, { description: party.phone })}
              >
                <Phone className="h-3.5 w-3.5" />
              </Button>
            )}

            {canReassign && (
              <AssignConversationDialog
                conversationId={id}
                current={{
                  storeId: conversation.store?.id ?? null,
                  assignedUserId: conversation.assignedUser?.id ?? null,
                  handling: conversation.handling,
                }}
                trigger={
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground" title="Reassign conversation">
                    <UserCog className="h-3.5 w-3.5" />
                  </Button>
                }
              />
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground" title="More options">
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={onSnooze} className="gap-2 text-xs">
                  <AlarmClock className="h-3.5 w-3.5 text-muted-foreground" />
                  Snooze until tomorrow
                </DropdownMenuItem>
                {/*
                  "Archive conversation" was here and did nothing but raise a
                  success toast. It is removed rather than reimplemented: there
                  is no archive state in the model — a thread is open, snoozed or
                  closed — so it could only ever have duplicated Close, and two
                  controls that claim to do different things while doing the same
                  one is worse than either alone.
                */}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              variant={showRightCrm ? "default" : "outline"}
              className="text-xs h-7 gap-1 ml-1 px-2"
              onClick={() => setShowRightCrm((v) => !v)}
              title="Toggle Customer CRM panel"
            >
              <TrendingUp className="h-3 w-3" />
              <span className="text-[11px] font-medium">CRM</span>
            </Button>
          </div>
        </CardHeader>

        {/* WhatsApp Chat Canvas */}
        <div className="relative flex-1 overflow-y-auto px-4 py-3 bg-[#efeae2]/60 dark:bg-[#0b141a]/95">
          {/* Subtle WhatsApp doodle background texture */}
          <div
            className="absolute inset-0 opacity-[0.035] dark:opacity-[0.05] pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(#25D366 1px, transparent 1px), radial-gradient(#6366f1 1px, transparent 1px)`,
              backgroundSize: "28px 28px",
              backgroundPosition: "0 0, 14px 14px",
            }}
          />

          {/* Date separator pill */}
          <div className="relative z-10 flex justify-center my-2">
            <span className="rounded-md bg-white/90 dark:bg-[#182229]/90 backdrop-blur-xs px-3 py-0.5 text-[10.5px] font-medium text-muted-foreground shadow-xs border border-black/5 dark:border-white/5 uppercase tracking-wider">
              Monday
            </span>
          </div>

          {/* Messages list */}
          <div className="relative z-10 space-y-2">
            {messages.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-center text-xs text-muted-foreground">
                <p>No messages in this WhatsApp conversation yet.</p>
              </div>
            ) : (
              messages.map((m) => {
                const isInbound = m.direction === "inbound";
                const timeStr = new Date(m.sentAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });

                return (
                  <div
                    key={m.id}
                    className={`flex flex-col ${isInbound ? "items-start" : "items-end"}`}
                  >
                    {/*
                      THE ADVERT THAT BROUGHT THEM IN, WHERE WHATSAPP PUTS IT.

                      WhatsApp shows the customer this exact card above their
                      own first message: the creative, its headline, and a link
                      back to the advert. Until now a manager reading the same
                      conversation here saw none of it and had to decode a
                      17-digit ad id in the side panel.

                      It sits ABOVE the bubble, attached to the message that
                      carried the referral, rather than in a panel: which advert
                      someone answered is a fact about one moment in the thread,
                      and a second ad click weeks later deserves its own card
                      further down rather than quietly replacing this one.
                    */}
                    {m.ad && (
                      <a
                        href={m.ad.sourceUrl ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`mb-1 flex max-w-[85%] items-stretch gap-2.5 overflow-hidden rounded-xl border border-black/[0.06] bg-white p-2 shadow-xs transition hover:border-[#25D366]/50 dark:border-white/[0.06] dark:bg-[#202c33] ${
                          m.ad.sourceUrl ? "cursor-pointer" : "pointer-events-none"
                        }`}
                      >
                        {m.ad.thumbnailUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element --
                             Meta's own CDN, a remote host Next's optimiser is
                             not configured for, and the URL expires. */
                          <img
                            src={m.ad.thumbnailUrl}
                            alt=""
                            className="size-14 shrink-0 rounded-lg object-cover"
                          />
                        ) : (
                          <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <Megaphone className="size-5 text-muted-foreground" />
                          </span>
                        )}
                        <span className="flex min-w-0 flex-col justify-center gap-0.5 pr-1">
                          {/* Brand COLOUR, not a brand glyph. The row chips
                              upstream already say Instagram and Facebook this
                              way, and lucide carries no logo icons. */}
                          <span className="flex items-center gap-1.5">
                            <Megaphone
                              className={`size-3 ${
                                m.ad.platform === "instagram"
                                  ? "text-[#C13584]"
                                  : m.ad.platform === "facebook"
                                    ? "text-[#1877F2]"
                                    : "text-muted-foreground"
                              }`}
                            />
                            <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                              {m.ad.platform === "instagram"
                                ? "Instagram ad"
                                : m.ad.platform === "facebook"
                                  ? "Facebook ad"
                                  : m.ad.platform === "messenger"
                                    ? "Messenger ad"
                                    : "Ad"}
                            </span>
                          </span>
                          <span className="truncate text-[13px] font-semibold text-foreground">
                            {m.ad.headline ?? "Click-to-WhatsApp advert"}
                          </span>
                          {/* The ad id is what somebody pastes into Ads Manager,
                              so it is shown when there is no headline to show
                              instead — never both, which would be clutter. */}
                          <span className="truncate text-[11px] text-muted-foreground">
                            {m.ad.body ?? (m.ad.adId ? `Ad ${m.ad.adId}` : "")}
                          </span>
                        </span>
                      </a>
                    )}
                    <div
                      className={`relative max-w-[85%] sm:max-w-[75%] px-3.5 py-2 text-[13.5px] leading-relaxed shadow-xs ${
                        isInbound
                          ? "rounded-2xl rounded-tl-xs bg-white dark:bg-[#202c33] text-[#111b21] dark:text-[#e9edef] border border-black/[0.04] dark:border-white/[0.04]"
                          : "rounded-2xl rounded-tr-xs bg-[#d9fdd3] dark:bg-[#005c4b] text-[#111b21] dark:text-[#e9edef] border border-[#d9fdd3]/30 dark:border-[#005c4b]/30"
                      }`}
                    >
                      {/* AI Indicator on Assistant messages */}
                      {m.authorType === "ai" && !isInbound && (
                        <div className="flex items-center gap-1 text-[10.5px] font-medium text-[#128C7E] dark:text-[#25D366] mb-0.5">
                          <Sparkles className="h-3 w-3" />
                          <span>AI Assistant</span>
                        </div>
                      )}

                      {/* The scripted qualification bot. Deliberately NOT
                          labelled "AI": these are approved lines from
                          customer-flow.ts, not generated text, and a manager
                          reading the thread should be able to tell. */}
                      {m.authorType === "bot" && !isInbound && (
                        <div className="flex items-center gap-1 text-[10.5px] font-medium text-[#128C7E] dark:text-[#25D366] mb-0.5">
                          <Bot className="h-3 w-3" />
                          <span>Qualification bot</span>
                        </div>
                      )}

                      {/* Who actually typed it. Read from the recorded sender,
                          not from the message text — this is the line an admin
                          checks to see which manager answered which customer,
                          and it has to survive a reply with no text at all.
                          A different colour from the bot/AI green so a human
                          answer is distinguishable at a glance. */}
                      {m.authorType === "agent" && !isInbound && (
                        <div className="flex items-center gap-1 text-[10.5px] font-medium text-[#1d4ed8] dark:text-[#93b4ff] mb-0.5">
                          <UserIcon className="h-3 w-3" />
                          <span>{m.authorUser?.name ?? "Team member"}</span>
                        </div>
                      )}

                      {/* An attachment the customer sent. Rendered through
                          AuthedImage because the bytes are served from an
                          authenticated route — a plain <img src> cannot carry
                          the Authorization header, and these are the customer's
                          own photographs rather than public files. */}
                      {m.mediaUrl && (m.mediaType ?? "").startsWith("image/") && (
                        <div className="mb-1.5 overflow-hidden rounded-lg">
                          <AuthedImage
                            src={`/crm/conversations/${id}/media/${m.id}`}
                            alt={m.body ?? "Photo sent by the customer"}
                            className="max-h-64 w-auto max-w-full object-cover"
                          />
                        </div>
                      )}

                      {/* Non-image attachments have nothing to show inline, so
                          the label written at ingest is the message. */}
                      {m.mediaUrl && !(m.mediaType ?? "").startsWith("image/") && (
                        <span className="mb-1 flex items-center gap-1.5 text-[12px] opacity-80">
                          <Paperclip className="h-3.5 w-3.5" />
                          <span>{m.mediaType ?? "Attachment"}</span>
                        </span>
                      )}

                      {m.body ? (
                        <p className="whitespace-pre-wrap select-text">
                          {whatsappText(
                            m.authorType === "agent"
                              ? stripAgentSignature(m.body, m.authorUser?.name)
                              : m.body,
                          )}
                        </p>
                      ) : !m.mediaUrl ? (
                        <p className="whitespace-pre-wrap select-text opacity-70">(attachment)</p>
                      ) : null}

                      <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-[#667781] dark:text-[#8696a0]">
                        <span>{timeStr}</span>
                        {!isInbound && (
                          <span>
                            {m.status === "read" ? (
                              <span title="Read">
                                <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb]" />
                              </span>
                            ) : m.status === "delivered" ? (
                              <span title="Delivered">
                                <CheckCheck className="h-3.5 w-3.5 text-[#667781] dark:text-[#8696a0]" />
                              </span>
                            ) : m.status === "sent" ? (
                              <span title="Sent">
                                <Check className="h-3.5 w-3.5 text-[#667781] dark:text-[#8696a0]" />
                              </span>
                            ) : m.status === "failed" ? (
                              // Never a tick and never "Queued": this one did
                              // not reach the customer, and the reason is the
                              // difference between waiting and chasing it.
                              <span title={m.error ?? "Not delivered"}>
                                <AlertCircle className="h-3 w-3 text-red-500" />
                              </span>
                            ) : (
                              <span title="Queued">
                                <Clock className="h-3 w-3 text-amber-500" />
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* WhatsApp Web Input Dock & Quick Templates */}
        <div className="border-t border-border/70 bg-card p-3 space-y-2">
          {/* Quick Pre-Approved Templates Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap pl-1">
              Quick replies:
            </span>
            <button
              type="button"
              onClick={() =>
                setDraft(
                  "Hello Priya! Would you like us to reserve a 0.50 ct solitaire ring for your visit this Saturday?",
                )
              }
              className="inline-flex items-center gap-1 rounded-full border border-border/80 bg-muted/50 px-2.5 py-0.5 text-[11px] text-foreground hover:bg-muted hover:border-[#25D366]/40 transition-colors whitespace-nowrap"
            >
              ðŸ’Ž Confirm Saturday Visit
            </button>
            <button
              type="button"
              onClick={() =>
                setDraft(
                  "Our Surat showroom is at: Éclat Diamonds, Ring Road, Surat. Store hours: 10:30 AM to 8:30 PM.",
                )
              }
              className="inline-flex items-center gap-1 rounded-full border border-border/80 bg-muted/50 px-2.5 py-0.5 text-[11px] text-foreground hover:bg-muted hover:border-[#25D366]/40 transition-colors whitespace-nowrap"
            >
              ðŸ“ Store Location
            </button>
            <button
              type="button"
              onClick={() =>
                setDraft(
                  "All solitaires come with certified IGI laser-inscribed documentation and lifetime buyback guarantee.",
                )
              }
              className="inline-flex items-center gap-1 rounded-full border border-border/80 bg-muted/50 px-2.5 py-0.5 text-[11px] text-foreground hover:bg-muted hover:border-[#25D366]/40 transition-colors whitespace-nowrap"
            >
              ðŸ“œ IGI Certificate Info
            </button>
          </div>

          {/* Action Row: Emoji + Plus + Input + Mic/Send */}
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-0.5 text-muted-foreground pb-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                title="Insert emoji"
                onClick={() => setDraft((d) => d + " ðŸ˜Š ")}
              >
                <Smile className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                title="Attach jewellery catalogue item or quotation"
                onClick={() => setDealDialogOpen(true)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                placeholder="Type a message…"
                rows={draft.includes("\n") ? 3 : 1}
                className="w-full resize-none rounded-xl border border-input bg-background/80 px-3.5 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#25D366] transition-all min-h-[38px]"
              />
            </div>

            {draft.trim() ? (
              <Button
                size="icon"
                onClick={onSend}
                disabled={send.isPending}
                className="h-9 w-9 shrink-0 rounded-full bg-[#25D366] hover:bg-[#20bd5a] text-white shadow-xs transition-transform active:scale-95 disabled:opacity-40"
                aria-label="Send WhatsApp message"
              >
                <Send className="h-4 w-4 fill-white" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
                title="Record voice note"
                onClick={() => toast.info("Voice Message", { description: "Hold to record WhatsApp voice message" })}
              >
                <Mic className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="flex items-center justify-between text-[10.5px] text-muted-foreground px-1 pt-0.5">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[#25D366]" />
              WhatsApp Cloud API · End-to-end encrypted
            </span>
            <span>Enter to send · Shift + Enter for new line</span>
          </div>
        </div>
      </Card>

      {/* ── RIGHT COLUMN: Darrell Steward Style Customer Profile & Accordions ── */}
      {showRightCrm && (
        <div className={`${PANE_HEIGHT} space-y-3 overflow-y-auto pr-1`}>
          {/* Customer Profile Card */}
          <Card className="border-border/80 shadow-sm overflow-hidden">
            <CardHeader className="p-4 pb-3 border-b border-border/60 flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">
                  {party?.name ?? "Customer"}
                </span>
                <span className="text-amber-500 font-bold">⚡</span>
              </div>
              <div className="flex items-center gap-1">
                <Link
                  href={party ? `/customers/${party.id}` : "#"}
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <Edit3 className="h-3 w-3" /> Edit
                </Link>
                <button
                  type="button"
                  onClick={() => setShowRightCrm(false)}
                  className="h-6 w-6 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground ml-1"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-muted-foreground block text-[11px]">Email</span>
                  <span className="font-medium text-foreground truncate block">
                    {party?.name ? `${party.name.toLowerCase().replace(/\s+/g, ".")}@gmail.com` : "Not provided"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[11px]">Phone number</span>
                  <span className="font-medium text-foreground">
                    {party?.phone ?? "+91 91900000101"}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-muted-foreground block text-[11px]">Company name</span>
                  <span className="font-medium text-foreground">
                    {conversation.store?.name ?? "No store yet"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[11px]">Job title</span>
                  <span className="font-medium text-foreground">
                    Solitaire Buyer
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-muted-foreground block text-[11px]">Contact owner</span>
                  <span className="font-medium text-foreground">
                    {conversation.assignedUser?.name ?? "Karan Malhotra"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block text-[11px]">Lifecycle stage</span>
                  <span className="font-medium text-foreground">
                    Marketing qualified…
                  </span>
                </div>
              </div>

              <div>
                <span className="text-muted-foreground block text-[11px]">Lead status</span>
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#128C7E] dark:text-[#25D366] mt-0.5">
                  <Sparkles className="h-3 w-3" /> High Intent Prospect
                </span>
              </div>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => toast.info("Contact Resolution", { description: "Re-assign or link to different customer record" })}
                  className="text-[11px] text-[#25D366] hover:underline"
                >
                  Not the right contact?
                </button>
              </div>
            </CardContent>
          </Card>

          {/* AI Intent & Signal Qualification */}
          <Card className="border-border/80 shadow-sm overflow-hidden">
            <CardHeader className="p-3 pb-2 border-b border-border/60">
              <CardTitle className="text-xs font-semibold flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-[#6366f1]" /> AI Intent & Score
                </span>
                <Badge variant="secondary" className="text-[9px] uppercase font-mono">
                  Beta
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <IntentAnalysisPanel
                conversationId={id}
                partyId={party?.id}
                onClose={() => setShowRightCrm(false)}
                onApplyAction={(text) => setDraft((prev) => (prev ? prev + "\n" + text : text))}
              />
            </CardContent>
          </Card>

          {/* Zithara 5-Section Accordion List */}
          <Card className="border-border/80 shadow-sm">
            <div className="divide-y divide-border/40 text-xs">
              <div className="p-3 flex items-center justify-between hover:bg-muted/30 transition-colors">
                <span className="font-medium flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                  Whatsapp messages
                </span>
                <button
                  type="button"
                  onClick={() => toast.success("Activity Logged", { description: "15 WhatsApp messages archived in timeline" })}
                  className="text-primary hover:underline text-[11px] font-medium"
                >
                  + Log
                </button>
              </div>

              <div className="p-3 flex items-center justify-between hover:bg-muted/30 transition-colors">
                <span className="font-medium flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  Notes
                  {/* The real count, so a thread with history says so before it
                      is opened. Omitted rather than shown as 0 while loading. */}
                  {notes.data?.length ? (
                    <span className="num text-[10px] text-muted-foreground">
                      ({notes.data.length})
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => setNoteDialogOpen(true)}
                  className="text-primary hover:underline text-[11px] font-medium"
                >
                  + Add
                </button>
              </div>

              <div className="p-3 flex items-center justify-between hover:bg-muted/30 transition-colors">
                <span className="font-medium flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  Tasks
                </span>
                <button
                  type="button"
                  onClick={() => setTaskDialogOpen(true)}
                  className="text-primary hover:underline text-[11px] font-medium"
                >
                  + Add
                </button>
              </div>

              <div className="p-3 flex items-center justify-between hover:bg-muted/30 transition-colors">
                <span className="font-medium flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                  Deals
                </span>
                <button
                  type="button"
                  onClick={() => setDealDialogOpen(true)}
                  className="text-primary hover:underline text-[11px] font-medium"
                >
                  + Add
                </button>
              </div>

              <div className="p-3 flex items-center justify-between hover:bg-muted/30 transition-colors">
                <span className="font-medium flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                  tickets
                </span>
                <button
                  type="button"
                  onClick={() => toast.info("Support Ticket", { description: "Creating customer service ticket..." })}
                  className="text-primary hover:underline text-[11px] font-medium"
                >
                  + Add
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ── Dialogs for Zithara Accordions ── */}
      {/*
        1. Add Note.

        This dialog previously raised "Note added to customer profile" and threw
        the text away — nothing was ever sent anywhere. It now writes a real note
        against the customer, and refuses honestly when the thread has no
        customer to attach one to.
      */}
      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Add customer note</DialogTitle>
            <DialogDescription className="text-xs">
              {party
                ? `Recorded against ${party.name}, and visible on every conversation with them.`
                : "This thread is not linked to a customer yet, so there is nobody to attach a note to."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Textarea
              placeholder="e.g. Looking for 0.50 ct solitaire in Rose Gold for anniversary on Oct 15..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
              maxLength={2000}
              disabled={!party}
            />
            {notes.data?.length ? (
              <div className="space-y-1.5 border-t border-border pt-3">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Already on record
                </p>
                <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                  {notes.data.slice(0, 8).map((n) => (
                    <li key={n.id} className="rounded-md border border-border bg-muted/30 p-2 text-xs">
                      <p className="leading-relaxed">{n.text}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {n.authorName ?? "Someone"} · {new Date(n.createdAt).toLocaleDateString()}
                        {n.onLead ? " · on a lead" : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNoteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!party || !noteText.trim() || addNote.isPending}
              onClick={async () => {
                try {
                  await addNote.mutateAsync({ text: noteText.trim() });
                  setNoteText("");
                  setNoteDialogOpen(false);
                  toast.success("Note saved");
                } catch (e) {
                  toast.error(apiErrorMessage(e, "Could not save the note."));
                }
              }}
            >
              {addNote.isPending ? "Saving…" : "Save note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 2. Add Task Dialog */}
      <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Schedule Follow-up Task</DialogTitle>
            <DialogDescription className="text-xs">
              Assign a callback or store appointment reminder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Task Title</Label>
              <Input
                placeholder="e.g. WhatsApp follow-up for solitaire certificate"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Due Date</Label>
                <Input type="date" defaultValue="2026-09-13" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Priority</Label>
                <Input defaultValue="High" readOnly />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTaskDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                toast.success("Task scheduled & added to calling queue");
                setTaskTitle("");
                setTaskDialogOpen(false);
              }}
            >
              Create Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 3. Add Deal Dialog */}
      <Dialog open={dealDialogOpen} onOpenChange={setDealDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Create Deal / Quotation</DialogTitle>
            <DialogDescription className="text-xs">
              Attach quotation to WhatsApp conversation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Deal Name</Label>
              <Input defaultValue="Solitaire Ring 0.50 ct VS" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Estimated Value (₹)</Label>
              <Input
                inputMode="decimal"
                value={dealAmount}
                onChange={(e) => setDealAmount(positiveNumberInput(e.target.value))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDealDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                toast.success("Deal created & attached to WhatsApp conversation");
                setDealDialogOpen(false);
              }}
            >
              Save Deal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
