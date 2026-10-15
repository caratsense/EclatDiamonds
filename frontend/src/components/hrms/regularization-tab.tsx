"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Clock3, Plus, RefreshCw, X } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_RANK, type Role } from "@/lib/types";
import { useSession } from "@/store/use-session";
import type { LeaveStatus } from "@/lib/mock/hrms";
import {
  useDecideRegularization,
  useRegularizations,
  type RegularizationReview,
} from "@/lib/queries/hrms";
import { useStaff } from "@/lib/queries/users";
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import { RegularizeDialog } from "@/components/hrms/regularize-dialog";
import {
  attendanceStatusLabel,
  correctionDecisionRight,
  driftBlocksApproval,
  formatDayLabel,
  formatWorkedMins,
} from "@/components/hrms/attendance-correction-policy";
import { apiErrorMessage } from "@/lib/utils";

const STATUS_META: Record<
  LeaveStatus,
  { label: string; variant: "success" | "secondary" | "destructive" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

const ANY = "__any";

/** One side of the comparison: the punches, the status and the hours. */
function PunchSide({
  heading,
  caption,
  checkInLocal,
  checkOutLocal,
  status,
  workedMins,
  muted,
  children,
}: {
  heading: string;
  caption?: string;
  checkInLocal: string | null;
  checkOutLocal: string | null;
  status: string | null;
  workedMins: number | null;
  /** The side that is NOT in force — rendered quieter so the eye picks the other. */
  muted?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${muted ? "bg-muted/20" : "bg-card"}`}
    >
      <p className="text-xs font-medium text-muted-foreground">{heading}</p>
      <div className="num mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>In {checkInLocal || "—"}</span>
        <span>Out {checkOutLocal || "—"}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{attendanceStatusLabel(status)}</Badge>
        <span className="num text-muted-foreground">
          {formatWorkedMins(workedMins)}
        </span>
        {children}
      </div>
      {caption ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
}

/**
 * One correction request, with everything a decision needs: the punches as the
 * day holds them, what approving would make it, and the shift both are judged
 * against. The approver used to see the proposed times alone, so the only
 * honest way to answer "is this right?" was to go and look the day up by hand.
 */
export function CorrectionRequest({
  row,
  showName,
  decidable,
  pending,
  onDecide,
  onReload,
}: {
  row: RegularizationReview;
  /** Off on the self list, where every row is the reader's own. */
  showName?: boolean;
  decidable?: boolean;
  pending?: boolean;
  onDecide?: (status: "approved" | "rejected") => void;
  onReload?: () => void;
}) {
  const meta = STATUS_META[row.status];
  const isPending = row.status === "pending";
  const proposed = row.proposed;
  const drifted = driftBlocksApproval(row.stale);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          {showName ? (
            <Avatar className="h-8 w-8">
              <AvatarFallback className="text-xs">{row.initials}</AvatarFallback>
            </Avatar>
          ) : null}
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              {showName ? <span className="font-medium">{row.name}</span> : null}
              <Badge variant="outline">{formatDayLabel(row.date)}</Badge>
              {row.shift ? (
                <span className="num text-xs text-muted-foreground">
                  {row.shift.name ?? "Shift"} · {row.shift.startTime}–
                  {row.shift.endTime}
                  {row.shift.isFlexible ? " (flexible)" : ""}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">No shift assigned</span>
              )}
            </div>
            {row.reason ? (
              <p className="text-sm text-muted-foreground">{row.reason}</p>
            ) : null}
          </div>
        </div>
        <Badge variant={meta.variant} className="shrink-0 self-start">
          {meta.label}
        </Badge>
      </div>

      {/* Original vs proposed. Which side is in force depends on the status —
          a PENDING request has changed nothing, and must not look as if it has. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <PunchSide
          heading={
            isPending
              ? "On the record now"
              : row.status === "approved"
                ? "Before"
                : "On the record (unchanged)"
          }
          caption={
            row.original.captured
              ? undefined
              : "Not captured — this request was filed before the original was recorded."
          }
          checkInLocal={row.original.checkInLocal}
          checkOutLocal={row.original.checkOutLocal}
          status={row.original.status}
          workedMins={row.original.workedMins}
          muted={row.status === "approved"}
        />
        <PunchSide
          heading={
            isPending
              ? "If approved"
              : row.status === "approved"
                ? "Applied"
                : "Was requested"
          }
          checkInLocal={proposed?.checkInLocal ?? null}
          checkOutLocal={proposed?.checkOutLocal ?? null}
          status={proposed?.status ?? null}
          workedMins={proposed?.workedMins ?? null}
          muted={row.status !== "approved"}
        >
          {proposed?.isLate ? (
            <Badge variant="warning">
              Late{proposed.lateMinutes ? ` ${proposed.lateMinutes}m` : ""}
            </Badge>
          ) : null}
          {proposed?.overtimeMins ? (
            <Badge variant="outline">
              OT {formatWorkedMins(proposed.overtimeMins)}
            </Badge>
          ) : null}
          {proposed?.earlyOutMinutes ? (
            <Badge variant="warning">Left early {proposed.earlyOutMinutes}m</Badge>
          ) : null}
          {proposed && proposed.dayFraction != null && proposed.dayFraction < 1 ? (
            <Badge variant="warning">
              {proposed.dayFraction === 0.5 ? "Half day" : "Short day"}
            </Badge>
          ) : null}
        </PunchSide>
      </div>

      {isPending ? (
        <p className="text-xs text-muted-foreground">
          Still awaiting a decision — the attendance record is unchanged.
        </p>
      ) : null}

      {/* The day moved after this was filed: approving it is refused (409), so
          say so before the button is pressed rather than after. Rejecting it is
          still fine — a rejection writes nothing to the day. */}
      {isPending && drifted ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <p className="text-xs">{drifted}</p>
          {onReload ? (
            <Button size="sm" variant="outline" onClick={onReload}>
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}

      {row.status !== "pending" && (row.decidedBy || row.decisionNote) ? (
        <p className="text-xs text-muted-foreground">
          {row.status === "approved" ? "Approved" : "Rejected"}
          {row.decidedBy ? ` by ${row.decidedBy}` : ""}
          {row.decidedAt
            ? ` on ${new Date(row.decidedAt).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
              })}`
            : ""}
          {row.decisionNote ? ` — ${row.decisionNote}` : ""}
        </p>
      ) : null}

      {decidable && onDecide ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || drifted != null}
            onClick={() => onDecide("approved")}
          >
            <Check className="h-4 w-4" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onDecide("rejected")}
          >
            <X className="h-4 w-4" />
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Pending first, then the most recent day. */
function ordered(rows: RegularizationReview[]): RegularizationReview[] {
  return [...rows].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return b.date.localeCompare(a.date);
  });
}

function LoadFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-center">
      <p className="text-sm font-medium">Couldn&apos;t load correction requests.</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * "My correction requests" — the staffer's own filings, pending and settled,
 * each carrying the decision and the rejection reason it came with.
 */
export function MyCorrectionRequests() {
  const { user } = useSession();
  const { data: rows = [], isLoading, isError, refetch } = useRegularizations();
  const [open, setOpen] = useState(false);

  // A manager's list carries the whole store; this screen is their own record.
  const mine = useMemo(
    () => ordered(rows.filter((r) => r.staffId === user.id)),
    [rows, user.id],
  );
  const pending = mine.filter((r) => r.status === "pending");
  const settled = mine.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              My correction requests
            </CardTitle>
            <CardDescription>
              A fix for a missed or wrong punch. Nothing changes on your record
              until someone one rank above you approves it.
            </CardDescription>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            Request correction
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <>
              <Skeleton className="h-28 rounded-lg" />
              <Skeleton className="h-28 rounded-lg" />
            </>
          ) : isError ? (
            <LoadFailure onRetry={() => refetch()} />
          ) : mine.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              You haven&apos;t asked for any attendance correction.
            </p>
          ) : (
            <>
              {pending.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Pending
                  </p>
                  {pending.map((row) => (
                    <CorrectionRequest key={row.id} row={row} />
                  ))}
                </div>
              ) : null}
              {settled.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Completed
                  </p>
                  {settled.map((row) => (
                    <CorrectionRequest key={row.id} row={row} />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <RegularizeDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

/**
 * The team's correction requests — the deciding screen (store_manager+).
 *
 * Approving carries an optional note and rejecting REQUIRES a reason: a refusal
 * the staffer cannot read is a refusal they will only file again.
 */
export function TeamCorrectionRequests() {
  const { role, user } = useSession();
  const canDecideAny = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const { data: rows = [], isLoading, isError, refetch } = useRegularizations();
  // Roles for the rank-above mirror below; nobody else needs the staff list.
  const { data: staff = [] } = useStaff(undefined, { enabled: canDecideAny });
  const decide = useDecideRegularization();
  const [status, setStatus] = useState("pending");
  const [intent, setIntent] = useState<{
    row: RegularizationReview;
    status: "approved" | "rejected";
  } | null>(null);

  const roleById = useMemo(
    () => new Map(staff.map((s) => [s.id, s.role as Role])),
    [staff],
  );

  const shown = useMemo(() => {
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    return ordered(filtered);
  }, [rows, status]);

  function confirmDecision(note: string) {
    if (!intent) return;
    const { row, status: next } = intent;
    decide.mutate(
      { id: row.id, status: next, ...(note ? { note } : {}) },
      {
        onSuccess: () => {
          setIntent(null);
          toast.success(
            `${next === "approved" ? "Approved" : "Rejected"} the attendance fix for ${row.name}`,
          );
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not update the request.")),
      },
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            Correction requests
          </CardTitle>
          <CardDescription>
            Compare the punches on the record against the ones being asked for
            before you decide. A pending request has changed nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5 sm:max-w-xs">
            <Select value={status || ANY} onValueChange={(v) => setStatus(v === ANY ? "" : v)}>
              <SelectTrigger aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value={ANY}>Any status</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <>
              <Skeleton className="h-28 rounded-lg" />
              <Skeleton className="h-28 rounded-lg" />
            </>
          ) : isError ? (
            <LoadFailure onRetry={() => refetch()} />
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {status === "pending"
                ? "No correction requests are waiting on you."
                : "No correction requests match this filter."}
            </p>
          ) : (
            <div className="space-y-2">
              {shown.map((row) => (
                <CorrectionRequest
                  key={row.id}
                  row={row}
                  showName
                  decidable={
                    correctionDecisionRight({
                      status: row.status,
                      approverRole: role,
                      approverId: user.id,
                      requesterRole: roleById.get(row.staffId),
                      requesterId: row.staffId,
                    }).allowed
                  }
                  pending={decide.isPending}
                  onReload={() => refetch()}
                  onDecide={(next) => setIntent({ row, status: next })}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {intent ? (
        <ReasonDialog
          key={`${intent.row.id}:${intent.status}`}
          open
          onOpenChange={(o) => (o ? null : setIntent(null))}
          title={
            intent.status === "approved"
              ? "Approve this correction?"
              : "Reject this correction?"
          }
          description={`${intent.row.name} · ${formatDayLabel(intent.row.date)}. ${
            intent.status === "approved"
              ? "The punches, hours and status shown as “If approved” are written to the record."
              : "The record stays as it is. Your reason is shown to them."
          }`}
          label={intent.status === "approved" ? "Note" : "Reason"}
          required={intent.status === "rejected"}
          confirmLabel={intent.status === "approved" ? "Approve" : "Reject"}
          destructive={intent.status === "rejected"}
          pending={decide.isPending}
          onConfirm={confirmDecision}
        />
      ) : null}
    </div>
  );
}

/**
 * The combined view still used by the HRMS overview page. A manager keeps a
 * real personal list as well as the team's — the same split the Attendance
 * module makes explicit with My Data / Team tabs.
 */
export function RegularizationTab() {
  const { role } = useSession();
  const canDecide = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  return (
    <div className="space-y-4">
      {canDecide ? <TeamCorrectionRequests /> : null}
      <MyCorrectionRequests />
    </div>
  );
}
