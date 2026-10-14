"use client";

import { Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { WEEK_DAYS_SHORT } from "@/lib/mock/hrms";
import { STATE_COLORS } from "@/components/hrms/today-tab";
import { DAY_STATE_LABELS, type DayState } from "@/lib/queries/hrms-ops";
import type { SelfAttendanceDay } from "@/lib/queries/hrms";
import { cn } from "@/lib/utils";

/**
 * A day's state as the calendar paints it. `late` is not a state of its own —
 * the day is present, and lateness rides along as a second chip, exactly as
 * `StateBadge` does on Today and the register.
 */
function dayState(record: SelfAttendanceDay | undefined): DayState | null {
  if (!record) return null;
  if (record.status === "late") return "present";
  return record.status as DayState;
}

const BADGE_VARIANT: Record<DayState, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
  present: "success",
  half_day: "warning",
  absent: "destructive",
  on_leave: "secondary",
  week_off: "outline",
  holiday: "outline",
  not_marked: "outline",
};

/** Days the store does not trade — recessed, the way a weekend is on a diary. */
const NON_WORKING: DayState[] = ["week_off", "holiday"];

/** Number of days in a YYYY-MM, counted in UTC so no DST can shorten a month. */
function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Which column the 1st sits in (0 = Sunday), again in UTC. */
function firstWeekday(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
}

/**
 * My attendance as a month grid: one status chip per day, with the punch times
 * underneath where there are any. The pencil raises a correction for that day —
 * it never writes the record, only a request someone above approves.
 *
 * Days the store is closed (week off, holiday) are shaded rather than the
 * Saturday/Sunday columns: a jewellery branch trades at the weekend, so
 * shading by calendar weekday would state something untrue about the roster.
 */
export function AttendanceCalendar({
  month,
  records,
  today,
  onRequestFix,
}: {
  /** YYYY-MM */
  month: string;
  records: SelfAttendanceDay[];
  /** Store-local today (YYYY-MM-DD) — ringed, and nothing after it is offered. */
  today: string;
  onRequestFix: (date: string) => void;
}) {
  const byDate = new Map(records.map((r) => [r.date, r]));
  const total = daysInMonth(month);
  const lead = firstWeekday(month);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
        {WEEK_DAYS_SHORT.map((d) => (
          <div
            key={d}
            className="px-1 pb-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:text-xs"
          >
            <span className="sm:hidden">{d.slice(0, 1)}</span>
            <span className="hidden sm:inline">{d}</span>
          </div>
        ))}

        {Array.from({ length: lead }).map((_, i) => (
          <div key={`lead-${i}`} aria-hidden />
        ))}

        {Array.from({ length: total }).map((_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const record = byDate.get(date);
          const future = date > today;
          /*
           * A past day with no row is "not marked", not a blank: absence only
           * becomes a record at day-close, and until then the gap is the thing
           * the staffer needs to see. A day still ahead is simply empty.
           */
          const state = dayState(record) ?? (future ? null : "not_marked");
          const label = state ? (DAY_STATE_LABELS[state] ?? state) : "No record";

          return (
            <div
              key={date}
              className={cn(
                "flex min-h-[64px] flex-col gap-1 rounded-lg border p-1.5 sm:min-h-[84px] sm:p-2",
                state && NON_WORKING.includes(state) && "bg-muted/40",
                date === today && "ring-1 ring-ring",
                future && "opacity-50",
              )}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="num text-xs font-medium sm:text-sm">{i + 1}</span>
                {/* A correction only makes sense for a day that has happened. */}
                {future ? null : (
                  <button
                    type="button"
                    className="-m-1 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Request a correction for ${date}`}
                    title="Request correction"
                    onClick={() => onRequestFix(date)}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>

              {state ? (
                <>
                  {/* Below sm there is no room for a word: a dot carries the
                      colour and the accessible name carries the meaning. */}
                  <span
                    className="h-1.5 w-1.5 rounded-full sm:hidden"
                    style={{ backgroundColor: STATE_COLORS[state] }}
                    role="img"
                    aria-label={label}
                  />
                  <Badge
                    variant={BADGE_VARIANT[state]}
                    className="hidden w-full justify-center px-1 text-[10px] sm:inline-flex"
                  >
                    {label}
                  </Badge>
                  {record?.isLate ? (
                    <span className="hidden text-[10px] text-warning sm:inline">
                      Late{record.lateMinutes ? ` ${record.lateMinutes}m` : ""}
                    </span>
                  ) : null}
                  {record?.checkInLocal ? (
                    <span className="num hidden text-[10px] leading-tight text-muted-foreground sm:inline">
                      {record.checkInLocal}
                      {record.checkOutLocal ? `–${record.checkOutLocal}` : "–"}
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* The legend doubles as the only place the chip colours are explained. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
        {(Object.keys(BADGE_VARIANT) as DayState[]).map((s) => (
          <span
            key={s}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: STATE_COLORS[s] }}
            />
            {DAY_STATE_LABELS[s]}
          </span>
        ))}
      </div>
    </div>
  );
}
