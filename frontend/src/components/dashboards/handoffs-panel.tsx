"use client";

import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useCreateHandoff,
  useHandoffs,
  useUpdateHandoff,
  type Handoff,
  type HandoffStatus,
} from "@/lib/queries/dashboard";
import { apiErrorMessage } from "@/lib/utils";

const DEPARTMENTS = [
  "Sales",
  "Design",
  "Production",
  "Workshop",
  "Back-office",
  "Compliance",
  "Marketing",
  "Inventory",
  "Finance",
  "HR",
];

const STATUS_META: Record<
  HandoffStatus,
  { label: string; variant: "secondary" | "default" | "success" }
> = {
  open: { label: "Open", variant: "secondary" },
  accepted: { label: "Accepted", variant: "default" },
  done: { label: "Done", variant: "success" },
};

/** Cross-department task hand-offs, live from the API. */
export function HandoffsPanel() {
  const { data, isLoading } = useHandoffs();
  const updateHandoff = useUpdateHandoff();
  const [createOpen, setCreateOpen] = useState(false);
  const handoffs = data ?? [];

  function setStatus(id: string, status: HandoffStatus) {
    updateHandoff.mutate(
      { id, status },
      {
        onSuccess: () =>
          toast.success(
            status === "done" ? "Hand-off marked done" : "Hand-off accepted",
          ),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the hand-off.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>Cross-Department Hand-offs</CardTitle>
            <CardDescription>
              Tasks passed between Sales, Design, Production and back-office
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
            New hand-off
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <>
            <Skeleton className="h-20 rounded-lg" />
            <Skeleton className="h-20 rounded-lg" />
          </>
        ) : handoffs.length === 0 ? (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            No hand-offs yet
          </p>
        ) : (
          handoffs.map((h) => {
            const status = STATUS_META[h.status] ?? STATUS_META.open;
            return (
              <div key={h.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{h.title}</p>
                    {h.note ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {h.note}
                      </p>
                    ) : null}
                  </div>
                  <Badge variant={status.variant} className="shrink-0">
                    {status.label}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    {h.fromDept}
                    <ArrowRight className="h-3 w-3" />
                    {h.toDept}
                  </span>
                  <span>By {h.createdByName}</span>
                  {h.assignedTo ? <span>Assigned: {h.assignedTo}</span> : null}
                </div>
                {h.status !== "done" ? (
                  <div className="mt-2 flex gap-2">
                    {h.status === "open" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updateHandoff.isPending}
                        onClick={() => setStatus(h.id, "accepted")}
                      >
                        Accept
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      disabled={updateHandoff.isPending}
                      onClick={() => setStatus(h.id, "done")}
                    >
                      Mark done
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </CardContent>

      <NewHandoffDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  );
}

function NewHandoffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createHandoff = useCreateHandoff();
  const [fromDept, setFromDept] = useState("Sales");
  const [toDept, setToDept] = useState("Design");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [assignedTo, setAssignedTo] = useState("");

  function reset() {
    setFromDept("Sales");
    setToDept("Design");
    setTitle("");
    setNote("");
    setAssignedTo("");
  }

  function save() {
    if (!title.trim()) {
      toast.error("Hand-off title is required.");
      return;
    }
    createHandoff.mutate(
      {
        fromDept,
        toDept,
        title: title.trim(),
        note: note.trim() || undefined,
        assignedTo: assignedTo.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Hand-off raised");
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not raise the hand-off.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New hand-off</DialogTitle>
          <DialogDescription>
            Pass a task from one department to another.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="handoff-from">From</Label>
              <Select value={fromDept} onValueChange={setFromDept}>
                <SelectTrigger id="handoff-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPARTMENTS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="handoff-to">To</Label>
              <Select value={toDept} onValueChange={setToDept}>
                <SelectTrigger id="handoff-to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPARTMENTS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="handoff-title">Title</Label>
            <Input
              id="handoff-title"
              placeholder="e.g. Custom necklace CAD approval"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="handoff-note">Note</Label>
            <Textarea
              id="handoff-note"
              placeholder="Optional context for the receiving team"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="handoff-assignee">Assign to</Label>
            <Input
              id="handoff-assignee"
              placeholder="Optional — e.g. Rohan Mehta"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createHandoff.isPending}>
            {createHandoff.isPending ? "Saving…" : "Raise hand-off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
