"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";

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
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveType,
} from "@/lib/mock/hrms";
import {
  useDecideLeave,
  useLeaveBalances,
  useLeaveRequests,
} from "@/lib/queries/hrms";
import { useDeleteLeave, useEditLeave } from "@/lib/queries/hrms-ops";
import { useStaff } from "@/lib/queries/users";
import type { Role } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import {
  LEAVE_STATUS_BADGE,
  durationLabel,
  leaveBalanceImpact,
  leaveCorrectionRight,
  leaveDecisionRight,
  type CorrectionRight,
} from "@/components/hrms/leave-policy";
import { leaveRange } from "@/components/hrms/leave-request-detail";

const ALL = "__all";

type Decision = { request: LeaveRequest; status: "approved" | "rejected" };

/**
 * TEAM → Leave Requests: the manager's queue.
 *
 * Two things this screen refuses to do. It never offers a button that must
 * fail: the server decides leave one rank above the requester and never by the
 * requester's own hand, so a row the signed-in manager may not decide shows WHO
 * can instead of an Approve button that 403s. And it never asks for a decision
 * the manager cannot cost — expanding a row shows the reason and what approval
 * does to that person's balance before either button is in reach.
 *
 * The balance arithmetic is fetched per EXPANDED row, not per row: a 40-request
 * queue would otherwise open 40 balance requests to show numbers nobody read.
 *
 * Deciding is not the only thing a manager does here. A request filed with the
 * wrong dates or type is CORRECTED rather than rejected and re-filed, and a row
 * that should not exist at all is deleted — both inside the expanded row, both
 * behind the same rank rules, and both audited by the server.
 */
