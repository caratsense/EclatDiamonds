"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { OmnichannelKpis } from "@/components/crm/omnichannel-kpis";
import { KpiCard } from "@/components/dashboards/kpi-card";
import { AgendaPanel } from "@/components/dashboards/agenda-panel";
import { HandoffsPanel } from "@/components/dashboards/handoffs-panel";
import {
  SalesTrendChart,
  StoreComparisonChart,
} from "@/components/dashboards/dashboard-charts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { getNavItem } from "@/lib/navigation";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  useKpis,
  useCharts,
  useTasks,
  useCreateTask,
  useUpdateTaskStatus,
  type TaskPriority,
  useAssignableUsers,
  type DashboardTask,
  type TaskStatus,
} from "@/lib/queries/dashboard";
import { apiErrorMessage, isRealName } from "@/lib/utils";

/** Where each KPI tile drills to when clicked. */
function kpiHref(id: string): string | undefined {
  switch (id) {
    case "sales":
    case "my-sales":
      return "/reporting";
    case "footfall":
      return "/checkins";
    case "pending":
      return "/timelines";
    case "collections":
      return "/payments";
    case "customers":
      return "/customers";
    case "designs":
      return "/catalogue";
    case "stock":
      return "/inventory";
    default:
      return undefined;
  }
}

export default function DashboardsPage() {
  const item = getNavItem("dashboards");
  const { role, currentStore } = useSession();
  const [taskOpen, setTaskOpen] = useState(false);

  // KPIs + charts come live from the API, store-scoped via X-Store-Id.
  const kpisQuery = useKpis();
  const chartsQuery = useCharts();
  const tasksQuery = useTasks();
  const kpis = kpisQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];

  // Multi-store roles see store comparison; single-store roles see their trend.
  const isMultiStore = ROLE_RANK[role] >= ROLE_RANK.area_manager;
  const trend = chartsQuery.data?.salesTrend ?? [];
  const storeComparison = chartsQuery.data?.storeComparison ?? [];

  return (
    <>
      <SectionHeader
        title={item?.title ?? "Dashboards"}
        purpose={item?.purpose ?? ""}
        primaryAction={item?.primaryAction}
        onPrimaryAction={() => setTaskOpen(true)}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpisQuery.isLoading
          ? Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))
          : kpis.map((k, i) => (
              <KpiCard
                key={k.id}
                label={k.label}
                value={k.value}
                format={k.format}
                delta={k.delta}
                invertDelta={k.invertDelta}
                index={i}
                href={kpiHref(k.id)}
              />
            ))}
      </div>

      {chartsQuery.isLoading ? (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-[340px] rounded-xl" />
          <Skeleton className="h-[340px] rounded-xl" />
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SalesTrendChart data={trend} href="/reporting" />
            {isMultiStore ? (
              <StoreComparisonChart data={storeComparison} href="/store-comparison" />
            ) : (
              <AgendaPanel />
            )}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {isMultiStore ? <AgendaPanel /> : <HandoffsPanel />}
            {isMultiStore ? (
              <HandoffsPanel />
            ) : (
              <StoreComparisonChart data={storeComparison} href="/store-comparison" />
            )}
          </div>
        </>
      )}

      {/*
        Where the business came from, measured server-side over its own window.
        Below the day's KPIs because those answer "what is happening now" and
        these answer "where has it been coming from" — different questions, and
        a reader who conflates them reads a quiet Tuesday as a failing channel.
      */}
      <div className="mt-6">
        <OmnichannelKpis
          storeId={currentStore.isAggregate ? undefined : currentStore.id}
        />
      </div>

      <div className="mt-4">
        <MyTasksCard tasks={tasks} isLoading={tasksQuery.isLoading} />
      </div>

      <AddTaskDialog open={taskOpen} onOpenChange={setTaskOpen} />
    </>
  );
}

/**
 * Task views. "Mine" now matches on the assignee ID.
 *
 * The name fallback is kept for tasks created before ids existed: those rows
 * carry only a name, and dropping the fallback would make every historical task
 * disappear from its owner's list. New tasks always have an id, so the fallback
 * shrinks to nothing over time rather than being load-bearing.
 */
const TASK_VIEWS = ["Open", "Mine", "Overdue", "All"] as const;
type TaskView = (typeof TASK_VIEWS)[number];

