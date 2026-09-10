"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Phone,
  Search,
  Users,
} from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { TakeActionDialog } from "@/components/calling/take-action-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useCallingQueue,
  useCallingSummary,
  type CallingBucket,
  type QueueTask,
} from "@/lib/queries/calling";
import { apiErrorMessage } from "@/lib/utils";

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

function overdueLabel(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  if (minutes < 60) return `${minutes} min late`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr late`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} late`;
}

const PRIORITY_TONE: Record<string, "destructive" | "warning" | "secondary" | "outline"> = {
  urgent: "destructive",
  high: "warning",
  normal: "secondary",
  low: "outline",
};

function TaskRow({ task, onAct }: { task: QueueTask; onAct: () => void }) {
  const late = overdueLabel(task.overdueMinutes);
  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{task.customer?.name ?? task.title}</p>
            <Badge variant={PRIORITY_TONE[task.priority] ?? "outline"} className="text-[10px]">
              {task.priority}
            </Badge>
            {late ? (
              <Badge variant="destructive" className="text-[10px]">
                {late}
              </Badge>
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

        <Button size="sm" onClick={onAct}>
          <Phone className="mr-1.5 h-3.5 w-3.5" />
          Take action
        </Button>
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
      className={`rounded-md border p-4 text-left transition-colors ${
        active ? "border-foreground bg-muted/60" : "border-border hover:bg-muted/30"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div
        className={`font-[family-name:var(--font-display-face)] text-3xl tabular-nums ${
          tone === "bad" && (value ?? 0) > 0 ? "text-destructive" : ""
        }`}
      >
        {value === undefined ? "—" : value.toLocaleString()}
      </div>
    </button>
  );
}

export default function CallingPage() {
  const [bucket, setBucket] = useState<CallingBucket>("overdue");
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState("");
  const [actOn, setActOn] = useState<string | null>(null);

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

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={mine ? "mine" : "all"} onValueChange={(v) => setMine(v === "mine")}>
          <TabsList>
            <TabsTrigger value="mine">My tasks</TabsTrigger>
            <TabsTrigger value="all">All tasks</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="relative min-w-[14rem] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Customer, phone or lead reference"
            className="pl-9"
          />
        </div>
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
        <TakeActionDialog taskId={actOn} open onOpenChange={(o) => !o && setActOn(null)} />
      ) : null}
    </div>
  );
}
