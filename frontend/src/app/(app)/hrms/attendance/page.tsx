"use client";

import { useMemo, useState } from "react";
import {
  CalendarOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plane,
  Timer,
  XCircle,
} from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GeoPunchCard } from "@/components/hrms/geo-punch-card";
import { RegisterTab } from "@/components/hrms/register-tab";
import { TodayTab } from "@/components/hrms/today-tab";
import { StatTiles } from "@/components/hrms/stat-tiles";
import {
  MyCorrectionRequests,
  TeamCorrectionRequests,
} from "@/components/hrms/regularization-tab";
import { RegularizeDialog } from "@/components/hrms/regularize-dialog";
import {
  formatDayLabel,
  formatWorkedMins,
} from "@/components/hrms/attendance-correction-policy";
import { useMyAttendance } from "@/lib/queries/hrms";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { AttendanceCalendar, AttendanceLegend } from "./attendance-calendar";
import { MyDayList } from "./my-day-list";

/** The month key the self-service queries are keyed on (YYYY-MM). */
function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Step a YYYY-MM by whole months, counted in UTC so no zone can skew it. */
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Which month is on screen. Shared by the calendar and the list, which read the
 * same month and so must offer the same way of changing it.
 */
function MonthControls({
  month,
  atCurrentMonth,
  onChange,
}: {
  month: string;
  atCurrentMonth: boolean;
  onChange: (month: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        aria-label="Previous month"
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[9rem] text-center text-sm font-medium">{monthLabel(month)}</span>
      <Button
        variant="outline"
        size="icon"
        aria-label="Next month"
        disabled={atCurrentMonth}
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      {atCurrentMonth ? (
        <Badge variant="outline">This month</Badge>
      ) : (
        <Button variant="outline" size="sm" onClick={() => onChange(thisMonth())}>
          This month
        </Button>
      )}
    </div>
  );
}

/**
 * Attendance (Module 6) — one screen for both audiences.
 *
 * The top toggle picks WHOSE attendance is on show, and the sub-tabs under it
 * are scoped to that choice. A manager is both: they keep a real personal view
 * (they punch, and they file corrections like anyone else) alongside the team's
 * register, rather than having their own record disappear behind their reports.
 *
 * Nothing here decides what a role may see — the API returns the caller's own
 * rows for a front-line staffer and the store's for a manager, and refuses a
 * decision on a request the caller filed or whose author outranks them. The
 * screen only mirrors those rules so no unusable control is offered.
 */
export default function AttendancePage() {
  const { role } = useSession();
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  // Head office does not punch, so it has no personal punch card — but it
  // still reads its own record, which is why the My Data tab stays.
  const isHeadOffice = role === "head_office";

  const [audience, setAudience] = useState(isHeadOffice ? "team" : "my");
  const [myTab, setMyTab] = useState("overview");
  const [month, setMonth] = useState(thisMonth);
  const [fixDate, setFixDate] = useState<string | null>(null);

  // Nobody's own month is fetched while they are reading the team's.
  const { data, isLoading, isError, refetch } = useMyAttendance(month, {
    enabled: audience === "my",
  });
  const records = data?.records ?? [];
  const summary = data?.summary;
  const today = data?.today ?? null;

  /**
   * Store-local today. Taken from the server's own row when there is one — a
   * device on another timezone would otherwise ring the wrong cell in the
   * calendar and offer a correction for a day the store has not reached.
   */
  const todayDate = today?.date ?? new Date().toLocaleDateString("en-CA");

  const atCurrentMonth = month === thisMonth();
  const showsMonth = myTab === "overview" || myTab === "list";

  const tiles = useMemo(() => {
    if (!summary) return [];
    return [
      {
        label: "Present",
        value: String(summary.present),
        hint: summary.late ? `${summary.late} late` : undefined,
        icon: CheckCircle2,
      },
      { label: "Half days", value: String(summary.halfDay ?? 0), icon: Timer },
      { label: "Absent", value: String(summary.absent), icon: XCircle },
      { label: "Approved leave", value: String(summary.onLeave), icon: Plane },
      {
        label: "Offs & holidays",
        value: String(summary.nonWorking ?? 0),
        icon: CalendarOff,
      },
      {
        label: "Worked",
        value: formatWorkedMins(summary.totalWorkedMins),
        hint: `${formatWorkedMins(summary.avgWorkedMins)} a day`,
        icon: Clock,
      },
    ];
  }, [summary]);

  return (
    <>
      <SectionHeader
        title="Attendance"
        primaryAction={audience === "my" ? "Request Correction" : undefined}
        onPrimaryAction={
          audience === "my" ? () => setFixDate(todayDate) : undefined
        }
      />

      {/*
       * Who this is about, beside the content rather than above it.
       *
       * This was a full-width tab bar of its own, stacked on top of a second
       * full-width tab bar — two rows of navigation before any attendance was
       * visible. It is one choice between two words, so it sits on the same
       * line as the tabs it scopes.
       */}
      <Tabs value={audience} onValueChange={setAudience} className="space-y-4">
        {isManager ? (
          <TabsList className="ml-auto w-fit">
            <TabsTrigger value="my">My data</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
          </TabsList>
        ) : null}

        <TabsContent value="my" className="space-y-4">
          <Tabs value={myTab} onValueChange={setMyTab} className="space-y-4">
            <TabsList className="flex h-auto flex-wrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="list">List</TabsTrigger>
              <TabsTrigger value="requests">My Correction Requests</TabsTrigger>
            </TabsList>

            {/* Today's punch state and the shift it is judged against. */}
            {myTab === "overview" && !isHeadOffice ? <GeoPunchCard /> : null}

            {showsMonth ? (
              <>
                {today?.shiftName ? (
                  <p className="text-sm text-muted-foreground">
                    Today, {formatDayLabel(todayDate)} — rostered on{" "}
                    <span className="font-medium text-foreground">
                      {today.shiftName}
                    </span>
                    {today.shiftStart && today.shiftEnd ? (
                      <span className="num">
                        {" "}
                        ({today.shiftStart}–{today.shiftEnd})
                      </span>
                    ) : null}
                    {today.shiftIsFlexible ? " · flexible" : ""}
                  </p>
                ) : null}

                {/* Summary — the existing monthly definitions, nothing new. */}
                {isLoading ? (
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-[88px] rounded-xl" />
                    ))}
                  </div>
                ) : summary ? (
                  <StatTiles tiles={tiles} />
                ) : null}

              </>
            ) : null}

            <TabsContent value="overview">
              <Card>
                <CardContent className="space-y-4 p-3 sm:p-4">
                  {/*
                    Month controls and colour key on one line above the grid,
                    per the comp (Figma 1382:2422) — both belong to the calendar
                    beneath them, so they sit inside its card rather than
                    floating above it as a page-level filter bar.
                  */}
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                    <MonthControls
                      month={month}
                      atCurrentMonth={atCurrentMonth}
                      onChange={setMonth}
                    />
                    <AttendanceLegend />
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-80 rounded-xl" />
                  ) : isError ? (
                    <LoadFailure onRetry={() => refetch()} />
                  ) : (
                    <AttendanceCalendar
                      month={month}
                      records={records}
                      today={todayDate}
                      onRequestFix={setFixDate}
                    />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="list">
              <Card>
                <CardContent className="space-y-3 p-3 sm:p-4">
                  {/* The list reads the same month the calendar does, so it
                      carries the same control. */}
                  <MonthControls
                    month={month}
                    atCurrentMonth={atCurrentMonth}
                    onChange={setMonth}
                  />
                  {isLoading ? (
                    <div className="space-y-2 p-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 rounded-md" />
                      ))}
                    </div>
                  ) : isError ? (
                    <div className="p-3">
                      <LoadFailure onRetry={() => refetch()} />
                    </div>
                  ) : records.length === 0 ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                      Nothing is recorded for {monthLabel(month)} yet.
                    </p>
                  ) : (
                    <MyDayList records={records} onRequestFix={setFixDate} />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="requests">
              <MyCorrectionRequests />
            </TabsContent>
          </Tabs>
        </TabsContent>

        {isManager ? (
          <TabsContent value="team" className="space-y-4">
            <Tabs defaultValue="today" className="space-y-4">
              <TabsList className="flex h-auto flex-wrap">
                <TabsTrigger value="today">Today</TabsTrigger>
                <TabsTrigger value="register">Register</TabsTrigger>
                <TabsTrigger value="requests">Correction Requests</TabsTrigger>
              </TabsList>

              <TabsContent value="today">
                {/* Read and correct, never mark: marking someone's attendance
                    for them is the HRMS overview page's primary action, and
                    having two front doors to the same write invites two
                    different answers to "who marked this?". */}
                <TodayTab canEdit={isManager} />
              </TabsContent>
              <TabsContent value="register">
                <RegisterTab canEdit={isManager} isHeadOffice={isHeadOffice} />
              </TabsContent>
              <TabsContent value="requests">
                <TeamCorrectionRequests />
              </TabsContent>
            </Tabs>
          </TabsContent>
        ) : null}
      </Tabs>

      {/* Keyed by the day so every entry point opens a fresh, prefilled form. */}
      <RegularizeDialog
        key={fixDate ?? "none"}
        open={fixDate !== null}
        defaultDate={fixDate ?? undefined}
        onOpenChange={(o) => {
          if (!o) setFixDate(null);
        }}
      />
    </>
  );
}

function LoadFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-center">
      <p className="text-sm font-medium">Couldn&apos;t load your attendance.</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
