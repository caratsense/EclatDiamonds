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
  useAssignableUsers,
  useCreateHandoff,
  useHandoffs,
  useUpdateHandoff,
  type Handoff,
  type HandoffStatus,
} from "@/lib/queries/dashboard";
import { useSession } from "@/store/use-session";
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
  accepted: { label: "In progress", variant: "default" },
  done: { label: "Awaiting approval", variant: "default" },
  closed: { label: "Closed", variant: "success" },
};

/** Cross-department task hand-offs, live from the API. */
export function HandoffsPanel() {
  const { data, isLoading } = useHandoffs();
  const updateHandoff = useUpdateHandoff();
  const myId = useSession((s) => s.user.id);
  const [createOpen, setCreateOpen] = useState(false);
  const handoffs = data ?? [];

  function setStatus(id: string, status: HandoffStatus) {
    updateHandoff.mutate(
      { id, status },
      {
        onSuccess: () =>
          toast.success(
            status === "done"
              ? "Marked done — sent back for approval"
              : status === "closed"
                ? "Hand-off approved & closed"
                : "Hand-off updated",
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
                  <span>By {h.createdBy}</span>
                  {h.assignedTo ? <span>Assigned: {h.assignedTo}</span> : null}
                </div>
                <HandoffActions
                  handoff={h}
                  myId={myId}
                  busy={updateHandoff.isPending}
                  onSet={setStatus}
                />
              </div>
            );
          })
        )}
      </CardContent>

      <NewHandoffDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  );
}

/**
 * Whose move it is: the assignee marks an open hand-off done, then the creator
 * approves & closes it. Anyone else sees a "waiting for …" note.
 */
function HandoffActions({
  handoff: h,
  myId,
  busy,
  onSet,
}: {
  handoff: Handoff;
  myId: string;
  busy: boolean;
  onSet: (id: string, s: HandoffStatus) => void;
}) {
  const isAssignee = h.assignedToId === myId;
  const isCreator = h.createdById === myId;

  if (isAssignee && (h.status === "open" || h.status === "accepted")) {
    return (
      <div className="mt-2">
        <Button size="sm" disabled={busy} onClick={() => onSet(h.id, "done")}>
          Mark done
        </Button>
      </div>
    );
  }
  if (isCreator && h.status === "done") {
    return (
      <div className="mt-2">
        <Button size="sm" disabled={busy} onClick={() => onSet(h.id, "closed")}>
          Approve &amp; close
        </Button>
      </div>
    );
  }
  if (h.status === "done") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Waiting for {h.createdBy} to approve.
      </p>
    );
  }
  if ((h.status === "open" || h.status === "accepted") && h.assignedTo) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Waiting for {h.assignedTo} to finish.
      </p>
    );
  }
  return null;
}

function NewHandoffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createHandoff = useCreateHandoff();
  const { data: assignableUsers = [] } = useAssignableUsers();
  const [fromDept, setFromDept] = useState("Sales");
  const [toDept, setToDept] = useState("Design");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [assignedToId, setAssignedToId] = useState("");

  function reset() {
    setFromDept("Sales");
    setToDept("Design");
    setTitle("");
    setNote("");
    setAssignedToId("");
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
        assignedToId: assignedToId || undefined,
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
            {assignableUsers.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                No teammates in this store to assign to yet.
              </p>
            ) : (
              <Select value={assignedToId} onValueChange={setAssignedToId}>
                <SelectTrigger id="handoff-assignee">
                  <SelectValue placeholder="Choose a teammate to notify" />
                </SelectTrigger>
                <SelectContent>
                  {assignableUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-[11px] text-muted-foreground">
              They get a notification and mark it done; it then comes back to you
              to approve.
            </p>
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
