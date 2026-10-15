"use client";

import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RosterDayContent, RosterLegend } from "@/components/hrms/roster-cell";
import { RosterDayDialog } from "@/components/hrms/roster-day-dialog";
import { DAY_NAMES } from "@/lib/queries/payroll";
import {
  addDaysYmd,
  dayLabel,
  monthLabel,
  mondayOf,
  shiftMonth,
  shortDate,
  todayYmd,
  useRoster,
  weekdayShort,
  weekDates,
  type RosterDay,
  type RosterEmployee,
} from "@/lib/queries/hrms-roster";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The manager's weekly planning grid: employees down, real DATES across.
 *
 * Dates, not weekday names. The client's requirement is a variable weekly off —
 * Monday off one week, Friday the next — which a column headed "Mon" cannot
 * say. The columns are the seven days of one week, Monday first, because that is
 * the week the server's dated roster governs (`weekKeyOf`): planning a day here
 * re-plans the week the manager is looking at and no other.
 *
 * Every cell is the server's answer (GET /hrms/roster) and every edit goes back
 * through the endpoints that already own it. The grid is a view onto the roster,
 * not a second copy of it.
 */
export function RosterGrid() {
  const currentStore = useSession((s) => s.currentStore);
  // The topbar is the store context (CLAUDE.md rule #2); the roster follows it
  // rather than adding a second branch picker that could disagree with it. On
  // the "All Stores" aggregate every branch in scope is rostered at once, with
  // the branch shown on each row.
  const isAggregate = currentStore.isAggregate;
  const storeId = isAggregate ? "all" : currentStore.id;
  // Dated offs are read AND written with this same value, so a plan is never
  // moved to another branch — the semantics Roster & Pay already uses.
  const scopeStoreId = isAggregate ? undefined : currentStore.id;

  const [anchor, setAnchor] = useState(() => mondayOf(todayYmd()));
  const dates = weekDates(anchor);
  const query = useRoster({ from: dates[0], to: dates[6], storeId });
  const [open, setOpen] = useState<{ employee: RosterEmployee; day: RosterDay } | null>(null);

  const today = todayYmd();
  const employees = query.data?.employees ?? [];
  const multiBranch = (query.data?.stores.length ?? 0) > 1;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="size-4" /> Week of {shortDate(dates[0])} &ndash;{" "}
            {shortDate(dates[6])}
          </CardTitle>
          <CardDescription>
            Who is on which shift, and who is off, day by day. Tap a cell to assign a shift or plan
            an off. An off planned for a week replaces that person&rsquo;s weekly pattern for that
            week only.
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous month"
              onClick={() => setAnchor(mondayOf(`${shiftMonth(anchor.slice(0, 7), -1)}-01`))}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-[8.5rem] text-center text-sm font-medium">
              {monthLabel(anchor.slice(0, 7))}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next month"
              onClick={() => setAnchor(mondayOf(`${shiftMonth(anchor.slice(0, 7), 1)}-01`))}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              aria-label="Previous week"
              onClick={() => setAnchor(addDaysYmd(dates[0], -7))}
            >
              <ChevronLeft className="size-4" /> Week
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Next week"
              onClick={() => setAnchor(addDaysYmd(dates[0], 7))}
            >
              Week <ChevronRight className="size-4" />
            </Button>
          </div>
          <Input
            type="date"
            className="w-40"
            aria-label="Jump to a week"
            value={anchor}
            onChange={(e) => e.target.value && setAnchor(mondayOf(e.target.value))}
          />
          <Button variant="ghost" size="sm" onClick={() => setAnchor(mondayOf(today))}>
            This week
          </Button>
        </div>

        <RosterLegend />
      </CardHeader>

      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : query.isError ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Couldn&apos;t load the roster.{" "}
            <button type="button" className="underline" onClick={() => query.refetch()}>
              Try again
            </button>
          </p>
        ) : employees.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nobody is on the roster for this week.
          </p>
        ) : (
          /* The grid scrolls sideways inside its own container on a narrow
             screen, with the name column pinned so a row stays identifiable. */
          <Table className="min-w-[56rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-20 min-w-[11rem] bg-muted">Employee</TableHead>
                {dates.map((d) => (
                  <TableHead
                    key={d}
                    className={cn("min-w-[9rem]", d === today && "text-foreground")}
                  >
                    <span className="block">{weekdayShort(d)}</span>
                    <span className="num block text-[11px] font-normal">
                      {shortDate(d)}
                      {d === today ? " · today" : ""}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((emp) => (
                <TableRow key={`${emp.userId}-${emp.storeId}`}>
                  <TableCell className="sticky left-0 z-10 bg-background align-top">
                    <div className="text-sm font-medium">{emp.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {[emp.employeeCode, multiBranch ? emp.storeName : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {emp.weekOffDays.length
                        ? `Pattern: ${emp.weekOffDays.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ")}${
                            emp.followsStore ? " (branch)" : ""
                          }`
                        : "No weekly pattern"}
                    </div>
                  </TableCell>
                  {emp.days.map((day) => (
                    <TableCell key={day.date} className="p-1 align-top">
                      <button
                        type="button"
                        className={cn(
                          "min-h-[3.75rem] w-full rounded-md border border-transparent p-2 text-left transition-colors",
                          day.employed
                            ? "hover:border-border hover:bg-muted/60"
                            : "cursor-not-allowed",
                          day.conflict && "border-amber-500/40 bg-amber-500/5",
                        )}
                        disabled={!day.employed}
                        aria-label={`${emp.name}, ${dayLabel(day.date)}`}
                        onClick={() => setOpen({ employee: emp, day })}
                      >
                        <RosterDayContent day={day} compact />
                      </button>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {open ? (
        <RosterDayDialog
          key={`${open.employee.userId}-${open.day.date}`}
          employee={open.employee}
          day={open.day}
          scopeStoreId={scopeStoreId}
          weekPlanned={open.employee.days.some(
            (d) => mondayOf(d.date) === mondayOf(open.day.date) && d.offSource === "dated",
          )}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </Card>
  );
}
