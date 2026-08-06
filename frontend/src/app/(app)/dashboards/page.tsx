"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
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
import { getNavItem } from "@/lib/navigation";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  useKpis,
  useCharts,
  useTasks,
  useCreateTask,
  useUpdateTaskStatus,
  type DashboardTask,
  type TaskStatus,
} from "@/lib/queries/dashboard";
import { apiErrorMessage } from "@/lib/utils";

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
    default:
      return undefined;
  }
}

export default function DashboardsPage() {
  const item = getNavItem("dashboards");
  const { role } = useSession();
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
          ? Array.from({ length: 4 }).map((_, i) => (
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

      <div className="mt-4">
        <MyTasksCard tasks={tasks} isLoading={tasksQuery.isLoading} />
      </div>

      <AddTaskDialog open={taskOpen} onOpenChange={setTaskOpen} />
    </>
  );
}

function MyTasksCard({
  tasks,
  isLoading,
}: {
  tasks: DashboardTask[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">My Tasks</CardTitle>
        <CardDescription>
          Tasks raised across departments for follow-up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <>
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
          </>
        ) : tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            No tasks yet
          </p>
        ) : (
          tasks.map((t) => <TaskRow key={t.id} task={t} />)
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
        <p className="truncate text-sm font-medium">{task.title}</p>
        <p className="text-xs text-muted-foreground">
          {task.assignee ? `Assigned to ${task.assignee}` : "Unassigned"}
          {task.dueDate ? ` · Due ${formatDue(task.dueDate)}` : ""}
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
  const { currentStore } = useSession();
  const createTask = useCreateTask();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");

  // Aggregate ("all") scope has no concrete store to write to — fall back
  // to the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

  function save() {
    if (!title.trim()) {
      toast.error("Task title is required.");
      return;
    }
    createTask.mutate(
      {
        title: title.trim(),
        detail: detail.trim() || undefined,
        assignee: assignee.trim() || undefined,
        dueDate: dueDate || undefined,
        storeId: targetStoreId,
      },
      {
        onSuccess: () => {
          toast.success("Task created");
          setTitle("");
          setDetail("");
          setAssignee("");
          setDueDate("");
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
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              placeholder="e.g. Follow up on Diwali campaign stock"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
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
            <Label htmlFor="task-assignee">Assignee</Label>
            <Input
              id="task-assignee"
              placeholder="e.g. Rohan Mehta"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            />
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
