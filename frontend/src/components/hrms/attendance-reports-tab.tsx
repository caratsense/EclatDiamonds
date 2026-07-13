"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Clock,
  Gauge,
  MapPin,
  Search,
  Timer,
  Users,
  X,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { StatTiles } from "@/components/hrms/stat-tiles";
import type {
  AttendanceReportRow,
  AttendanceStatus,
  TeamPunch,
} from "@/lib/mock/hrms";
import {
  useAttendanceReport,
  useTeamAttendance,
} from "@/lib/queries/hrms";

/* ------------------------------------------------------------------ */
/* Date / duration helpers (parsed as local — no tz drift)             */
/* ------------------------------------------------------------------ */

/** YYYY-MM-DD for a Date. */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today, and today minus `days`, as YYYY-MM-DD. */
function defaultRange(days = 30): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from: ymd(from), to: ymd(to) };
}

/** HH:mm from an ISO instant, or an em-dash. */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Wed 8 Jul" from a YYYY-MM-DD (parsed as local — no tz drift). */
function formatDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Minutes → "6h 20m". Always shows hours + minutes for the summary tiles. */
function formatWorked(mins: number | null): string {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

/* ------------------------------------------------------------------ */
/* Shared cells                                                        */
/* ------------------------------------------------------------------ */

/** Status badge, with lateness measured against the staffer's own shift. */
function StatusBadge({
  status,
  isLate,
  lateMinutes,
}: {
  status: AttendanceStatus;
  isLate: boolean;
  lateMinutes: number | null;
}) {
  if (status === "on_leave") {
    return <Badge variant="secondary">On leave</Badge>;
  }
  if (status === "absent") {
    return <Badge variant="destructive">Absent</Badge>;
  }
  if (isLate || status === "late") {
    return (
      <Badge variant="warning" className="gap-1">
        <Clock className="h-3 w-3" />
        {lateMinutes ? `Late ${lateMinutes}m` : "Late"}
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" />
      On time
    </Badge>
  );
}

/**
 * The check-in location cell: a "View on map" link (opens Google Maps at the
 * captured coordinates) plus a within-range / distance chip. Renders "—" when
 * no coordinates were captured (no fix, or the store has no geofence).
 */
function LocationCell({
  lat,
  lng,
  withinFence,
  distanceM,
}: {
  lat: number | null;
  lng: number | null;
  withinFence: boolean;
  distanceM: number | null;
}) {
  if (lat == null || lng == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        target="_blank"
        rel="noopener noreferrer"
        href={`https://www.google.com/maps?q=${lat},${lng}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
      >
        <MapPin className="h-3 w-3" />
        View on map
      </a>
      {withinFence ? (
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Within range
        </Badge>
      ) : (
        <Badge variant="warning" className="gap-1">
          <AlertTriangle className="h-3 w-3" />
          {distanceM != null ? `${distanceM} m` : "Outside range"}
        </Badge>
      )}
    </div>
  );
}

/** The late column: minutes past shift start, or an em-dash when on time. */
function LateCell({
  isLate,
  lateMinutes,
}: {
  isLate: boolean;
  lateMinutes: number | null;
}) {
  if (!isLate) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="num text-warning">
      {lateMinutes ? `${lateMinutes}m` : "Late"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Reports tab                                                         */
/* ------------------------------------------------------------------ */

/** A staffer to run the My-Attendance report against (managers only). */
interface ReportTarget {
  staffId: string;
  staffName: string;
}

/**
 * Attendance reports (Module 6, EzAttendancePro-informed). Two sub-views:
 *  - "My attendance": any staffer's own date-range report (summary + daily log).
 *  - "Team (today)": store_manager+ only — everyone's punch for a chosen day,
 *    the anti-buddy-punching view. A manager can click a team row to open that
 *    person's full date-range report in the My-attendance view.
 */
export function AttendanceReportsTab() {
  const { role } = useSession();
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const [subView, setSubView] = useState<"mine" | "team">("mine");
  // Managers may pin the My-attendance report to a team member (null = self).
  const [target, setTarget] = useState<ReportTarget | null>(null);

  function viewStaff(punch: TeamPunch) {
    setTarget({ staffId: punch.staffId, staffName: punch.staffName });
    setSubView("mine");
  }

  return (
    <Tabs
      value={subView}
      onValueChange={(v) => setSubView(v as "mine" | "team")}
      className="space-y-4"
    >
      {isManager ? (
        <TabsList>
          <TabsTrigger value="mine">My attendance</TabsTrigger>
          <TabsTrigger value="team">Team (today)</TabsTrigger>
        </TabsList>
      ) : null}

      <TabsContent value="mine">
        <MyAttendanceReport
          target={target}
          onClearTarget={() => setTarget(null)}
        />
      </TabsContent>

      {isManager ? (
        <TabsContent value="team">
          <TeamAttendance onViewStaff={viewStaff} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

/* ------------------------------------------------------------------ */
/* My attendance — date-range report                                   */
/* ------------------------------------------------------------------ */

function MyAttendanceReport({
  target,
  onClearTarget,
}: {
  target: ReportTarget | null;
  onClearTarget: () => void;
}) {
  // Draft inputs vs. the applied range (only committed on Search).
  const [draft] = useState(defaultRange);
  const [from, setFrom] = useState(draft.from);
  const [to, setTo] = useState(draft.to);
  const [range, setRange] = useState<{ from: string; to: string }>(draft);

  const query = useAttendanceReport({
    from: range.from,
    to: range.to,
    staffId: target?.staffId,
  });
  const report = query.data;

  return (
    <div className="space-y-4">
      {target ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-accent/40 px-3 py-2 text-sm">
          <span>
            Viewing the report for{" "}
            <span className="font-medium">{target.staffName}</span>.
          </span>
          <Button variant="ghost" size="sm" onClick={onClearTarget}>
            <X className="h-4 w-4" />
            Back to my report
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            Attendance report
          </CardTitle>
          <CardDescription>
            Choose a date range to review attendance, worked hours and check-in
            locations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="report-from">From</Label>
              <Input
                id="report-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="w-auto"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="report-to">To</Label>
              <Input
                id="report-to"
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                className="w-auto"
              />
            </div>
            <Button
              onClick={() => setRange({ from, to })}
              disabled={!from || !to || query.isFetching}
            >
              <Search className="h-4 w-4" />
              {query.isFetching ? "Loading…" : "Search"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <ReportSkeleton />
      ) : query.isError ? (
        <ReportError onRetry={() => query.refetch()} />
      ) : report ? (
        <>
          <StatTiles
            tiles={[
              {
                label: "Present",
                value: String(report.summary.present),
                icon: CheckCircle2,
              },
              {
                label: "Late",
                value: String(report.summary.late),
                icon: Clock,
              },
              {
                label: "Absent",
                value: String(report.summary.absent),
                hint: `${report.summary.onLeave} on leave`,
                icon: AlertTriangle,
              },
              {
                label: "Worked (total)",
                value: formatWorked(report.summary.totalWorkedMins),
                icon: Timer,
              },
              {
                label: "Avg / day",
                value: formatWorked(report.summary.avgWorkedMins),
                icon: Gauge,
              },
            ]}
          />

          <Card>
            <CardHeader>
              <CardTitle>
                {formatDayLabel(report.from)} — {formatDayLabel(report.to)}
              </CardTitle>
              <CardDescription>
                Daily attendance, newest first. Lateness is measured against the
                assigned shift start + buffer.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>In</TableHead>
                    <TableHead>Out</TableHead>
                    <TableHead>Worked</TableHead>
                    <TableHead>Late</TableHead>
                    <TableHead>Location</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.records.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        No attendance recorded in this date range.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {report.records.map((r: AttendanceReportRow) => (
                    <TableRow key={r.date}>
                      <TableCell className="font-medium">
                        {formatDayLabel(r.date)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={r.status}
                          isLate={r.isLate}
                          lateMinutes={r.lateMinutes}
                        />
                      </TableCell>
                      <TableCell className="num">
                        {formatTime(r.checkInAt)}
                      </TableCell>
                      <TableCell className="num">
                        {formatTime(r.checkOutAt)}
                      </TableCell>
                      <TableCell className="num">
                        {formatWorked(r.workedMins)}
                      </TableCell>
                      <TableCell>
                        <LateCell isLate={r.isLate} lateMinutes={r.lateMinutes} />
                      </TableCell>
                      <TableCell>
                        <LocationCell
                          lat={r.checkInLat}
                          lng={r.checkInLng}
                          withinFence={r.withinFence}
                          distanceM={r.checkInDistanceM}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Team (today) — manager anti-buddy-punching view                     */
/* ------------------------------------------------------------------ */

function TeamAttendance({
  onViewStaff,
}: {
  onViewStaff: (punch: TeamPunch) => void;
}) {
  const [date, setDate] = useState(() => ymd(new Date()));
  const query = useTeamAttendance(date);
  const punches = query.data ?? [];

  const present = punches.filter((p) => p.status === "present").length;
  const late = punches.filter((p) => p.isLate || p.status === "late").length;
  const outside = punches.filter(
    (p) => p.checkInAt != null && !p.withinFence,
  ).length;

  return (
    <div className="space-y-4">
      <StatTiles
        tiles={[
          { label: "On floor", value: String(punches.length), icon: Users },
          {
            label: "Present",
            value: String(present),
            hint: `${late} late`,
            icon: CheckCircle2,
          },
          {
            label: "Outside range",
            value: String(outside),
            hint: "check-ins off-site",
            icon: AlertTriangle,
          },
        ]}
      />

      <Card>
        <CardHeader className="flex flex-row items-end justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              Team attendance
            </CardTitle>
            <CardDescription>
              Every staffer&apos;s punch for the day, with the check-in location
              verified against the store geofence.
            </CardDescription>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="team-date">Date</Label>
            <Input
              id="team-date"
              type="date"
              value={date}
              max={ymd(new Date())}
              onChange={(e) => setDate(e.target.value)}
              className="w-auto"
            />
          </div>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : query.isError ? (
            <ReportError onRetry={() => query.refetch()} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>In</TableHead>
                  <TableHead>Out</TableHead>
                  <TableHead>Worked</TableHead>
                  <TableHead>Late</TableHead>
                  <TableHead>Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {punches.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No punches recorded for {formatDayLabel(date)}.
                    </TableCell>
                  </TableRow>
                ) : null}
                {punches.map((p) => (
                  <TableRow
                    key={p.staffId}
                    onClick={() => onViewStaff(p)}
                    className={cn(
                      "cursor-pointer",
                      // Flag off-site check-ins for a quick manager scan.
                      p.checkInAt != null && !p.withinFence && "bg-warning/5",
                    )}
                    title={`View ${p.staffName}'s full report`}
                  >
                    <TableCell className="font-medium">{p.staffName}</TableCell>
                    <TableCell>
                      <StatusBadge
                        status={p.status}
                        isLate={p.isLate}
                        lateMinutes={p.lateMinutes}
                      />
                    </TableCell>
                    <TableCell className="num">
                      {formatTime(p.checkInAt)}
                    </TableCell>
                    <TableCell className="num">
                      {formatTime(p.checkOutAt)}
                    </TableCell>
                    <TableCell className="num">
                      {formatWorked(p.workedMins)}
                    </TableCell>
                    <TableCell>
                      <LateCell isLate={p.isLate} lateMinutes={p.lateMinutes} />
                    </TableCell>
                    <TableCell>
                      <LocationCell
                        lat={p.checkInLat}
                        lng={p.checkInLng}
                        withinFence={p.withinFence}
                        distanceM={p.checkInDistanceM}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading / error states                                              */
/* ------------------------------------------------------------------ */

function ReportSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function ReportError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
      <p className="text-sm font-medium">Couldn&apos;t load the report.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        The connection may have dropped. Check your network and try again.
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