export function TeamLeaveRequestsPanel() {
  const viewer = useSession((s) => s.user);
  const viewerRole = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const requests = useLeaveRequests();
  const { data: staff = [] } = useStaff();
  const decide = useDecideLeave();
  const remove = useDeleteLeave();

  const [status, setStatus] = useState<LeaveStatus | "">("pending");
  const [staffId, setStaffId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [editing, setEditing] = useState<LeaveRequest | null>(null);
  const [deleting, setDeleting] = useState<LeaveRequest | null>(null);

  /** The applicant's role decides who may sign the request off. */
  const roleOf = useMemo(() => {
    const map = new Map<string, Role>();
    for (const s of staff) map.set(s.id, s.role as Role);
    return map;
  }, [staff]);

  const storeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stores) map.set(s.id, s.name);
    return map;
  }, [stores]);

  const rows = useMemo(() => {
    const filtered = (requests.data ?? []).filter((r) => {
      if (status && r.status !== status) return false;
      if (staffId && r.staffId !== staffId) return false;
      if (storeId && r.storeId !== storeId) return false;
      // A date window matches any request that OVERLAPS it — a manager looking
      // at next week wants the leave that runs into next week, not only the
      // leave that starts in it.
      if (from && (r.toDate ?? r.fromDate ?? "") < from) return false;
      if (to && (r.fromDate ?? r.toDate ?? "") > to) return false;
      return true;
    });
    // Waiting first, then newest range.
    return filtered.sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === "pending") return -1;
        if (b.status === "pending") return 1;
      }
      return (b.fromDate ?? "").localeCompare(a.fromDate ?? "");
    });
  }, [requests.data, status, staffId, storeId, from, to]);

  const filtered = !!(status || staffId || storeId || from || to);
  const realStores = stores.filter((s) => !s.isAggregate);

  return (
    <div className="space-y-3">
      {/* One filter bar: who, where, when, what state. */}
      <div className="flex flex-wrap items-end gap-2">
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
        <Select
          value={staffId || ALL}
          onValueChange={(v) => setStaffId(v === ALL ? "" : v)}
        >
          <SelectTrigger className="h-9 w-[190px]" aria-label="Employee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everyone</SelectItem>
            {staff.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {realStores.length > 1 ? (
          <Select
            value={storeId || ALL}
            onValueChange={(v) => setStoreId(v === ALL ? "" : v)}
          >
            <SelectTrigger className="h-9 w-[190px]" aria-label="Store">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every store</SelectItem>
              {realStores.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="grid gap-1">
          <Label htmlFor="team-leave-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="team-leave-from"
            type="date"
            className="h-9 w-[150px]"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="team-leave-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="team-leave-to"
            type="date"
            className="h-9 w-[150px]"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      {requests.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      ) : requests.isError ? (
        <div className="rounded-lg border border-destructive/30 p-3 text-sm">
          Couldn&apos;t load the team&apos;s leave requests.{" "}
          <button type="button" className="underline" onClick={() => requests.refetch()}>
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          {status === "pending" && !staffId && !storeId && !from && !to
            ? "Nothing is waiting on you."
            : filtered
              ? "No leave request matches these filters."
              : "No leave has been requested here yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((request) => {
            // Correcting a row is a different server rule from deciding it, so
            // each control asks its own question rather than reusing the
            // decision's answer.
            const correction = {
              status: request.status,
              managerRole: viewerRole,
              managerId: viewer.id,
              staffRole: roleOf.get(request.staffId) ?? null,
              staffId: request.staffId,
            } as const;
            return (
              <TeamLeaveRow
                key={request.id}
                request={request}
                storeName={storeName.get(request.storeId) ?? null}
                right={leaveDecisionRight({
                  status: request.status,
                  approverRole: viewerRole,
                  approverId: viewer.id,
                  requesterRole: roleOf.get(request.staffId) ?? null,
                  requesterId: request.staffId,
                })}
                editRight={leaveCorrectionRight({ action: "edit", ...correction })}
                deleteRight={leaveCorrectionRight({ action: "delete", ...correction })}
                open={expanded === request.id}
                onToggle={() =>
                  setExpanded((current) => (current === request.id ? null : request.id))
                }
                onDecide={(decision) => setDeciding({ request, status: decision })}
                onEdit={() => setEditing(request)}
                onDelete={() => setDeleting(request)}
              />
            );
          })}
        </ul>
      )}

      {deciding ? (
        <ReasonDialog
          key={`${deciding.request.id}-${deciding.status}`}
          open
          onOpenChange={(o) => (o ? null : setDeciding(null))}
          title={`${deciding.status === "approved" ? "Approve" : "Reject"} ${deciding.request.name}'s leave?`}
          description={`${deciding.request.type} · ${leaveRange(deciding.request)} · ${durationLabel(
            deciding.request.days,
          )}`}
          label="Note to the employee"
          // A rejection the employee cannot understand is a rejection they will
          // ask about at the counter; the note is shown back to them verbatim.
          required={deciding.status === "rejected"}
          confirmLabel={deciding.status === "approved" ? "Approve" : "Reject"}
          destructive={deciding.status === "rejected"}
          pending={decide.isPending}
          onConfirm={(note) =>
            decide.mutate(
              {
                id: deciding.request.id,
                status: deciding.status,
                note: note || undefined,
              },
              {
                onSuccess: () => {
                  toast.success(
                    `${deciding.status === "approved" ? "Approved" : "Rejected"} for ${deciding.request.name}`,
                  );
                  setDeciding(null);
                },
                // Verbatim: insufficient balance at decision time, a locked
                // payroll month and the rank rule are three different answers.
                onError: (err) =>
                  toast.error(apiErrorMessage(err, "Could not record the decision.")),
              },
            )
          }
        />
      ) : null}

      {/*
        Deletion is permanent and the server demands a reason for the audit
        trail, so it goes through the same confirm-with-reason step the decision
        does — and the copy says what the deletion COSTS before it is confirmed:
        an approved request's days go back to the person's balance.
      */}
      {deleting ? (
        <ReasonDialog
          key={`delete-${deleting.id}`}
          open
          onOpenChange={(o) => (o ? null : setDeleting(null))}
          title={`Delete ${deleting.name}'s leave request?`}
          description={`${deleting.type} · ${leaveRange(deleting)} · ${durationLabel(
            deleting.days,
          )}. ${
            deleting.status === "approved"
              ? `It is already approved — deleting it returns ${durationLabel(
                  deleting.days,
                )} to ${deleting.name}'s balance.`
              : "The request is removed from the list for good."
          }`}
          label="Why it is being deleted"
          confirmLabel="Delete leave"
          destructive
          pending={remove.isPending}
          onConfirm={(reason) =>
            remove.mutate(
              { id: deleting.id, reason },
              {
                onSuccess: () => {
                  toast.success(`Leave deleted for ${deleting.name}`);
                  setDeleting(null);
                },
                // Verbatim: a locked payroll month, a row that moved out of
                // scope and the rank rule are three different refusals.
                onError: (err) =>
                  toast.error(apiErrorMessage(err, "Could not delete the leave request.")),
              },
            )
          }
        />
      ) : null}

      {editing ? (
        <EditTeamLeaveDialog
          key={`edit-${editing.id}`}
          request={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function TeamLeaveRow({
  request,
  storeName,
  right,
  editRight,
  deleteRight,
  open,
  onToggle,
  onDecide,
  onEdit,
  onDelete,
}: {
  request: LeaveRequest;
  storeName: string | null;
  right: ReturnType<typeof leaveDecisionRight>;
  editRight: CorrectionRight;
  deleteRight: CorrectionRight;
  open: boolean;
  onToggle: () => void;
  onDecide: (status: "approved" | "rejected") => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const badge = LEAVE_STATUS_BADGE[request.status];
  return (
    <li className="rounded-lg border">
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{request.name}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <Badge variant="gold">{request.type}</Badge>
            {request.halfDay ? <Badge variant="outline">Half day</Badge> : null}
          </div>
          <p className="num text-xs text-muted-foreground">
            {leaveRange(request)} · {durationLabel(request.days)}
            {storeName ? ` · ${storeName}` : ""}
          </p>
          {request.reason ? (
            <p className="line-clamp-1 text-xs text-muted-foreground">{request.reason}</p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 self-start"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
          {open ? "Hide" : "Review"}
        </Button>
      </div>

      {open ? (
        <div className="space-y-3 border-t p-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              Reason given by {request.name}
            </p>
            <p className="rounded-lg border bg-muted/30 p-3 text-sm">
              {request.reason?.trim() || "No reason was given."}
            </p>
          </div>

          <BalanceImpact request={request} />

          {request.status !== "pending" ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {request.status === "cancelled" ? "Withdrawal" : "Decision"}
              </p>
              <div className="rounded-lg border p-3 text-sm">
                <p>
                  {badge.label}
                  {request.decidedBy ? ` by ${request.decidedBy}` : ""}
                  {request.decidedAt
                    ? ` on ${new Date(request.decidedAt).toLocaleString("en-IN")}`
                    : ""}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {request.decisionNote?.trim() || "No note was recorded."}
                </p>
              </div>
            </div>
          ) : right.allowed ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => onDecide("approved")}>
                <Check className="h-4 w-4" />
                Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onDecide("rejected")}
              >
                <X className="h-4 w-4" />
                Reject
              </Button>
            </div>
          ) : (
            // No button here would be anything but a 403 — say who can instead.
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              {right.message}
            </p>
          )}

          {/*
            The manager's corrections, kept apart from the decision so Delete
            never sits beside Approve as though it were the third option. Each
            control is drawn only where the server would accept it: Edit on a
            pending row, Delete on any row that still exists, and neither on a
            peer's or one's own request.
          */}
          {editRight.allowed || deleteRight.allowed ? (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                Correct this request
              </p>
              <div className="flex flex-wrap gap-2">
                {editRight.allowed ? (
                  <Button type="button" size="sm" variant="outline" onClick={onEdit}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </Button>
                ) : null}
                {deleteRight.allowed ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    onClick={onDelete}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                ) : null}
              </div>
              <p className="num text-xs text-muted-foreground">
                {request.status === "approved" && deleteRight.allowed
                  ? `Deleting this approved leave returns ${durationLabel(request.days)} to ${request.name}'s balance.`
                  : "A correction is recorded against your name in the audit trail."}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A manager's correction of a PENDING request — the dates, type, half-day flag
 * and reason the employee filed.
 *
 * Mounted per request (`key`) so the form seeds from props. The server re-runs
 * every apply-time rule on the new range (overlap with another request, working
 * days in the range, the paid balance, a locked payroll month), and its refusal
 * is shown inside this dialog rather than as a toast behind it — the form stays
 * open on the dates that were refused, which is where the fix has to be made.
 */
function EditTeamLeaveDialog({
  request,
  onClose,
}: {
  request: LeaveRequest;
  onClose: () => void;
}) {
  const edit = useEditLeave();
  const [fromDate, setFromDate] = useState(request.fromDate ?? "");
  const [toDate, setToDate] = useState(request.toDate ?? request.fromDate ?? "");
  const [type, setType] = useState<LeaveType | "">(request.typeCode ?? "");
  const [halfDay, setHalfDay] = useState(request.halfDay ?? false);
  const [reason, setReason] = useState(request.reason ?? "");
  /** The server's last refusal, shown in the dialog it was refused from. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const rangeValid = !!fromDate && !!toDate && toDate >= fromDate;
  // The server refuses a half day across a range, so the flag only applies to a
  // single date — disabled rather than left to fail at submit.
  const singleDate = rangeValid && fromDate === toDate;
  const effectiveHalfDay = halfDay && singleDate;

  function save() {
    if (!type) {
      setRefusal("Choose the leave type.");
      return;
    }
    if (!rangeValid) {
      setRefusal("Pick a valid date range — the end date can't be before the start.");
      return;
    }
    edit.mutate(
      {
        id: request.id,
        fromDate,
        toDate,
        type,
        halfDay: effectiveHalfDay,
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(`Leave updated for ${request.name}`);
          onClose();
        },
        onError: (err) =>
          setRefusal(apiErrorMessage(err, "Could not update the leave request.")),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit leave request</DialogTitle>
          <DialogDescription>
            {request.name}. Only a pending request can be edited, and the change is
            audited against your name.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="team-leave-edit-type">Leave type</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                setRefusal(null);
                setType(v as LeaveType);
              }}
            >
              <SelectTrigger id="team-leave-edit-type">
                <SelectValue placeholder="Choose a type" />
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPE_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {LEAVE_TYPE_LABELS[t]}
                    {t === "festival" ? " (unpaid)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="team-leave-edit-from">From</Label>
              <Input
                id="team-leave-edit-from"
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setRefusal(null);
                  setFromDate(e.target.value);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="team-leave-edit-to">To</Label>
              <Input
                id="team-leave-edit-to"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => {
                  setRefusal(null);
                  setToDate(e.target.value);
                }}
              />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={effectiveHalfDay}
              disabled={!singleDate}
              onChange={(e) => {
                setRefusal(null);
                setHalfDay(e.target.checked);
              }}
            />
            <span>
              Half day
              <span className="block text-xs text-muted-foreground">
                {singleDate
                  ? "Counts as 0.5 day against the balance."
                  : "Only for a single date — set From and To to the same day."}
              </span>
            </span>
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="team-leave-edit-reason">Reason</Label>
            <Textarea
              id="team-leave-edit-reason"
              value={reason}
              onChange={(e) => {
                setRefusal(null);
                setReason(e.target.value);
              }}
            />
          </div>
          {refusal ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              {refusal}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={edit.isPending}>
            {edit.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What approving this request does to the person's allocation.
 *
 * Mounted only inside an expanded row, so the balance request happens when a
 * manager actually looks at one. The figure that can still refuse an approval
 * is `allotted − used − these days`: pending days are already reserved, so
 * approval moves them from pending into used and leaves `available` alone.
 */
function BalanceImpact({ request }: { request: LeaveRequest }) {
  const type = request.typeCode;
  const { data: balances = [], isLoading } = useLeaveBalances(request.staffId);
  const row = balances.find((b) => b.type === type);
  const impact = type
    ? leaveBalanceImpact({
        type,
        days: request.days,
        balance: row
          ? { allocated: row.allocated, used: row.used, pending: row.pending }
          : null,
      })
    : null;

  if (!type) return null;
  if (isLoading) return <Skeleton className="h-16 rounded-lg" />;
  if (!impact) {
    return (
      <p className="text-sm text-muted-foreground">
        {LEAVE_TYPE_LABELS[type]} leave is not allotted to {request.name} yet.
      </p>
    );
  }
  if (!impact.paid) {
    return (
      <p className="text-sm text-muted-foreground">
        {LEAVE_TYPE_LABELS[type]} leave is unpaid — no balance is charged.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Balance impact · {LEAVE_TYPE_LABELS[type]}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Figure label="Allotted" value={impact.allocated} />
        <Figure label="Used" value={impact.used} />
        <Figure label="Pending" value={impact.pending} />
        <Figure label="Available" value={impact.available} />
      </dl>
      <p className="num text-xs text-muted-foreground">
        Approving charges {durationLabel(request.days)}: used {impact.used} → {impact.usedAfter} of{" "}
        {impact.allocated}. These days are already reserved, so available stays at{" "}
        {impact.available}.
      </p>
      {impact.overdrawn ? (
        <p className="num text-xs font-medium text-destructive">
          Approving would overdraw — only {impact.chargeableNow} day(s) are left to charge.
          The server refuses it.
        </p>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num font-medium">{value}</dd>
    </div>
  );
}
