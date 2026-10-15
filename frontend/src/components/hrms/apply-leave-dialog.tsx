"use client";

import { useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiErrorMessage, cn } from "@/lib/utils";
import {
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveType,
} from "@/lib/mock/hrms";
import { useApplyLeave, useLeavePreview, type LeavePreview } from "@/lib/queries/hrms";
import { durationLabel, skippedDaysNote } from "@/components/hrms/leave-policy";

/**
 * Apply-for-leave dialog (Module 6). Self-service: any staffer requests leave;
 * the backend computes working days (excludes weekly-off + holidays), guards the
 * paid balance, and returns the leave view. Festival is unpaid (no balance check).
 *
 * The form no longer guesses at the cost of a range. GET /hrms/leave/preview
 * runs the SAME calculation POST /hrms/leave will charge, and the panel below
 * the dates shows its answer before anybody submits: how many days, which dates
 * in the range it skipped as offs or holidays, and where the balance lands. The
 * previewed figure is then sent back with the application, so if the roster
 * moved underneath the form the server refuses it out loud rather than quietly
 * charging a different number than the employee was shown.
 *
 * Refusals are rendered here, verbatim, rather than flattened into one apology:
 * "that range contains no working days", "insufficient casual balance: 2 day(s)
 * available", an overlap with an existing request and a locked payroll month are
 * four different problems with four different fixes.
 */
