"use client";

import { useState, type ReactNode } from "react";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { CalendarClock, Flag, Lock, Plus } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChecklistStatusBadge,
  MilestoneStateBadge,
  ProgressBar,
  VendorStatusBadge,
} from "@/components/new-store/status-badges";
import { formatINRCompact } from "@/lib/format";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  DEPARTMENTS,
  departmentProgress,
  type ChecklistStatus,
  type DepartmentKey,
} from "@/lib/mock/new-store";
import {
  useAddChecklistItem,
  useAddMilestone,
  useAddVendor,
  useCreateProject,
  useNewStoreProjects,
  useUpdateChecklistItem,
  useUpdateVendor,
  type ApiChecklistTask,
  type ApiDepartmentChecklist,
  type ApiNewStoreProject,
  type ApiVendor,
} from "@/lib/queries/new-store";

const CHECKLIST_STATUS_OPTIONS: { value: ChecklistStatus; label: string }[] = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const VENDOR_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "paid", label: "Paid" },
  { value: "completed", label: "Completed" },
];

export default function NewStorePage() {
  const { data, isLoading, isError, refetch } = useNewStoreProjects();
  const role = useSession((s) => s.role);
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.area_manager;
  const [projectOpen, setProjectOpen] = useState(false);

  const header = (
    <>
      <SectionHeader
        title="New-Store Setup"
        purpose="Tasks and timelines for opening new stores."
        primaryAction="New Project"
        onPrimaryAction={() => setProjectOpen(true)}
      />
      <NewProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
    </>
  );

  if (isLoading) {
    return (
      <>
        {header}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="mt-8 h-64 rounded-xl" />
      </>
    );
  }

  if (isError) {
    return (
      <>
        {header}
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="space-y-1">
              <p className="font-medium">Couldn&apos;t load store-launch projects</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Check your connection and try again.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  // Lower roles (salesperson / store_manager) get a 403 — show a permission
  // state rather than an error (new-store setup is an area-manager+ programme).
  if (data?.forbidden) {
    return (
      <>
        {header}
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Lock className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">Restricted to area managers</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                New-store launch projects are managed by area managers and head
                office. Ask your area manager for access.
              </p>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  const project = data?.projects[0];

  if (!project) {
    return (
      <>
        {header}
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No store-launch projects yet. Create a project to get started.
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <ProjectView project={project} canEdit={canEdit} />
    </>
  );
}

function ProjectView({
  project,
  canEdit,
}: {
  project: ApiNewStoreProject;
  canEdit: boolean;
}) {
  const [checklistDept, setChecklistDept] = useState<DepartmentKey | null>(null);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [vendorOpen, setVendorOpen] = useState(false);

  const launch = project.launchDate ? parseISO(project.launchDate) : null;
  const daysToLaunch = launch
    ? differenceInCalendarDays(launch, new Date())
    : null;
  const hasBudget = project.budget > 0;

  return (
    <>
      {/* Launch summary strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Active project" value={project.name}>
          <p className="text-xs text-muted-foreground">
            Project lead: {project.leadName || "—"}
          </p>
        </SummaryCard>
        <SummaryCard
          label="Launch date"
          value={
            launch ? (
              <span className="num">{format(launch, "dd MMM yyyy")}</span>
            ) : (
              "TBD"
            )
          }
        >
          <p className="text-xs text-muted-foreground">
            {daysToLaunch != null ? (
              <>
                <span className="num">{daysToLaunch}</span> days to go
              </>
            ) : (
              "Date pending"
            )}
          </p>
        </SummaryCard>
        <SummaryCard
          label="Overall readiness"
          value={<span className="num">{project.overallProgress}%</span>}
        >
          <ProgressBar value={project.overallProgress} className="mt-2" />
        </SummaryCard>
        <SummaryCard
          label="Budget used"
          value={
            hasBudget ? (
              <span className="num">
                {formatINRCompact(project.spent)} /{" "}
                {formatINRCompact(project.budget)}
              </span>
            ) : (
              "Not tracked"
            )
          }
        >
          {hasBudget ? (
            <ProgressBar
              value={(project.spent / project.budget) * 100}
              className="mt-2"
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Add vendors with amounts to track budget
            </p>
          )}
        </SummaryCard>
      </div>

      {/* Department checklists */}
      <h2 className="mb-3 mt-8 text-lg font-semibold tracking-tight">
        Five-department launch checklist
      </h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {project.checklists.map((list) => (
          <ChecklistCard
            key={list.key}
            list={list}
            canEdit={canEdit}
            onAddTask={() => setChecklistDept(list.key)}
          />
        ))}
      </div>

      {/* 30/60/90 milestone timeline */}
      <div className="mb-3 mt-8 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Flag className="h-5 w-5 text-muted-foreground" />
          30/60/90-day launch milestones
        </h2>
        {canEdit ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMilestoneOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Add milestone
          </Button>
        ) : null}
      </div>
      <Card>
        <CardContent className="pt-6">
          {project.milestones.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No milestones scheduled yet.
            </p>
          ) : (
            <ol className="relative space-y-6 border-l border-border pl-6">
              {project.milestones.map((ms, idx) => (
                <li key={`${ms.marker}-${ms.date}-${idx}`} className="relative">
                  <span className="absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground">
                    <CalendarClock className="h-3 w-3" />
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-xs font-semibold text-muted-foreground">
                      {ms.marker}
                    </span>
                    <span className="font-medium">{ms.title}</span>
                    <MilestoneStateBadge state={ms.state} />
                    <span className="num ml-auto text-xs text-muted-foreground">
                      {ms.date ? format(parseISO(ms.date), "dd MMM yyyy") : "—"}
                    </span>
                  </div>
                  {ms.summary ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {ms.summary}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Vendor assignments */}
      <div className="mb-3 mt-8 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          Vendor assignments
        </h2>
        {canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setVendorOpen(true)}>
            <Plus className="h-4 w-4" />
            Add vendor
          </Button>
        ) : null}
      </div>
      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Due date</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {project.vendors.map((v) => (
                <VendorRow key={v.id} vendor={v} canEdit={canEdit} />
              ))}
              {project.vendors.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No vendors assigned yet. Add an assignment to begin.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AddChecklistDialog
        projectId={project.id}
        dept={checklistDept}
        onOpenChange={(open) => {
          if (!open) setChecklistDept(null);
        }}
      />
      <AddMilestoneDialog
        projectId={project.id}
        open={milestoneOpen}
        onOpenChange={setMilestoneOpen}
      />
      <AddVendorDialog
        projectId={project.id}
        open={vendorOpen}
        onOpenChange={setVendorOpen}
      />
    </>
  );
}

function ChecklistCard({
  list,
  canEdit,
  onAddTask,
}: {
  list: ApiDepartmentChecklist;
  canEdit: boolean;
  onAddTask: () => void;
}) {
  const meta = DEPARTMENTS.find((d) => d.key === list.key);
  const pct = departmentProgress(list);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{meta?.label ?? list.key}</CardTitle>
          <span className="num text-sm font-medium text-muted-foreground">
            {pct}%
          </span>
        </div>
        <CardDescription>{meta?.owner ?? ""}</CardDescription>
        <ProgressBar value={pct} className="mt-1" />
      </CardHeader>
      <CardContent className="space-y-2.5">
        {list.tasks.map((task) => (
          <ChecklistTaskRow key={task.id} task={task} canEdit={canEdit} />
        ))}
        {canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start text-muted-foreground"
            onClick={onAddTask}
          >
            <Plus className="h-4 w-4" />
            Add task
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ChecklistTaskRow({
  task,
  canEdit,
}: {
  task: ApiChecklistTask;
  canEdit: boolean;
}) {
  const update = useUpdateChecklistItem();

  function change(status: ChecklistStatus) {
    if (status === task.status) return;
    update.mutate(
      { id: task.id, status },
      {
        onSuccess: () => toast.success("Task updated"),
        onError: () => toast.error("Could not update the task."),
      },
    );
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{task.label}</span>
      {canEdit ? (
        <Select
          value={task.status}
          onValueChange={(v) => change(v as ChecklistStatus)}
          disabled={update.isPending}
        >
          <SelectTrigger className="h-8 w-32 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHECKLIST_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <ChecklistStatusBadge status={task.status} />
      )}
    </div>
  );
}

function VendorRow({
  vendor,
  canEdit,
}: {
  vendor: ApiVendor;
  canEdit: boolean;
}) {
  const update = useUpdateVendor();

  function change(status: string) {
    if (status === vendor.status) return;
    update.mutate(
      { id: vendor.id, status },
      {
        onSuccess: () => toast.success("Vendor updated"),
        onError: () => toast.error("Could not update the vendor."),
      },
    );
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{vendor.task}</TableCell>
      <TableCell>{vendor.vendor}</TableCell>
      <TableCell className="text-right">
        <span className="num">
          {vendor.amount != null ? formatINRCompact(vendor.amount) : "—"}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className="num">
          {vendor.dueDate
            ? format(parseISO(vendor.dueDate), "dd MMM yyyy")
            : "—"}
        </span>
      </TableCell>
      <TableCell>
        {canEdit ? (
          <Select
            value={
              VENDOR_STATUS_OPTIONS.some((o) => o.value === vendor.status)
                ? vendor.status
                : undefined
            }
            onValueChange={change}
            disabled={update.isPending}
          >
            <SelectTrigger className="h-8 w-36">
              <SelectValue placeholder={vendor.status} />
            </SelectTrigger>
            <SelectContent>
              {VENDOR_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <VendorStatusBadge status={vendor.status} />
        )}
      </TableCell>
    </TableRow>
  );
}

function SummaryCard({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-xl font-semibold">{value}</p>
        {children}
      </CardContent>
    </Card>
  );
}

function AddChecklistDialog({
  projectId,
  dept,
  onOpenChange,
}: {
  projectId: string;
  dept: DepartmentKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const addTask = useAddChecklistItem();
  const [title, setTitle] = useState("");
  const meta = DEPARTMENTS.find((d) => d.key === dept);

  function save() {
    if (!dept) return;
    if (!title.trim()) {
      toast.error("Task title is required.");
      return;
    }
    addTask.mutate(
      { projectId, dept, title: title.trim() },
      {
        onSuccess: () => {
          toast.success("Task added");
          setTitle("");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not add the task."),
      },
    );
  }

  return (
    <Dialog open={dept != null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add checklist task</DialogTitle>
          <DialogDescription>
            New task for {meta?.label ?? "the selected department"}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Task</Label>
            <Input
              id="task-title"
              placeholder="e.g. Configure billing software"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={addTask.isPending}>
            {addTask.isPending ? "Saving…" : "Add task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddMilestoneDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addMilestone = useAddMilestone();
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [summary, setSummary] = useState("");

  function reset() {
    setTitle("");
    setPhase("");
    setDueDate("");
    setSummary("");
  }

  function save() {
    if (!title.trim()) {
      toast.error("Milestone title is required.");
      return;
    }
    if (!dueDate) {
      toast.error("A milestone date is required.");
      return;
    }
    addMilestone.mutate(
      {
        projectId,
        title: title.trim(),
        dueDate,
        phase: phase.trim() || undefined,
        summary: summary.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Milestone added");
          reset();
          onOpenChange(false);
        },
        onError: () => toast.error("Could not add the milestone."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add milestone</DialogTitle>
          <DialogDescription>
            Add a checkpoint to the launch timeline.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ms-title">Title</Label>
            <Input
              id="ms-title"
              placeholder="e.g. Stock & dry-run complete"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ms-phase">Phase</Label>
              <Input
                id="ms-phase"
                placeholder="e.g. T-30"
                value={phase}
                onChange={(e) => setPhase(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ms-date">Date</Label>
              <Input
                id="ms-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ms-summary">Summary</Label>
            <Textarea
              id="ms-summary"
              placeholder="Optional detail about this checkpoint"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={addMilestone.isPending}>
            {addMilestone.isPending ? "Saving…" : "Add milestone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddVendorDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addVendor = useAddVendor();
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("pending");

  function reset() {
    setName("");
    setScope("");
    setAmount("");
    setStatus("pending");
  }

  function save() {
    if (!name.trim()) {
      toast.error("Vendor name is required.");
      return;
    }
    if (!scope.trim()) {
      toast.error("Vendor scope is required.");
      return;
    }
    const amountNum = amount.trim() ? Number(amount) : undefined;
    if (amountNum != null && (Number.isNaN(amountNum) || amountNum < 0)) {
      toast.error("Enter a valid amount.");
      return;
    }
    addVendor.mutate(
      {
        projectId,
        name: name.trim(),
        scope: scope.trim(),
        amount: amountNum,
        status,
      },
      {
        onSuccess: () => {
          toast.success("Vendor added");
          reset();
          onOpenChange(false);
        },
        onError: () => toast.error("Could not add the vendor."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add vendor</DialogTitle>
          <DialogDescription>
            Engage a vendor and capture the contracted amount.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="vendor-name">Vendor name</Label>
            <Input
              id="vendor-name"
              placeholder="e.g. Shreeji Fixtures Pvt Ltd"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="vendor-scope">Scope</Label>
            <Input
              id="vendor-scope"
              placeholder="e.g. Display showcases & vault"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="vendor-amount">Amount (₹)</Label>
              <Input
                id="vendor-amount"
                type="number"
                min={0}
                placeholder="e.g. 3850000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="vendor-status">Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="vendor-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VENDOR_STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={addVendor.isPending}>
            {addVendor.isPending ? "Saving…" : "Add vendor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createProject = useCreateProject();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [launchDate, setLaunchDate] = useState("");
  const [leadName, setLeadName] = useState("");

  function save() {
    if (!name.trim()) {
      toast.error("Project name is required.");
      return;
    }
    createProject.mutate(
      {
        name: name.trim(),
        city: city.trim(),
        launchDate: launchDate || undefined,
        leadName: leadName.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Project created");
          setName("");
          setCity("");
          setLaunchDate("");
          setLeadName("");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not create the project."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Kick off a new store-launch programme.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="proj-name">Project name</Label>
            <Input
              id="proj-name"
              placeholder="e.g. Pune — Koregaon Park launch"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="proj-city">City</Label>
            <Input
              id="proj-city"
              placeholder="e.g. Pune"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="proj-launch">Launch date</Label>
            <Input
              id="proj-launch"
              type="date"
              value={launchDate}
              onChange={(e) => setLaunchDate(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="proj-lead">Project lead</Label>
            <Input
              id="proj-lead"
              placeholder="e.g. Rohan Mehta"
              value={leadName}
              onChange={(e) => setLeadName(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createProject.isPending}>
            {createProject.isPending ? "Saving…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
