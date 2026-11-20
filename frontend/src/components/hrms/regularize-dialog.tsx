"use client";

import { useMemo, useState } from "react";
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
import { useCreateRegularization, useMyAttendance } from "@/lib/queries/hrms";
import {
  attendanceStatusLabel,
  correctedCheckOutDate,
  correctionSides,
  formatDayLabel,
  formatWorkedMins,
} from "@/components/hrms/attendance-correction-policy";
import { apiErrorMessage } from "@/lib/utils";

/** Today on this device — used only to stop a correction dated in the future. */
function todayYmd(): string {
  return new Date().toLocaleDateString("en-CA");
}

/**
 * Regularization request dialog (Module 6). A staffer requests a fix for a
 * missed / wrong punch on a given day; someone one rank above them approves it
 * to rewrite the attendance record.
 *
 * The times go up as the STORE's wall clock (`checkInLocalDate` +
 * `checkInLocalTime`), never as an instant built here. An instant built in the
 * browser carries the browser's zone, so a phone set to — or simply carried
 * into — another timezone filed the correction against the wrong business day.
 * The server owns the store's timezone and does that conversion.
 */
export function RegularizeDialog({
  open,
  onOpenChange,
  defaultDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselects the day being corrected (YYYY-MM-DD) — key the dialog by it. */
  defaultDate?: string;
}) {
  const createReg = useCreateRegularization();
  const [date, setDate] = useState(defaultDate ?? "");
  const [reason, setReason] = useState("");

  /**
   * The day as it stands now. The form prefills from it so the staffer edits
   * the punch they actually have instead of retyping both ends of the day — and
   * the approver receives a request that differs only where it means to.
   */
  const monthQuery = useMyAttendance(date.slice(0, 7), {
    enabled: open && date.length === 10,
  });
  const record = useMemo(
    () => (monthQuery.data?.records ?? []).find((r) => r.date === date) ?? null,
    [monthQuery.data, date],
  );

  /**
   * The times: whatever has been typed for THIS day, or else the day's own
   * recorded punches.
   *
   * Derived rather than copied into state when the record lands. The record
   * arrives after the dialog is already open, so an effect that copied it in
   * would race whatever had been typed in the meantime — and changing the date
   * would need a second effect to clear the first one's work. Keying the draft
   * by date makes both problems disappear.
   */
  const [draft, setDraft] = useState<{
    date: string;
    checkIn: string;
    checkOut: string;
  } | null>(null);
  const typed = draft?.date === date ? draft : null;
  const checkIn = typed ? typed.checkIn : (record?.checkInLocal ?? "");
  const checkOut = typed ? typed.checkOut : (record?.checkOutLocal ?? "");

  function editTimes(next: { checkIn?: string; checkOut?: string }) {
    setDraft({ date, checkIn, checkOut, ...next });
  }

  // Which calendar date the corrected check-out belongs to (see the policy).
  const checkOutDate = correctedCheckOutDate({
    date,
    checkIn,
    checkOut,
    recordedCheckIn: record?.checkInLocal,
  });

  function reset() {
    setDate(defaultDate ?? "");
    setDraft(null);
    setReason("");
  }

  function submit() {
    if (!date) {
      toast.error("Pick the date you're correcting.");
      return;
    }
    // Only the side that actually differs is sent — see `correctionSides`.
    const sides = correctionSides({
      checkIn,
      checkOut,
      recordedCheckIn: record?.checkInLocal,
      recordedCheckOut: record?.checkOutLocal,
    });
    if (!sides.sendable) {
      toast.error(sides.message);
      return;
    }
    const { fixIn, fixOut } = sides;
    if (!reason.trim()) {
      toast.error("Add a reason — your approver decides on it.");
      return;
    }
    createReg.mutate(
      {
        date,
        ...(fixIn ? { checkInLocalDate: date, checkInLocalTime: checkIn } : {}),
        ...(fixOut
          ? { checkOutLocalDate: checkOutDate, checkOutLocalTime: checkOut }
          : {}),
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success("Attendance fix requested", {
            description: "Sent one level up for approval.",
          });
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not submit the request.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fix an attendance record</DialogTitle>
          <DialogDescription>
            Fix a missed or wrong punch. The record only changes once someone
            one rank above you approves it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="reg-date">Date</Label>
            <Input
              id="reg-date"
              type="date"
              value={date}
              max={todayYmd()}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          {/* What the day holds now — the figures this request departs from. */}
          {date.length === 10 ? (
            monthQuery.isPending ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : record ? (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Recorded now
                  </span>
                  <Badge variant="outline">
                    {attendanceStatusLabel(record.status)}
                  </Badge>
                  {record.autoClosed ? (
                    <Badge variant="warning">Auto-closed</Badge>
                  ) : null}
                </div>
                <div className="num flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span>In {record.checkInLocal || "—"}</span>
                  <span>Out {record.checkOutLocal || "—"}</span>
                  <span>Worked {formatWorkedMins(record.workedMins)}</span>
                </div>
                {record.shiftName ? (
                  <p className="text-xs text-muted-foreground">
                    Shift {record.shiftName}
                    {record.shiftStart && record.shiftEnd
                      ? ` · ${record.shiftStart}–${record.shiftEnd}`
                      : ""}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                Nothing is recorded for {formatDayLabel(date)} yet.
              </p>
            )
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="reg-in">Check-in time</Label>
              <Input
                id="reg-in"
                type="time"
                value={checkIn}
                onChange={(e) => editTimes({ checkIn: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reg-out">Check-out time</Label>
              <Input
                id="reg-out"
                type="time"
                value={checkOut}
                onChange={(e) => editTimes({ checkOut: e.target.value })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {checkOut && checkOutDate !== date
              ? `Times are your store's clock. The check-out reads as ${formatDayLabel(
                  checkOutDate,
                )} — a night shift closing the day it opened.`
              : "Times are your store's clock, not your phone's."}
          </p>

          <div className="grid gap-1.5">
            <Label htmlFor="reg-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="reg-reason"
              placeholder="e.g. phone battery died, forgot to punch out."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createReg.isPending}>
            {createReg.isPending ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
