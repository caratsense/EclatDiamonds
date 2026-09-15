"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  MessageSquare,
  Phone,
  Search,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { TakeActionDialog } from "@/components/calling/take-action-dialog";
import { FollowUpRemindersStrip } from "@/components/calling/follow-up-reminders-strip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { STAT_LABEL, STAT_VALUE } from "@/components/ui/stat";
import { StatusPill } from "@/components/ui/status-pill";
import {
  useCallingQueue,
  useCallingSummary,
  type CallingBucket,
  type QueueTask,
} from "@/lib/queries/calling";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The calling team's queue.
 *
 * The four numbers at the top come from their own endpoint, never from the rows
 * below. On a tenant with ninety thousand overdue follow-ups the list shows
 * fifty of them and the card still says ninety thousand, because that is the
 * number anyone staffing a calling team actually needs.
 */

const BUCKETS: { value: CallingBucket; label: string; icon: typeof Clock }[] = [
  { value: "overdue", label: "Overdue", icon: AlertTriangle },
  { value: "today", label: "Due today", icon: Clock },
  { value: "upcoming", label: "Upcoming", icon: CalendarClock },
  { value: "completed", label: "Completed", icon: CheckCircle2 },
];

/**
 * How late a follow-up is, in days.
 *
 * Days, because `dueDate` is a calendar date at the branch and there is no hour
 * in it. This used to render minutes from a server field that compared that
 * date against the current instant, so from half past five every morning every
 * task in the "Due today" bucket wore a red "3 hr late" badge while the KPI
 * card above counted it, correctly, as not overdue.
 */
function overdueLabel(days: number | null): string | null {
  if (days === null || days <= 0) return null;
  return days === 1 ? "1 day late" : `${days} days late`;
}

const PRIORITY_TONE: Record<string, "destructive" | "warning" | "secondary" | "outline"> = {
  urgent: "destructive",
  high: "warning",
  normal: "secondary",
  low: "outline",
};

