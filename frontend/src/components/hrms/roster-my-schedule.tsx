"use client";

import { useState } from "react";
import { CalendarCheck, CalendarOff } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { STAT_LABEL, STAT_VALUE_SM } from "@/components/ui/stat";
import { RosterDayContent, RosterLegend, shiftTimes } from "@/components/hrms/roster-cell";
import { DAY_NAMES } from "@/lib/queries/payroll";
import {
  addDaysYmd,
  dayLabel,
  todayYmd,
  useMySchedule,
  type RosterEmployee,
} from "@/lib/queries/hrms-roster";
import { cn } from "@/lib/utils";

/** Four weeks ahead: enough to plan around, inside the endpoint's 31-day cap. */
const WINDOW_DAYS = 28;

/**
 * My Schedule — the employee's own four weeks, read-only.
 *
 * This exists because an employee could not see their own off anywhere. The
 * roster is planned by managers, so every week-off and dated-off endpoint is
 * manager-and-above; the person whose Tuesday it is had no screen for it.
 * `GET /hrms/schedule/me` is the self variant and returns nobody else's row.
 *
 * Read-only on purpose: an employee-initiated shift change is not part of this
 * phase, and a control that looked editable and then 403'd would be worse than
 * none.
 */
export function RosterMySchedule() {
  const from = todayYmd();
  const query = useMySchedule({ from, to: addDaysYmd(from, WINDOW_DAYS - 1) });
  const [tab, setTab] = useState("upcoming");

  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Couldn&apos;t load your schedule.{" "}
          <button type="button" className="underline" onClick={() => query.refetch()}>
            Try again
          </button>
        </CardContent>
      </Card>
    );
  }

  const rows = query.data?.employees ?? [];
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          You are not on a branch roster, so there is nothing scheduled for you.
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList className="flex h-auto flex-wrap">
        <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
        <TabsTrigger value="offs">My Offs</TabsTrigger>
      </TabsList>

      <TabsContent value="upcoming" className="space-y-4">
        {rows.map((emp) => (
          <UpcomingCard key={`${emp.userId}-${emp.storeId}`} emp={emp} showBranch={rows.length > 1} />
        ))}
      </TabsContent>

      <TabsContent value="offs" className="space-y-4">
        {rows.map((emp) => (
          <OffsCard key={`${emp.userId}-${emp.storeId}`} emp={emp} showBranch={rows.length > 1} />
        ))}
      </TabsContent>
    </Tabs>
  );
}

function UpcomingCard({ emp, showBranch }: { emp: RosterEmployee; showBranch: boolean }) {
  const today = todayYmd();
  const working = emp.days.filter((d) => d.employed && !d.isOff && !d.isHoliday);
  const next = working.find((d) => d.shift);
  const offs = emp.days.filter((d) => d.employed && d.isOff).length;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarCheck className="size-4" /> The next four weeks
            {showBranch ? <span className="text-sm font-normal text-muted-foreground">· {emp.storeName}</span> : null}
          </CardTitle>
          <CardDescription>
            Your shifts, your offs and your branch&rsquo;s holidays. Your manager plans these &mdash;
            ask them for a change.
          </CardDescription>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <div className={STAT_LABEL}>Next shift</div>
            <div className="text-sm font-semibold">
              {next?.shift ? `${dayLabel(next.date)} · ${shiftTimes(next.shift)}` : "None scheduled"}
            </div>
          </div>
          <div>
            <div className={STAT_LABEL}>Offs ahead</div>
            <div className={STAT_VALUE_SM}>{offs}</div>
          </div>
          <div>
            <div className={STAT_LABEL}>Days you work</div>
            <div className={STAT_VALUE_SM}>{working.length}</div>
          </div>
        </div>
        <RosterLegend />
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {emp.days.map((day) => (
            <li
              key={day.date}
              className={cn(
                "flex items-start justify-between gap-3 py-2",
                day.date === today && "rounded-md bg-muted/40 px-2",
              )}
            >
              <div className="num w-24 shrink-0 text-xs text-muted-foreground">
                {dayLabel(day.date)}
                {day.date === today ? (
                  <span className="block text-[11px] font-medium text-foreground">Today</span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <RosterDayContent day={day} />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function OffsCard({ emp, showBranch }: { emp: RosterEmployee; showBranch: boolean }) {
  const offs = emp.days.filter((d) => d.employed && d.isOff);

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarOff className="size-4" /> Your offs
          {showBranch ? <span className="text-sm font-normal text-muted-foreground">· {emp.storeName}</span> : null}
        </CardTitle>
        <CardDescription>
          {emp.weekOffDays.length
            ? `Usually ${emp.weekOffDays.map((d) => DAY_NAMES[d]).join(" and ")}${
                emp.followsStore ? " — your branch's day" : ""
              }. A week your manager plans by date overrides that for that week.`
            : "You have no weekly off pattern — your offs are planned week by week."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {offs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No off in the next four weeks.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {offs.map((day) => (
              <li key={day.date} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <span className="num text-sm font-medium">{dayLabel(day.date)}</span>
                <span className="text-xs text-muted-foreground">
                  {day.offSource === "dated" ? "Planned for that week" : "Your weekly off"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
