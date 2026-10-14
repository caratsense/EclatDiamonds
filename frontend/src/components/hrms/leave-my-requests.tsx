"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveType,
} from "@/lib/mock/hrms";
import { useCancelLeave, useLeaveRequests } from "@/lib/queries/hrms";
import type { Role } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import {
  LEAVE_STATUS_BADGE,
  durationLabel,
  leaveWithdrawRight,
} from "@/components/hrms/leave-policy";
import {
  LeaveRequestDetailDialog,
  leaveRange,
} from "@/components/hrms/leave-request-detail";

const ALL = "__all";

/**
 * MY DATA → Leave Requests: the signed-in person's own history.
 *
 * Deliberately stacked rows rather than a table. This is the surface a
 * salesperson opens on a 375px terminal or phone, and the ten columns a manager
 * wants would there become ten columns of two characters each. Every row still
 * carries the four facts the employee came for — dates, type, duration, status —
 * and the rest (their reason, the approver's) is one tap away.
 *
 * Cancelled requests are shown, not hidden: a withdrawn request is the answer to
 * "what happened to my leave", and dropping it from the list makes the system
 * look as though it lost it.
 */
export function MyLeaveRequestsPanel() {
  const user = useSession((s) => s.user);
  const role = useSession((s) => s.role);
  const requests = useLeaveRequests();
  const cancel = useCancelLeave();

  const [status, setStatus] = useState<LeaveStatus | "">("");
  const [type, setType] = useState<LeaveType | "">("");
  const [detail, setDetail] = useState<LeaveRequest | null>(null);
  const [withdrawing, setWithdrawing] = useState<LeaveRequest | null>(null);

  const own = useMemo(() => {
    const mine = (requests.data ?? []).filter((r) => r.staffId === user.id);
    return mine.filter(
      (r) => (!status || r.status === status) && (!type || r.typeCode === type),
    );
  }, [requests.data, user.id, status, type]);

  const withdrawRight = withdrawing
    ? leaveWithdrawRight({ status: withdrawing.status, isOwner: true, viewerRole: role })
    : null;

  return (
    <div className="space-y-3">
      {/* One filter bar, above the list. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status || ALL}
          onValueChange={(v) => setStatus(v === ALL ? "" : (v as LeaveStatus))}
        >
          <SelectTrigger className="h-9 w-[150px]" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={type || ALL}
          onValueChange={(v) => setType(v === ALL ? "" : (v as LeaveType))}
        >
          <SelectTrigger className="h-9 w-[170px]" aria-label="Leave type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every type</SelectItem>
            {LEAVE_TYPE_ORDER.map((t) => (
              <SelectItem key={t} value={t}>
                {LEAVE_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {requests.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      ) : requests.isError ? (
        <div className="rounded-lg border border-destructive/30 p-3 text-sm">
          Couldn&apos;t load your leave requests.{" "}
          <button type="button" className="underline" onClick={() => requests.refetch()}>
            Retry
          </button>
        </div>
      ) : own.length === 0 ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          {status || type
            ? "No leave request matches these filters."
            : "You have not applied for leave yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {own.map((request) => (
            <MyLeaveRow
              key={request.id}
              request={request}
              viewerRole={role}
              onOpen={() => setDetail(request)}
              onWithdraw={() => setWithdrawing(request)}
            />
          ))}
        </ul>
      )}

      {detail ? (
        <LeaveRequestDetailDialog
          key={detail.id}
          request={detail}
          onClose={() => setDetail(null)}
        />
      ) : null}

      {withdrawing && withdrawRight?.allowed ? (
        <ReasonDialog
          key={withdrawing.id}
          open
          onOpenChange={(open) => (open ? null : setWithdrawing(null))}
          title={
            withdrawing.status === "approved"
              ? "Revoke this approved leave?"
              : "Withdraw this leave request?"
          }
          description={`${withdrawing.type} · ${leaveRange(withdrawing)}. It stays in your history as cancelled.${
            withdrawRight.warning ? ` ${withdrawRight.warning}` : ""
          }`}
          confirmLabel={withdrawRight.label}
          destructive
          pending={cancel.isPending}
          onConfirm={(reason) =>
            cancel.mutate(
              { id: withdrawing.id, reason },
              {
                onSuccess: () => {
                  toast.success("Leave request withdrawn");
                  setWithdrawing(null);
                  setDetail(null);
                },
                // Verbatim: a locked payroll month and an already-settled
                // request are different refusals, and the employee needs to
                // know which one they hit.
                onError: (error) =>
                  toast.error(apiErrorMessage(error, "Could not withdraw the request.")),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

function MyLeaveRow({
  request,
  viewerRole,
  onOpen,
  onWithdraw,
}: {
  request: LeaveRequest;
  viewerRole: Role;
  onOpen: () => void;
  onWithdraw: () => void;
}) {
  const badge = LEAVE_STATUS_BADGE[request.status];
  const withdraw = leaveWithdrawRight({
    status: request.status,
    isOwner: true,
    viewerRole,
  });

  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{request.type}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {request.halfDay ? <Badge variant="outline">Half day</Badge> : null}
          </div>
          <p className="num text-xs text-muted-foreground">
            {leaveRange(request)} · {durationLabel(request.days)}
          </p>
          {request.status !== "pending" && request.decidedBy ? (
            <p className="text-xs text-muted-foreground">
              {request.status === "cancelled" ? "Withdrawn" : request.status} ·{" "}
              {request.decidedBy}
            </p>
          ) : null}
          {request.decisionNote ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              &ldquo;{request.decisionNote}&rdquo;
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onOpen}>
            Details
          </Button>
          {withdraw.allowed ? (
            <Button type="button" size="sm" variant="ghost" onClick={onWithdraw}>
              {withdraw.label}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
