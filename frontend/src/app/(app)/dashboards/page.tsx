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
import { Skeleton } from "@/components/ui/skeleton";
import { getNavItem } from "@/lib/navigation";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  useKpis,
  useCharts,
  useTasks,
  useCreateTask,
  type DashboardTask,
} from "@/lib/queries/dashboard";

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
            <SalesTrendChart data={trend} />
            {isMultiStore ? (
              <StoreComparisonChart data={storeComparison} />
            ) : (
              <AgendaPanel />
            )}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {isMultiStore ? <AgendaPanel /> : <HandoffsPanel />}
            {isMultiStore ? (
              <HandoffsPanel />
            ) : (
              <StoreComparisonChart data={storeComparison} />
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
          tasks.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t.title}</p>
                {t.assignee ? (
                  <p className="text-xs text-muted-foreground">
                    Assigned to {t.assignee}
                  </p>
                ) : null}
              </div>
              {t.dueDate ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Due {formatDue(t.dueDate)}
                </span>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
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
        onError: () => toast.error("Could not create task."),
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
