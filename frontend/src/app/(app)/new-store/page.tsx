"use client";

import { useState, type ReactNode } from "react";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { CalendarClock, Flag, Lock } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
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
import { DEPARTMENTS, departmentProgress } from "@/lib/mock/new-store";
import {
  useCreateProject,
  useNewStoreProjects,
} from "@/lib/queries/new-store";

export default function NewStorePage() {
  const { data, isLoading, isError, refetch } = useNewStoreProjects();
  const [projectOpen, setProjectOpen] = useState(false);

  const header = (
    <>
      <SectionHeader
        title="New-Store Setup"
        purpose="Project management for launching new store locations."
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

  const launch = project.launchDate ? parseISO(project.launchDate) : null;
  const daysToLaunch = launch
    ? differenceInCalendarDays(launch, new Date())
    : null;
  const hasBudget = project.budget > 0;

  return (
    <>
      {header}

      {/* Launch summary strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Active project" value={project.name}>
          <p className="text-xs text-muted-foreground">
            Lead: {project.leadName || "—"}
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
              Budget not yet captured
            </p>
          )}
        </SummaryCard>
      </div>

      {/* Department checklists */}
      <h2 className="mb-3 mt-8 text-lg font-semibold tracking-tight">
        Five-department launch checklist
      </h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {project.checklists.map((list) => {
          const meta = DEPARTMENTS.find((d) => d.key === list.key);
          const pct = departmentProgress(list);
          return (
            <Card key={list.key}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {meta?.label ?? list.key}
                  </CardTitle>
                  <span className="num text-sm font-medium text-muted-foreground">
                    {pct}%
                  </span>
                </div>
                <CardDescription>{meta?.owner ?? ""}</CardDescription>
                <ProgressBar value={pct} className="mt-1" />
              </CardHeader>
              <CardContent className="space-y-2.5">
                {list.tasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-start justify-between gap-3"
                  >
                    <div className="text-sm">
                      <span>{task.label}</span>
                    </div>
                    <ChecklistStatusBadge status={task.status} />
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 30/60/90 milestone timeline */}
      <h2 className="mb-3 mt-8 flex items-center gap-2 text-lg font-semibold tracking-tight">
        <Flag className="h-5 w-5 text-muted-foreground" />
        30/60/90-day launch milestones
      </h2>
      <Card>
        <CardContent className="pt-6">
          {project.milestones.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No milestones scheduled yet.
            </p>
          ) : (
            <ol className="relative space-y-6 border-l border-border pl-6">
              {project.milestones.map((ms) => (
                <li key={ms.marker} className="relative">
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
                  <p className="mt-1 text-sm text-muted-foreground">
                    {ms.summary}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Vendor assignments */}
      <h2 className="mb-3 mt-8 text-lg font-semibold tracking-tight">
        Vendor assignments
      </h2>
      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Due date</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {project.vendors.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">{v.task}</TableCell>
                  <TableCell>{v.vendor}</TableCell>
                  <TableCell className="text-right">
                    <span className="num">
                      {v.dueDate
                        ? format(parseISO(v.dueDate), "dd MMM yyyy")
                        : "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <VendorStatusBadge status={v.status} />
                  </TableCell>
                </TableRow>
              ))}
              {project.vendors.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
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
    </>
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
            <Label htmlFor="proj-lead">Lead name</Label>
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
