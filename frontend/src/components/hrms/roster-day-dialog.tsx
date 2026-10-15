"use client";

import { useState } from "react";
import { AlertTriangle, CalendarOff, Clock } from "lucide-react";
import { toast } from "sonner";

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
import { Separator } from "@/components/ui/separator";
import { CONFLICT_TEXT, RosterDayContent } from "@/components/hrms/roster-cell";
import { useShifts } from "@/lib/queries/hrms";
import {
  useCreateShiftAssignment,
  useDeleteShiftAssignment,
  useShiftAssignments,
  useUpdateShiftAssignment,
} from "@/lib/queries/hrms-ops";
import { useDayOffRoster, useSetDayOffs } from "@/lib/queries/payroll";
import {
  addDaysYmd,
  dayLabel,
  useInvalidateRoster,
  type RosterDay,
  type RosterEmployee,
} from "@/lib/queries/hrms-roster";
import { apiErrorMessage } from "@/lib/utils";

/**
 * One cell, opened for planning.
 *
 * Every write here goes to an endpoint that already existed — shift assignments
 * (`/hrms/shift-assignments`) and the dated roster (`/hrms/payroll/day-offs`).
 * Nothing roster-specific is written, so the grid cannot drift from what the
 * attendance register and payroll read.
 *
 * Two server rules the copy has to be honest about, because the refusal arrives
 * either way and a manager should not have to discover them from a toast:
 *
 *  - a shift assignment is EFFECTIVE-DATED, not a single day. Assigning from
 *    this date closes the open one the day before and runs until changed. There
 *    is no one-day shift swap in this phase.
 *  - a dated off governs the WHOLE WEEK it falls in: once any day of the week is
 *    planned, that person's weekly pattern is silent for that week.
 *
 * Refusals (payroll lock, the rank rule, an overlapping assignment) are shown
 * exactly as the server words them — `apiErrorMessage` returns the server's own
 * message, and a paraphrase would hide which rule stopped the write.
 */