function MyTasksCard({
  tasks,
  isLoading,
}: {
  tasks: DashboardTask[];
  isLoading: boolean;
}) {
  const { user } = useSession();
  const [view, setView] = useState<TaskView>("Open");
  const today = new Date().toISOString().slice(0, 10);

  const filtered = tasks.filter((t) => {
    const status = t.status ?? "open";
    if (view === "Open") return status !== "done";
    if (view === "Mine")
      return (t.assigneeId ? t.assigneeId === user.id : t.assignee === user.name) && status !== "done";
    if (view === "Overdue")
      return status !== "done" && !!t.dueDate && t.dueDate.slice(0, 10) < today;
    return true;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Tasks</CardTitle>
        <CardDescription>
          Tasks raised across departments for follow-up.
        </CardDescription>
        <div className="flex flex-wrap gap-1.5 pt-2">
          {TASK_VIEWS.map((v) => (
            <Button
              key={v}
              size="sm"
              variant={view === v ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setView(v)}
            >
              {v}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <>
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
          </>
        ) : filtered.length === 0 ? (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            {tasks.length === 0
              ? "No tasks yet"
              : `Nothing under “${view}” — ${tasks.length} task${tasks.length === 1 ? "" : "s"} in total.`}
          </p>
        ) : (
          filtered.map((t) => <TaskRow key={t.id} task={t} />)
        )}
      </CardContent>
    </Card>
  );
}

const TASK_STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
];

function TaskRow({ task }: { task: DashboardTask }) {
  const updateStatus = useUpdateTaskStatus();
  const status = task.status ?? "open";

  function change(next: TaskStatus) {
    if (next === status) return;
    updateStatus.mutate(
      { id: task.id, status: next },
      {
        onSuccess: () => toast.success("Task updated"),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the task.")),
      },
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium">
          {task.title}
          {task.priority && task.priority !== "normal" ? (
            <Badge
              variant={task.priority === "urgent" ? "destructive" : "outline"}
              className="text-[10px]"
            >
              {task.priority}
            </Badge>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {task.assignedTo?.name ?? task.assignee ?? "Unassigned"}
          {task.dueDate ? ` · Due ${formatDue(task.dueDate)}` : ""}
          {task.party ? ` · ${task.party.name}` : task.lead ? ` · ${task.lead.ref}` : ""}
        </p>
      </div>
      <Select
        value={status}
        onValueChange={(v) => change(v as TaskStatus)}
        disabled={updateStatus.isPending}
      >
        <SelectTrigger className="h-9 w-36 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TASK_STATUS_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function formatDue(iso: string): string {
  try {
    return format(parseISO(iso), "dd MMM yyyy");
  } catch {
    return iso;
  }
}

function AddTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore, stores } = useSession();
  const createTask = useCreateTask();
  const assignableUsers = useAssignableUsers();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueDate, setDueDate] = useState("");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  // A task is filed against ONE real store. On the "All Stores" aggregate there
  // is nothing concrete to write to, so the user must PICK a store — we never
  // silently default to the first (or any) branch; save() blocks an empty pick.
  const realStores = stores.filter((s) => !s.isAggregate);
  // A real active store follows the topbar switcher (derived, stays reactive);
  // on the aggregate, an explicit manual pick (empty until chosen).
  const [pickedStoreId, setPickedStoreId] = useState("");
  const storeId = currentStore.isAggregate ? pickedStoreId : currentStore.id;
  const targetStore = realStores.find((s) => s.id === storeId);

  function save() {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = "Task title is required.";
    else if (!isRealName(title))
      next.title = "Enter a real title (letters, not just a number).";
    if (!storeId) next.store = "Pick a store to file this task against.";
    if (!assigneeId) next.assignee = "Pick an assignee for this task.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    const assigneeName =
      (assignableUsers.data ?? []).find((u) => u.id === assigneeId)?.name ?? "";

    createTask.mutate(
      {
        title: title.trim(),
        detail: detail.trim() || undefined,
        // Both are sent: the id is what the task is assigned to, and the name
        // keeps the older contract satisfied. The server takes the display name
        // from the user record, so these cannot end up disagreeing.
        assignee: assigneeName,
        assigneeId: assigneeId || undefined,
        priority,
        dueDate: dueDate || undefined,
        storeId,
      },
      {
        onSuccess: () => {
          toast.success("Task created");
          setTitle("");
          setDetail("");
          setAssigneeId("");
          setPriority("normal");
          setDueDate("");
          setErrors({});
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not create task.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Raise a collaboration task against{" "}
            {targetStore?.name ?? "your store"}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {realStores.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="task-store">
                Store <span className="text-destructive">*</span>
              </Label>
              <Select
                value={storeId}
                onValueChange={(v) => {
                  setPickedStoreId(v);
                  clearError("store");
                }}
              >
                <SelectTrigger id="task-store" aria-invalid={!!errors.store}>
                  <SelectValue placeholder="Choose a store" />
                </SelectTrigger>
                <SelectContent>
                  {realStores.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.store ? (
                <p className="mt-1 text-xs text-destructive">{errors.store}</p>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="task-title"
              placeholder="e.g. Follow up on Diwali campaign stock"
              value={title}
              aria-invalid={!!errors.title}
              onChange={(e) => {
                setTitle(e.target.value);
                clearError("title");
              }}
            />
            {errors.title ? (
              <p className="mt-1 text-xs text-destructive">{errors.title}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-detail">Detail</Label>
            <Input
              id="task-detail"
              placeholder="Optional notes"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-assignee">
              Assignee <span className="text-destructive">*</span>
            </Label>
            <Select
              value={assigneeId}
              onValueChange={(v) => {
                setAssigneeId(v);
                clearError("assignee");
              }}
            >
              <SelectTrigger id="task-assignee" aria-invalid={!!errors.assignee}>
                <SelectValue placeholder="Select an assignee" />
              </SelectTrigger>
              <SelectContent>
                {(assignableUsers.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.assignee ? (
              <p className="text-xs text-destructive">{errors.assignee}</p>
            ) : !assignableUsers.isLoading &&
              (assignableUsers.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No team members to assign here yet — add staff in Team first.
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-priority">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
              <SelectTrigger id="task-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-due">Due date</Label>
            <Input
              id="task-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createTask.isPending}>
            {createTask.isPending ? "Saving…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
