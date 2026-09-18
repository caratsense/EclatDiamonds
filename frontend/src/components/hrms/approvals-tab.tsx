"use client";

import { useState } from "react";
import { Check, Inbox, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { EmptyState } from "@/components/ui/empty-state";
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
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import {
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveStatus,
  type LeaveType,
} from "@/lib/mock/hrms";
import {
  useApprovals,
  useDecideApproval,
  useDeleteLeave,
  useEditLeave,
  type ApprovalItem,
  type ApprovalKind,
} from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";

const ALL = "__all";

const STATUS_VARIANT: Record<LeaveStatus, "secondary" | "success" | "destructive" | "outline"> = {
  pending: "secondary",
  approved: "success",
  rejected: "destructive",
  cancelled: "outline",
};

function age(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

type Decision = { item: ApprovalItem; status: "approved" | "rejected" };

/**
 * One inbox for everything waiting on a manager: leave requests and
 * attendance-fix (regularization) requests. Decisions reuse the existing
 * routes, so the rules there (no self-approval, no second decision) still hold.
 */
export function ApprovalsTab() {
  const [kind, setKind] = useState<ApprovalKind | "">("");
  const [status, setStatus] = useState<LeaveStatus | "">("pending");
  const query = useApprovals(status || undefined);
  const decide = useDecideApproval();
  const del = useDeleteLeave();
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [editing, setEditing] = useState<ApprovalItem | null>(null);
  const [deleting, setDeleting] = useState<ApprovalItem | null>(null);

  const items = (query.data ?? [])
    .filter((i) => !kind || i.kind === kind)
    .sort((a, b) => b.ageHours - a.ageHours);

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            Approvals
          </CardTitle>
          <CardDescription>
            Leave and attendance-fix requests from your stores, oldest first.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={kind || ALL} onValueChange={(v) => setKind(v === ALL ? "" : (v as ApprovalKind))}>
            <SelectTrigger className="h-9 w-[170px]" aria-label="Request type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All requests</SelectItem>
              <SelectItem value="leave">Leave</SelectItem>
              <SelectItem value="regularization">Attendance fixes</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={status || ALL}
            onValueChange={(v) => setStatus(v === ALL ? "" : (v as LeaveStatus))}
          >
            <SelectTrigger className="h-9 w-[150px]" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value={ALL}>Any status</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {query.isLoading ? (
          <>
            <Skeleton className="h-20 rounded-lg" />
            <Skeleton className="h-20 rounded-lg" />
          </>
        ) : query.isError ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load the inbox.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={status === "pending" ? "Nothing waiting on you" : "No requests match"}
            description="Leave and attendance-fix requests from your stores appear here."
          />
        ) : (
          items.map((i) => (
            <div
              key={`${i.kind}-${i.id}`}
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{i.staffName}</span>
                  <Badge variant={i.kind === "leave" ? "gold" : "outline"}>
                    {i.kind === "leave" ? "Leave" : "Attendance fix"}
                  </Badge>
                  {i.status !== "pending" ? (
                    <Badge variant={STATUS_VARIANT[i.status]}>{i.status}</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {i.storeName ? `${i.storeName} · ` : ""}
                    {age(i.ageHours)}
                  </span>
                </div>
                <p className="text-sm">{i.summary}</p>
                <p className="num text-xs text-muted-foreground">
                  {i.from}
                  {i.to && i.to !== i.from ? ` → ${i.to}` : ""}
                  {i.days != null ? ` · ${i.days} d` : ""}
                </p>
                {i.reason ? <p className="text-sm text-muted-foreground">{i.reason}</p> : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {i.status === "pending" ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setDeciding({ item: i, status: "approved" })}>
                      <Check className="h-4 w-4" />
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeciding({ item: i, status: "rejected" })}>
                      <X className="h-4 w-4" />
                      Reject
                    </Button>
                    {i.kind === "leave" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit leave for ${i.staffName}`}
                        title="Edit"
                        onClick={() => setEditing(i)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {i.kind === "leave" && i.status !== "cancelled" ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    aria-label={`Delete leave for ${i.staffName}`}
                    title="Delete"
                    onClick={() => setDeleting(i)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </CardContent>

      {deciding ? (
        <ReasonDialog
          key={`${deciding.item.id}-${deciding.status}`}
          open
          onOpenChange={(o) => (o ? null : setDeciding(null))}
          title={`${deciding.status === "approved" ? "Approve" : "Reject"} ${deciding.item.kind === "leave" ? "leave" : "attendance fix"} for ${deciding.item.staffName}?`}
          description={deciding.item.summary}
          label="Note to the employee"
          required={deciding.status === "rejected"}
          confirmLabel={deciding.status === "approved" ? "Approve" : "Reject"}
          destructive={deciding.status === "rejected"}
          pending={decide.isPending}
          onConfirm={(note) =>
            decide.mutate(
              { kind: deciding.item.kind, id: deciding.item.id, status: deciding.status, note: note || undefined },
              {
                onSuccess: () => {
                  toast.success(
                    `${deciding.status === "approved" ? "Approved" : "Rejected"} for ${deciding.item.staffName}`,
                  );
                  setDeciding(null);
                },
                onError: (err) => toast.error(apiErrorMessage(err, "Could not record the decision.")),
              },
            )
          }
        />
      ) : null}

      {deleting ? (
        <ReasonDialog
          key={deleting.id}
          open
          onOpenChange={(o) => (o ? null : setDeleting(null))}
          title={`Delete this leave for ${deleting.staffName}?`}
          description={
            deleting.status === "approved"
              ? "It is already approved — deleting it gives the days back to the balance."
              : deleting.summary
          }
          confirmLabel="Delete leave"
          destructive
          pending={del.isPending}
          onConfirm={(reason) =>
            del.mutate(
              { id: deleting.id, reason },
              {
                onSuccess: () => {
                  toast.success("Leave deleted");
                  setDeleting(null);
                },
                onError: (err) => toast.error(apiErrorMessage(err, "Could not delete the leave.")),
              },
            )
          }
        />
      ) : null}

      {editing ? <EditLeaveDialog key={editing.id} item={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function EditLeaveDialog({ item, onClose }: { item: ApprovalItem; onClose: () => void }) {
  const edit = useEditLeave();
  const [fromDate, setFromDate] = useState(item.from);
  const [toDate, setToDate] = useState(item.to || item.from);
  const [type, setType] = useState<LeaveType | "">(item.leaveType ?? "");
  const [halfDay, setHalfDay] = useState(item.halfDay ?? false);
  const [reason, setReason] = useState(item.reason ?? "");

  function save() {
    if (!type) {
      toast.error("Choose the leave type.");
      return;
    }
    if (!fromDate || !toDate || fromDate > toDate) {
      toast.error("Pick a valid date range.");
      return;
    }
    edit.mutate(
      { id: item.id, fromDate, toDate, type, halfDay, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(`Leave updated for ${item.staffName}`);
          onClose();
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the leave.")),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit leave request</DialogTitle>
          <DialogDescription>
            {item.staffName}. Only pending requests can be edited; the change is audited.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="el-type">Leave type</Label>
            <Select value={type} onValueChange={(v) => setType(v as LeaveType)}>
              <SelectTrigger id="el-type">
                <SelectValue placeholder="Choose a type" />
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPE_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {LEAVE_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="el-from">From</Label>
              <Input id="el-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="el-to">To</Label>
              <Input id="el-to" type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={halfDay}
              onChange={(e) => setHalfDay(e.target.checked)}
            />
            Half day
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="el-reason">Reason</Label>
            <Textarea id="el-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={edit.isPending}>
            {edit.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
