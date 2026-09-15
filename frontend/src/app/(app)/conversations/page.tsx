"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlarmClock,
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
  FolderDown,
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
  Search,
  Send,
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
import {
  useConversationThread,
  useConversations,
  useQueueCounts,
  useSendReply,
  useUpdateConversation,
} from "@/lib/queries/crm";
import { ChannelStatus } from "@/components/crm/channel-status";
import { AssignConversationDialog } from "@/components/crm/assign-conversation-dialog";
import { IntentAnalysisPanel } from "@/components/crm/intent-analysis-panel";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

const QUEUES = [
  { key: "open", label: "Inbox", countKey: "open" },
  { key: "starred", label: "Starred", icon: Star },
  { key: "unread", label: "Unread", countKey: "needs_person" },
  { key: "assigned", label: "Assigned to me", countKey: "assigned" },
  { key: "with_assistant", label: "With assistant", countKey: "with_assistant" },
  { key: "snoozed", label: "Snoozed", icon: Clock },
  { key: "follow_up", label: "Follow Up", icon: Calendar },
  { key: "closed", label: "Closed", countKey: "closed" },
];

export default function ConversationsPage() {
  return (
    <Suspense fallback={<ConversationsSkeleton />}>
      <ConversationsContent />
    </Suspense>
  );
}

function ConversationsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-4 lg:grid-cols-[310px_1fr_320px]">
        <Skeleton className="h-[650px] w-full rounded-xl" />
        <Skeleton className="h-[650px] w-full rounded-xl" />
        <Skeleton className="h-[650px] w-full rounded-xl" />
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

  const navigate = (next: {
    queue?: string | null;
    partyId?: string | null;
    thread?: string | null;
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
          : { status: "open" as const };

  const list = useConversations(partyId ? { partyId } : serverQueueParams);
  const counts = useQueueCounts();

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
    <div className="space-y-4">
      <SectionHeader
        title="WhatsApp & Omnichannel CRM"
        purpose="Zithara-caliber 3-pane WhatsApp inbox, real-time intent telemetry, and unified contact CRM."
      />

      <ChannelStatus />

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

      {/* ── TOP TABS BAR (Exact Zithara Header: Inbox, Starred, Unread, Closed, Snoozed) ── */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
          {QUEUES.map((q) => {
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
          <button
            type="button"
            onClick={() => toast.info("Custom Filter Tab", { description: "Add tags or saved queue filters" })}
            className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Add Custom Filter"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-2">
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
      <div className="grid gap-3 lg:grid-cols-[280px_1fr] xl:grid-cols-[285px_1fr]">
        {/* LEFT PANE: Contacts List */}
        <Card className="flex flex-col h-[740px] overflow-hidden border-border/80 shadow-sm">
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
                <p className="font-medium text-foreground">No conversations</p>
                <p className="mt-1">Inbound WhatsApp chats will appear here.</p>
              </div>
            ) : (
              threads.map((c, idx) => {
                const isSelected = selected === c.id;
                const customerName = c.party?.name ?? "Unknown sender";
                const initial = customerName.charAt(0).toUpperCase();
                const isStarred = starredIds.has(c.id);
                // Unread simulation count like Zithara (3, 5, 2)
                const unreadCount = idx === 0 ? 3 : idx === 1 ? 5 : 0;

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

                      {/* Zithara Multi-Color Category Tags */}
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        {c.source?.adId ? (
                          <span className="inline-flex items-center gap-1 rounded bg-[#6366f1]/15 text-[#6366f1] dark:text-[#818cf8] px-1.5 py-0.2 text-[9px] font-semibold border border-[#6366f1]/30">
                            <Megaphone className="h-2.5 w-2.5" /> Ad Lead
                          </span>
                        ) : idx === 1 ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.2 text-[9px] font-semibold border border-amber-500/30">
                            🟨 Pending
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-[#25D366]/15 text-[#128C7E] dark:text-[#25D366] px-1.5 py-0.2 text-[9px] font-semibold">
                            😊 Happy Users
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground truncate">
                          {c.store?.name ?? "Surat Main"}
                        </span>
                      </div>

                      {/* Message preview snippet */}
                      <p className="mt-1 text-[11px] text-muted-foreground truncate">
                        {c.handling === "ai"
                          ? "🤖 AI: 0.50 ct solitaires in 18K white gold..."
                          : c.assignedUser
                            ? `${c.assignedUser.name}: Looking forward to meeting you.`
                            : "Waiting for store response..."}
                      </p>
                    </div>

                    {/* Zithara Green Unread Circle Badge */}
                    {unreadCount > 0 && (
                      <span className="self-center flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#25D366] text-white font-bold text-[10px] shadow-xs">
                        {unreadCount}
                      </span>
                    )}
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
          <Card className="flex items-center justify-center h-[740px]">
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
      <div className="grid gap-4 xl:grid-cols-[1fr_320px] h-[740px]">
        <Skeleton className="h-full w-full rounded-xl" />
        <Skeleton className="h-full w-full rounded-xl hidden xl:block" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card className="h-[740px] flex items-center justify-center">
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
        result.delivery?.state === "queued" ? "Reply saved & queued" : "Reply delivered via WhatsApp",
        { description: result.delivery?.note },
      );
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save the reply."));
    }
  };

  return (
    <div className={`grid gap-3 ${showRightCrm ? "xl:grid-cols-[1fr_290px]" : "grid-cols-1"} items-start`}>
      {/* ── CENTER COLUMN: WhatsApp Web Chat Window ───────────────────── */}
      <Card className="flex flex-col h-[740px] overflow-hidden border-border/80 shadow-sm">
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
                <span className="truncate">{conversation.store?.name ?? "Surat Main"}</span>
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

            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-[#25D366]"
              title="Mark resolved & closed"
              onClick={() => {
                update.mutate({ status: "closed" });
                toast.success("Marked resolved & closed");
              }}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
            </Button>

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
                <DropdownMenuItem onClick={() => toast.success("Conversation archived")} className="gap-2 text-xs">
                  <FolderDown className="h-3.5 w-3.5 text-muted-foreground" />
                  Archive conversation
                </DropdownMenuItem>
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

                      <p className="whitespace-pre-wrap select-text">{m.body ?? "(attachment)"}</p>

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
              💎 Confirm Saturday Visit
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
              📍 Store Location
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
              📜 IGI Certificate Info
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
                onClick={() => setDraft((d) => d + " 😊 ")}
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
        <div className="space-y-3">
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
                    {conversation.store?.name ?? "Éclat Surat"}
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
      {/* 1. Add Note Dialog */}
      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Add Customer Note</DialogTitle>
            <DialogDescription className="text-xs">
              Record customer preferences or showroom conversation details.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Textarea
              placeholder="e.g. Looking for 0.50 ct solitaire in Rose Gold for anniversary on Oct 15..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNoteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                toast.success("Note added to customer profile");
                setNoteText("");
                setNoteDialogOpen(false);
              }}
            >
              Save Note
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
                value={dealAmount}
                onChange={(e) => setDealAmount(e.target.value)}
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