export function ApplyLeaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const applyLeave = useApplyLeave();
  const [type, setType] = useState<LeaveType>("casual");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState("");
  /** The server's last refusal, shown in the dialog it was refused from. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const rangeValid = !!fromDate && !!toDate && toDate >= fromDate;
  // The server refuses a half day across a range, so the toggle only applies to
  // a single date — disabled rather than left to fail at submit.
  const singleDate = rangeValid && fromDate === toDate;
  const effectiveHalfDay = halfDay && singleDate;

  const preview = useLeavePreview(
    { from: fromDate, to: toDate, halfDay: effectiveHalfDay, type },
    { enabled: open && rangeValid },
  );

  function reset() {
    setType("casual");
    setFromDate("");
    setToDate("");
    setHalfDay(false);
    setReason("");
    setRefusal(null);
  }

  /** Any edit invalidates the last refusal — it was about the old dates. */
  function edited<T>(set: (value: T) => void) {
    return (value: T) => {
      setRefusal(null);
      set(value);
    };
  }

  // Don't offer a submit the preview has already told us will be refused.
  const blocked =
    preview.isError ||
    (preview.data
      ? preview.data.days <= 0 || preview.data.balance?.sufficient === false
      : false);

  function submit() {
    if (!fromDate || !toDate) {
      setRefusal("Pick both a start and end date.");
      return;
    }
    if (toDate < fromDate) {
      setRefusal("The end date can't be before the start date.");
      return;
    }
    applyLeave.mutate(
      {
        type,
        fromDate,
        toDate,
        halfDay: effectiveHalfDay || undefined,
        reason: reason.trim() || undefined,
        // Round-trip the previewed count. The server accepts it only while it
        // still agrees, so a stale preview is refused by name instead of
        // silently charging something the form never showed.
        ...(preview.data ? { days: preview.data.days } : {}),
      },
      {
        onSuccess: (row) => {
          toast.success("Leave requested", {
            description: `${LEAVE_TYPE_LABELS[type]} · ${row.from} – ${row.to} · ${durationLabel(row.days)} — pending approval.`,
          });
          reset();
          onOpenChange(false);
        },
        onError: (err: unknown) =>
          setRefusal(apiErrorMessage(err, "Could not submit the leave request.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Apply for leave</DialogTitle>
          <DialogDescription>
            Request time off. Days are counted excluding your weekly-off and store
            holidays. Festival leave is unpaid.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="leave-type">Leave type</Label>
            <Select
              value={type}
              onValueChange={edited((v: string) => setType(v as LeaveType))}
            >
              <SelectTrigger id="leave-type">
                <SelectValue />
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
              <Label htmlFor="leave-from">From</Label>
              <Input
                id="leave-from"
                type="date"
                value={fromDate}
                onChange={(e) => edited(setFromDate)(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="leave-to">To</Label>
              <Input
                id="leave-to"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => edited(setToDate)(e.target.value)}
              />
            </div>
          </div>
          <button
            type="button"
            aria-pressed={effectiveHalfDay}
            disabled={!singleDate}
            onClick={() => edited(setHalfDay)(!halfDay)}
            className={cn(
              "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
              effectiveHalfDay
                ? "border-primary bg-primary/10"
                : "border-input hover:border-primary/40 hover:bg-accent",
              !singleDate &&
                "cursor-not-allowed opacity-60 hover:border-input hover:bg-transparent",
            )}
          >
            <span className="text-sm">
              <span className="font-medium">Half day</span>
              <span className="block text-xs text-muted-foreground">
                {singleDate
                  ? "Counts as 0.5 day against your balance."
                  : "Only for a single date — set From and To to the same day."}
              </span>
            </span>
            <span
              className={cn(
                "inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition-colors",
                effectiveHalfDay ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "h-4 w-4 rounded-full bg-background shadow transition-transform",
                  effectiveHalfDay ? "translate-x-4" : "translate-x-0",
                )}
              />
            </span>
          </button>

          {/* What the server will charge, before anybody commits to it. */}
          {rangeValid ? (
            preview.isLoading ? (
              <Skeleton className="h-20 rounded-lg" />
            ) : preview.isError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p>
                  {apiErrorMessage(preview.error, "Couldn't work out the chargeable days.")}
                </p>
                <button
                  type="button"
                  className="mt-1 text-xs underline"
                  onClick={() => preview.refetch()}
                >
                  Try again
                </button>
              </div>
            ) : preview.data ? (
              <ChargeablePanel preview={preview.data} />
            ) : null
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="leave-reason">Reason</Label>
            <Textarea
              id="leave-reason"
              placeholder="Optional — e.g. family function, medical."
              value={reason}
              onChange={(e) => edited(setReason)(e.target.value)}
            />
          </div>

          {refusal ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              {refusal}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={applyLeave.isPending || !rangeValid || blocked}>
            {applyLeave.isPending ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Sun 7 Sep" from a store-local YYYY-MM-DD, with no timezone re-reading. */
function shortDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * The server's own count, and the working it showed.
 *
 * The skipped dates are listed, not merely totalled: "4 days, not 6" is an
 * argument waiting to happen at the counter, while "Sun 7 Sep is your off and
 * Mon 8 Sep is Ganesh Chaturthi" is an explanation.
 */
function ChargeablePanel({ preview }: { preview: LeavePreview }) {
  const { days, offDates, holidays, balance } = preview;
  const note = skippedDaysNote({ offDates, holidays });
  const nothingToCharge = days <= 0;

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        nothingToCharge ? "border-destructive/40 bg-destructive/5" : "bg-muted/30",
      )}
    >
      <p className="num text-sm font-medium">
        {nothingToCharge
          ? "Nothing to charge — this range is weekly off and holidays only."
          : `${durationLabel(days)} will be charged`}
      </p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {offDates.length > 0 || holidays.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {offDates.map((date) => (
            <Badge key={`off-${date}`} variant="outline" className="num font-normal">
              {shortDay(date)} · off
            </Badge>
          ))}
          {holidays.map((holiday) => (
            <Badge key={`hol-${holiday.date}`} variant="gold" className="num font-normal">
              {shortDay(holiday.date)}
              {holiday.label ? ` · ${holiday.label}` : " · holiday"}
            </Badge>
          ))}
        </div>
      ) : null}

      {balance ? (
        !balance.paid ? (
          <p className="text-xs text-muted-foreground">
            {balance.label} leave is unpaid — no balance is charged.
          </p>
        ) : (
          <>
            <p className="num text-xs text-muted-foreground">
              {balance.label} · FY {balance.financialYearLabel}: {balance.available} available
              now
              {balance.pending > 0 ? ` (${balance.pending} already awaiting approval)` : ""} →{" "}
              <span className="font-medium text-foreground">
                {balance.availableAfter} after this request
              </span>
            </p>
            {!balance.sufficient ? (
              <p className="num text-xs font-medium text-destructive">
                Not enough {balance.label.toLowerCase()} leave: {balance.available} day(s)
                available, {days} requested.
              </p>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
