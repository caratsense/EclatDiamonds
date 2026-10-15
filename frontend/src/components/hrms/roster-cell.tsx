"use client";

import { AlertTriangle } from "lucide-react";

import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import { LEAVE_TYPE_LABELS } from "@/lib/mock/hrms";
import type { RosterDay, RosterShift } from "@/lib/queries/hrms-roster";

/**
 * One roster cell, drawn the same way in the manager's grid and in My Schedule.
 *
 * The three things a planner must be able to tell apart at a glance, because
 * they are three different conversations:
 *
 *  - an assigned OFF — the branch planned it, nobody is expected;
 *  - APPROVED leave — granted, and the person is away;
 *  - PENDING leave — a request nobody has decided. It is drawn dashed and says
 *    "pending", because a grid that showed it like approved leave would have
 *    managers rostering around time off that may never be granted.
 *
 * A store holiday sits above all of them: the branch is shut.
 */

/** "10:00–19:00", or what a shift with no fixed start actually promises. */
export function shiftTimes(shift: RosterShift): string {
  if (shift.isFlexible) return "Flexible";
  return `${shift.startTime}–${shift.endTime}`;
}

export const CONFLICT_TEXT =
  "Rostered onto a shift on a day their leave is approved. Move the shift, or give the day an off.";

/** The leave chip's wording and tone — pending is never mistaken for granted. */
function leaveChip(day: RosterDay): { label: string; tone: PillTone; dashed: boolean; title: string } {
  const leave = day.leave!;
  const type = LEAVE_TYPE_LABELS[leave.type] ?? leave.type;
  const half = leave.halfDay ? " · half day" : "";
  if (leave.status === "pending") {
    return {
      label: `${type} leave · pending`,
      tone: "wait",
      dashed: true,
      title: `${type} leave requested${half} — nobody has decided it yet, so they are still expected on the floor.`,
    };
  }
  return {
    label: leave.halfDay ? `${type} leave · half` : `${type} leave`,
    tone: "wait",
    dashed: false,
    title: `${type} leave approved${half}.`,
  };
}

export function RosterDayContent({ day, compact = false }: { day: RosterDay; compact?: boolean }) {
  if (!day.employed) {
    return (
      <span className="text-xs text-muted-foreground" title="Outside their employment with us.">
        —
      </span>
    );
  }

  const chips: React.ReactNode[] = [];
  if (day.isHoliday) {
    chips.push(
      <StatusPill
        key="holiday"
        tone="mute"
        title={day.holidayLabel ?? "A branch holiday — the store is shut."}
      >
        {day.holidayLabel ?? "Holiday"}
      </StatusPill>,
    );
  }
  if (day.isOff) {
    chips.push(
      <StatusPill
        key="off"
        tone="mute"
        title={
          day.offSource === "dated"
            ? "An off planned for this week. It overrides their weekly pattern."
            : "Their weekly off pattern. Plan an off elsewhere in the week to move it."
        }
      >
        {day.offSource === "dated" ? "Off" : "Weekly off"}
      </StatusPill>,
    );
  }
  if (day.leave) {
    const chip = leaveChip(day);
    chips.push(
      <StatusPill
        key="leave"
        tone={chip.tone}
        title={chip.title}
        className={chip.dashed ? "border-dashed" : undefined}
      >
        {chip.label}
      </StatusPill>,
    );
  }

  return (
    <div className={cn("flex flex-col items-start gap-1", compact && "gap-0.5")}>
      {chips.length ? <div className="flex flex-wrap items-center gap-1">{chips}</div> : null}
      {/* The shift still shows under an off or a holiday: it is what the
          register would time them against if they did come in. */}
      {day.shift ? (
        <div className="min-w-0">
          <div
            className={cn(
              "truncate text-xs font-medium",
              (day.isOff || day.isHoliday) && "text-muted-foreground",
            )}
          >
            {day.shift.name}
            {day.shift.isNightBatch ? " · night" : ""}
          </div>
          <div
            className="num text-[11px] text-muted-foreground"
            title={
              day.shiftSource === "assignment"
                ? "Assigned to them from a date."
                : "Nobody has assigned them a shift — this is the branch's default, which the register still times them against."
            }
          >
            {shiftTimes(day.shift)}
            {day.shiftSource === "store_default" ? " · default" : ""}
          </div>
        </div>
      ) : !chips.length ? (
        <span className="text-xs text-muted-foreground">No shift</span>
      ) : null}
      {day.conflict ? (
        <div
          className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400"
          title={CONFLICT_TEXT}
        >
          <AlertTriangle className="size-3" aria-hidden />
          Shift on approved leave
        </div>
      ) : null}
    </div>
  );
}

/** What the colours mean, said once per screen rather than guessed at. */
export function RosterLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <StatusPill tone="mute">Off</StatusPill> planned for the week
      </span>
      <span className="inline-flex items-center gap-1.5">
        <StatusPill tone="mute">Weekly off</StatusPill> from their pattern
      </span>
      <span className="inline-flex items-center gap-1.5">
        <StatusPill tone="wait">Leave</StatusPill> approved
      </span>
      <span className="inline-flex items-center gap-1.5">
        <StatusPill tone="wait" className="border-dashed">
          Leave · pending
        </StatusPill>{" "}
        not decided — still expected in
      </span>
      <span className="inline-flex items-center gap-1.5">
        <AlertTriangle className="size-3 text-amber-600 dark:text-amber-400" aria-hidden /> shift
        clashes with approved leave
      </span>
    </div>
  );
}
