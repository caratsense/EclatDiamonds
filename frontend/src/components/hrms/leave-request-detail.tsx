"use client";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LeaveRequest } from "@/lib/mock/hrms";
import { LEAVE_STATUS_BADGE, durationLabel } from "@/components/hrms/leave-policy";

/**
 * One leave request, in full — shared by the employee's own history and the
 * manager's team list so both read the same facts in the same order.
 *
 * The reason and the decision are kept as two clearly separate blocks. Rolling
 * them into one "notes" field is how an employee ends up reading their own
 * words back at them under a heading that says the approver wrote it.
 */

/** "Mon 7 Sep 2026" from a store-local YYYY-MM-DD, with no timezone re-reading. */
export function formatLeaveDay(ymd: string | undefined, fallback: string): string {
  if (!ymd) return fallback;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return fallback;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The range as one line: a single date stays a single date, not "7 Sep – 7 Sep". */
export function leaveRange(request: LeaveRequest): string {
  const from = formatLeaveDay(request.fromDate, request.from);
  if (request.fromDate && request.fromDate === request.toDate) return from;
  return `${from} → ${formatLeaveDay(request.toDate, request.to)}`;
}

export function LeaveRequestDetailDialog({
  request,
  onClose,
}: {
  request: LeaveRequest;
  onClose: () => void;
}) {
  const badge = LEAVE_STATUS_BADGE[request.status];
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {request.type} leave
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </DialogTitle>
          <DialogDescription>{request.name}</DialogDescription>
        </DialogHeader>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Fact label="Dates" value={leaveRange(request)} />
          <Fact
            label="Chargeable days"
            value={`${durationLabel(request.days)}${request.halfDay ? " (half day)" : ""}`}
            numeric
          />
        </dl>

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            Reason given by {request.name}
          </p>
          <p className="rounded-lg border bg-muted/30 p-3 text-sm">
            {request.reason?.trim() || "No reason was given."}
          </p>
        </div>

        {request.status === "pending" ? (
          <p className="text-sm text-muted-foreground">Awaiting a decision.</p>
        ) : (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {request.status === "cancelled" ? "Withdrawal" : "Decision"}
            </p>
            <div className="rounded-lg border p-3 text-sm">
              <p>
                {request.status === "cancelled"
                  ? "Withdrawn"
                  : request.status === "approved"
                    ? "Approved"
                    : "Rejected"}
                {request.decidedBy ? ` by ${request.decidedBy}` : ""}
                {request.decidedAt
                  ? ` on ${new Date(request.decidedAt).toLocaleString("en-IN")}`
                  : ""}
              </p>
              <p className="mt-1 text-muted-foreground">
                {request.decisionNote?.trim() ||
                  (request.status === "rejected"
                    ? "No reason was recorded."
                    : "No note was added.")}
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fact({
  label,
  value,
  numeric,
}: {
  label: string;
  value: string;
  numeric?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={numeric ? "num font-medium" : "font-medium"}>{value}</dd>
    </div>
  );
}