export function RosterDayDialog({
  employee,
  day,
  scopeStoreId,
  weekPlanned,
  onClose,
}: {
  employee: RosterEmployee;
  day: RosterDay;
  /**
   * The store the dated-off endpoints are called with — the SAME value for the
   * read and the write, so a plan is never re-homed to another branch. Mirrors
   * Roster & Pay: a concrete branch, or undefined for "every branch".
   */
  scopeStoreId?: string;
  /** Does this person already have a dated off somewhere in this week? */
  weekPlanned: boolean;
  onClose: () => void;
}) {
  const month = day.date.slice(0, 7);
  const invalidateRoster = useInvalidateRoster();

  const { data: allShifts = [], isLoading: shiftsLoading } = useShifts();
  const shifts = allShifts.filter((s) => s.storeId === employee.storeId);
  const assignments = useShiftAssignments({
    userId: employee.userId,
    storeId: employee.storeId,
  });
  const dayOffs = useDayOffRoster(month, scopeStoreId);

  const create = useCreateShiftAssignment();
  const update = useUpdateShiftAssignment();
  const remove = useDeleteShiftAssignment();
  const setDayOffs = useSetDayOffs();

  const [shiftId, setShiftId] = useState(day.shiftSource === "assignment" ? (day.shift?.id ?? "") : "");
  const [effectiveFrom, setEffectiveFrom] = useState(day.date);

  const ymd = (v: string | null) => (v ? v.slice(0, 10) : "");
  // The assignment actually in force on this date, which is the one an "end it"
  // action has to act on. Resolved the same way the server resolves the cell.
  const covering = (assignments.data ?? []).find(
    (a) => ymd(a.effectiveFrom) <= day.date && (!a.effectiveTo || ymd(a.effectiveTo) >= day.date),
  );
  const offDates = dayOffs.data?.staff.find((s) => s.userId === employee.userId)?.offDates;
  const busy = create.isPending || update.isPending || remove.isPending || setDayOffs.isPending;

  const fail = (fallback: string) => (err: unknown) =>
    toast.error(apiErrorMessage(err, fallback));

  function assign() {
    if (!shiftId) {
      toast.error("Choose a shift first.");
      return;
    }
    create.mutate(
      { userId: employee.userId, shiftId, effectiveFrom },
      {
        onSuccess: () => {
          toast.success(`${employee.name} assigned from ${effectiveFrom}`);
          onClose();
        },
        onError: fail("Could not assign the shift."),
      },
    );
  }

  /**
   * Stop the assignment from this date. An assignment that STARTS today has no
   * day left to end on (`effectiveTo` would precede `effectiveFrom`, which the
   * server refuses), so that one is removed instead.
   */
  function stopAssignment() {
    if (!covering) return;
    const startsToday = ymd(covering.effectiveFrom) >= day.date;
    const done = () => {
      toast.success(
        startsToday
          ? "Assignment removed — the branch's default shift applies again."
          : `Assignment ended on ${addDaysYmd(day.date, -1)}.`,
      );
      onClose();
    };
    if (startsToday) {
      remove.mutate(covering.id, { onSuccess: done, onError: fail("Could not remove the assignment.") });
      return;
    }
    update.mutate(
      { id: covering.id, effectiveTo: addDaysYmd(day.date, -1) },
      { onSuccess: done, onError: fail("Could not end the assignment.") },
    );
  }

  /**
   * Set or clear the dated off for this date.
   *
   * The write replaces the person's whole month, so it carries their other
   * planned dates along unchanged — which is why it waits for `offDates` rather
   * than sending one date and wiping the rest of the month.
   */
  function planOff(off: boolean) {
    if (!offDates) return;
    const dates = off
      ? [...new Set([...offDates, day.date])].sort()
      : offDates.filter((d) => d !== day.date);
    setDayOffs.mutate(
      { storeId: scopeStoreId, month, entries: [{ userId: employee.userId, dates }] },
      {
        onSuccess: () => {
          invalidateRoster();
          toast.success(off ? `${dayLabel(day.date)} is an off` : `${dayLabel(day.date)} is a working day`);
          onClose();
        },
        onError: fail("Could not change that week's off."),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{employee.name}</DialogTitle>
          <DialogDescription>
            {dayLabel(day.date)} · {employee.storeName}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border p-3">
          <RosterDayContent day={day} />
        </div>

        {day.conflict ? (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            {CONFLICT_TEXT}
          </p>
        ) : null}

        {/* --- Shift ------------------------------------------------- */}
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Clock className="size-4 text-muted-foreground" /> Shift
          </h3>
          {shiftsLoading ? (
            <p className="text-xs text-muted-foreground">Loading the branch&rsquo;s shifts&hellip;</p>
          ) : shifts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              This branch has no shifts yet. Add one under Shifts &amp; Schedule, then roster people
              onto it.
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <div className="grid gap-1.5">
                  <Label htmlFor="rd-shift">Assign</Label>
                  <Select value={shiftId} onValueChange={setShiftId}>
                    <SelectTrigger id="rd-shift">
                      <SelectValue placeholder="Choose a shift" />
                    </SelectTrigger>
                    <SelectContent>
                      {shifts.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.code ? `${s.code} · ` : ""}
                          {s.name} · {s.isFlexible ? "Flexible" : `${s.startTime}–${s.endTime}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="rd-from">From</Label>
                  <Input
                    id="rd-from"
                    type="date"
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                An assignment runs from a date until it is changed &mdash; it is not one day. Saving
                this ends their current one the day before.
              </p>
              <Button variant="outline" size="sm" onClick={assign} disabled={busy}>
                {create.isPending ? "Assigning…" : "Assign from this date"}
              </Button>
            </>
          )}

          {covering ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={stopAssignment}
              disabled={busy}
            >
              Stop the assignment from this date
            </Button>
          ) : day.shiftSource === "store_default" ? (
            <p className="text-xs text-muted-foreground">
              Nobody has assigned them a shift; the branch&rsquo;s default applies and the register
              still times them against it.
            </p>
          ) : null}
        </div>

        <Separator />

        {/* --- Off --------------------------------------------------- */}
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <CalendarOff className="size-4 text-muted-foreground" /> Weekly off
          </h3>
          {day.isOff && day.offSource === "pattern" ? (
            <p className="text-xs text-muted-foreground">
              This is their weekly off pattern, not a planned date. Give them an off on another day
              of this week and this one becomes a working day &mdash; that is how the off moves.
            </p>
          ) : null}
          {day.isOff && day.offSource === "dated" ? (
            <Button variant="outline" size="sm" onClick={() => planOff(false)} disabled={busy || !offDates}>
              {setDayOffs.isPending ? "Saving…" : "Make it a working day"}
            </Button>
          ) : null}
          {!day.isOff ? (
            <>
              <Button variant="outline" size="sm" onClick={() => planOff(true)} disabled={busy || !offDates}>
                {setDayOffs.isPending ? "Saving…" : "Make it an off"}
              </Button>
              {weekPlanned ? null : (
                <p className="text-xs text-muted-foreground">
                  This plans the week: their weekly pattern stops applying to it, so any pattern off
                  in this week becomes a working day.
                </p>
              )}
            </>
          ) : null}
          {dayOffs.isError ? (
            <p className="text-xs text-destructive">
              Couldn&apos;t read this month&rsquo;s planned offs, so changing one would wipe the
              others. Reload and try again.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