function TaskRow({ task, onAct }: { task: QueueTask; onAct: () => void }) {
  const late = overdueLabel(task.overdueDays);
  const rawPhone = task.customer?.contact?.replace(/[^0-9]/g, "");
  const dialable = rawPhone && rawPhone.length >= 10 ? rawPhone : null;
  const customerName = task.customer?.name ?? "Customer";

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{task.customer?.name ?? task.title}</p>
            <Badge variant={PRIORITY_TONE[task.priority] ?? "outline"} className="text-[10px]">
              {task.priority}
            </Badge>
            {late ? <StatusPill tone="bad">{late}</StatusPill> : null}
            {task.priority === "urgent" || task.priority === "high" ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                <Sparkles className="h-3 w-3 text-amber-500" /> High Priority Call
              </span>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">{task.title}</p>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {task.customer?.contact ? (
              <span className="font-[family-name:var(--font-mono-face)]">
                {task.customer.contact}
              </span>
            ) : null}
            {task.lead ? (
              <>
                <Badge variant="outline" className="text-[10px]">
                  {task.lead.source.replace(/_/g, " ")}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {task.lead.stage}
                </Badge>
              </>
            ) : null}
            {task.assignee ? <span>· {task.assignee.name}</span> : null}
            {task.dueDate ? (
              <span>· due {new Date(task.dueDate).toLocaleDateString()}</span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {dialable && (
            <Button
              size="sm"
              variant="outline"
              className="text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10 gap-1.5"
              title="Send WhatsApp Follow-up"
              onClick={() => {
                const text = `Hello ${customerName}, following up from Éclat regarding our conversation. Please let us know if you have any questions!`;
                window.open(`https://wa.me/${dialable}?text=${encodeURIComponent(text)}`, "_blank");
              }}
            >
              <MessageSquare className="h-3.5 w-3.5 fill-emerald-600/20" />
              WhatsApp
            </Button>
          )}
          <Button size="sm" onClick={onAct}>
            <Phone className="mr-1.5 h-3.5 w-3.5" />
            Take action
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Kpi({
  label,
  value,
  icon: Icon,
  active,
  tone,
  onClick,
}: {
  label: string;
  value: number | undefined;
  icon: typeof Clock;
  active: boolean;
  tone?: "bad";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-xl border bg-card p-4 text-left shadow-sm transition-shadow hover:shadow-md ${
        active ? "border-foreground" : "border-border/80"
      }`}
    >
      <div className={`${STAT_LABEL} mb-1.5`}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div
        className={`${STAT_VALUE} ${
          tone === "bad" && (value ?? 0) > 0 ? "text-destructive" : "text-foreground"
        }`}
      >
        {value === undefined ? "—" : value.toLocaleString()}
      </div>
    </button>
  );
}

export default function CallingPage() {
  const role = useSession((s) => s.role);
  const [bucket, setBucket] = useState<CallingBucket>("overdue");
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState("");
  const [actOn, setActOn] = useState<string | null>(null);
  /*
   * A call session: the ids to work through, and where we are in them.
   *
   * The ids are SNAPSHOTTED when the session starts rather than re-read from
   * the query on every step. The list refetches as calls are logged, and a
   * cursor into a list that reorders underneath you skips customers — the one
   * failure a calling team would never notice and could never reconstruct.
   */
  const [session, setSession] = useState<{ ids: string[]; at: number } | null>(
    null,
  );

  const summary = useCallingSummary({ mine });
  const queue = useCallingQueue({
    bucket,
    mine,
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Calling"
        purpose="Every follow-up owed to a customer, oldest first, with the whole history on one screen before you dial."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Overdue"
          value={summary.data?.overdue}
          icon={AlertTriangle}
          tone="bad"
          active={bucket === "overdue"}
          onClick={() => setBucket("overdue")}
        />
        <Kpi
          label="Due today"
          value={summary.data?.dueToday}
          icon={Clock}
          active={bucket === "today"}
          onClick={() => setBucket("today")}
        />
        <Kpi
          label="Upcoming"
          value={summary.data?.upcoming}
          icon={CalendarClock}
          active={bucket === "upcoming"}
          onClick={() => setBucket("upcoming")}
        />
        <Kpi
          label={`Completed (${summary.data?.completedWithinDays ?? 30}d)`}
          value={summary.data?.completed}
          icon={CheckCircle2}
          active={bucket === "completed"}
          onClick={() => setBucket("completed")}
        />
      </div>

      <FollowUpRemindersStrip />

      <div className="flex flex-wrap items-center gap-3">
        {/* A salesperson's queue is always their own (the server enforces it). */}
        {role !== "salesperson" ? (
          <Tabs value={mine ? "mine" : "all"} onValueChange={(v) => setMine(v === "mine")}>
            <TabsList>
              <TabsTrigger value="mine">My tasks</TabsTrigger>
              <TabsTrigger value="all">All tasks</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}

        <div className="relative min-w-[14rem] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Customer, phone or lead reference"
            className="pl-9"
          />
        </div>

        {/*
          Only over work that is still owed. Starting a "session" on the
          Completed bucket would walk a caller through calls somebody has
          already made.
        */}
        {bucket !== "completed" ? (
          <Button
            onClick={() => {
              const ids = queue.data?.items.map((t) => t.id) ?? [];
              if (!ids.length) return;
              setSession({ ids, at: 0 });
              setActOn(ids[0]);
            }}
            disabled={!queue.data?.items.length}
            title={
              queue.data?.items.length
                ? "Work this queue one call at a time"
                : "Nothing in this queue to call"
            }
          >
            <Zap className="mr-1.5 h-4 w-4" />
            Start call session
          </Button>
        ) : null}
      </div>

      <div className="space-y-3">
        {queue.isLoading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : queue.isError ? (
          <p className="text-sm text-muted-foreground">
            {apiErrorMessage(queue.error, "Could not load the queue.")}
          </p>
        ) : !queue.data?.items.length ? (
          <EmptyState
            icon={Users}
            title={
              bucket === "overdue"
                ? "Nothing overdue"
                : bucket === "completed"
                  ? "Nothing completed yet"
                  : "Nothing here"
            }
            description={
              BUCKETS.find((b) => b.value === bucket)?.label === "Overdue"
                ? "Every follow-up is on time."
                : "Follow-ups appear here as they fall due."
            }
          />
        ) : (
          <>
            {queue.data.items.map((task) => (
              <TaskRow key={task.id} task={task} onAct={() => setActOn(task.id)} />
            ))}
            {queue.data.nextCursor ? (
              <p className="pt-2 text-center text-xs text-muted-foreground">
                Showing the first {queue.data.items.length}. The counts above cover everything.
              </p>
            ) : null}
          </>
        )}
      </div>

      {actOn ? (
        <TakeActionDialog
          /* Keyed, so each call in a session opens on an empty form. */
          key={actOn}
          taskId={actOn}
          open
          onOpenChange={(o) => {
            if (o) return;
            setActOn(null);
            setSession(null);
          }}
          session={
            session
              ? {
                  index: session.at,
                  total: session.ids.length,
                  onNext: () => {
                    const next = session.at + 1;
                    if (next >= session.ids.length) {
                      setSession(null);
                      setActOn(null);
                      toast.success("Session finished — the queue is worked through.");
                      return;
                    }
                    setSession({ ids: session.ids, at: next });
                    setActOn(session.ids[next]);
                  },
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
