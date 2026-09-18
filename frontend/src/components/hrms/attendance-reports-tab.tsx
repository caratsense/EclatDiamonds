"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  Gauge,
  Loader2,
  MapPin,
  Search,
  Timer,
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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { apiErrorMessage, cn } from "@/lib/utils";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { StatTiles } from "@/components/hrms/stat-tiles";
import type { AttendanceReportRow, AttendanceStatus } from "@/lib/mock/hrms";
import { useAttendanceReport } from "@/lib/queries/hrms";
import { useDepartments, useEmployees } from "@/lib/queries/hrms-employees";
import {
  localYmd,
  monthRange,
  PERIOD_LABELS,
  presetRange,
  useAttendanceReportData,
  useDownloadReportCsv,
  useStoreFilter,
  type PeriodPreset,
  type ReportCell,
  type ReportKind,
  type ReportParams,
  type ReportResponse,
} from "@/lib/queries/hrms-analytics";

/* ------------------------------------------------------------------ */
/* Date / duration helpers (parsed as local — no tz drift)             */
/* ------------------------------------------------------------------ */

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
/* Shared filter controls (also used by the Analytics tab)             */
/* ------------------------------------------------------------------ */

/** Store picker; hidden when the user can only see one store. */
export function StoreFilterSelect({
  value,
  onChange,
  stores,
}: {
  value: string;
  onChange: (v: string) => void;
  stores: { id: string; name: string }[];
}) {
  if (stores.length < 2) return null;
  return (
    <div className="grid gap-1.5">
      <Label>Store</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full sm:w-48" aria-label="Store">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All my stores</SelectItem>
          {stores.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Department picker from GET /hrms/departments, narrowed to the chosen store. */
export function DepartmentFilterSelect({
  value,
  onChange,
  storeId,
}: {
  value: string;
  onChange: (v: string) => void;
  storeId: string;
}) {
  const { data = [] } = useDepartments();
  const options = data.filter(
    (d) => d.isActive && (storeId === "all" || !d.storeId || d.storeId === storeId),
  );
  return (
    <div className="grid gap-1.5">
      <Label>Department</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full sm:w-44" aria-label="Department">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All departments</SelectItem>
          {options.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface PeriodState {
  preset: PeriodPreset;
  from: string;
  to: string;
}

export function initialPeriod(): PeriodState {
  return { preset: "this_month", ...presetRange("this_month") };
}

/** Preset select + (for "custom") two native date inputs. */
export function PeriodFilter({
  value,
  onChange,
}: {
  value: PeriodState;
  onChange: (v: PeriodState) => void;
}) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label>Period</Label>
        <Select
          value={value.preset}
          onValueChange={(p) => {
            const preset = p as PeriodPreset;
            onChange(
              preset === "custom"
                ? { ...value, preset }
                : { preset, ...presetRange(preset) },
            );
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PERIOD_LABELS) as PeriodPreset[]).map((p) => (
              <SelectItem key={p} value={p}>
                {PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.preset === "custom" ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="period-from">From</Label>
            <Input
              id="period-from"
              type="date"
              value={value.from}
              max={value.to}
              onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })}
              className="w-full sm:w-auto"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="period-to">To</Label>
            <Input
              id="period-to"
              type="date"
              value={value.to}
              min={value.from}
              onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })}
              className="w-full sm:w-auto"
            />
          </div>
        </>
      ) : null}
    </>
  );
}

export function LoadError({
  onRetry,
  what = "the report",
  error,
}: {
  onRetry: () => void;
  what?: string;
  /** Shows the API's reason (e.g. "range too long") instead of the network hint. */
  error?: unknown;
}) {
  return (
    <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
      <p className="text-sm font-medium">Couldn&apos;t load {what}.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {apiErrorMessage(
          error,
          "The connection may have dropped. Check your network and try again.",
        )}
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reports tab                                                         */
/* ------------------------------------------------------------------ */

/**
 * Attendance reports (Module 6). Managers get the report centre (every report
 * family in docs/modules/06-attendance.md, table + CSV) and their own report;
 * staff get only their own date-range report. The old "Team (today)" view is
 * the Daily register / GPS report for one day, and a staffer's full report is
 * any report filtered to that employee.
 */
export function AttendanceReportsTab() {
  const { role } = useSession();
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const [subView, setSubView] = useState<"centre" | "mine">("centre");

  if (!isManager) return <MyAttendanceReport />;

  return (
    <Tabs
      value={subView}
      onValueChange={(v) => setSubView(v as "centre" | "mine")}
      className="space-y-4"
    >
      <TabsList>
        <TabsTrigger value="centre">Report centre</TabsTrigger>
        <TabsTrigger value="mine">My attendance</TabsTrigger>
      </TabsList>
      <TabsContent value="centre">
        <ReportCentre />
      </TabsContent>
      <TabsContent value="mine">
        <MyAttendanceReport />
      </TabsContent>
    </Tabs>
  );
}

/* ------------------------------------------------------------------ */
/* Report centre                                                       */
/* ------------------------------------------------------------------ */

type FilterKey =
  | "range" // from/to
  | "month" // one calendar month → from/to
  | "department"
  | "employee"
  | "minDays"
  | "birthMonth";

interface ReportDef {
  kind: ReportKind;
  label: string;
  hint: string;
  filters: FilterKey[];
}

const ATT: FilterKey[] = ["range", "department", "employee"];
const MONTHLY: FilterKey[] = ["month", "department", "employee"];

const REPORT_GROUPS: { group: string; reports: ReportDef[] }[] = [
  {
    group: "Attendance",
    reports: [
      { kind: "daily-register", label: "Daily register", hint: "Every employee, every day: state, in/out, late and worked hours.", filters: ATT },
      { kind: "muster", label: "Monthly muster", hint: "Employee × day grid of attendance codes for a month.", filters: MONTHLY },
      { kind: "monthly-summary", label: "Monthly summary", hint: "Per employee: present, late, half, absent, leave, week-offs, holidays, payable days, hours and overtime.", filters: MONTHLY },
      { kind: "in-out", label: "IN / OUT", hint: "Employee × day first IN and last OUT times for a month.", filters: MONTHLY },
      { kind: "late-early", label: "Late & early", hint: "Late arrivals and early departures against the assigned shift.", filters: ATT },
      { kind: "missed-punch", label: "Missed punch", hint: "Days with an IN but no OUT, or an OUT without an IN.", filters: ATT },
      { kind: "constant-absent", label: "Constant absent", hint: "Employees absent for a run of consecutive days.", filters: ["range", "department", "minDays"] },
    ],
  },
  {
    group: "Leave",
    reports: [
      { kind: "leave-balance", label: "Leave balance", hint: "Allocated, used and remaining leave per type.", filters: ["department", "employee"] },
      { kind: "leave-register", label: "Leave register", hint: "Every leave application in the period with its decision.", filters: ATT },
    ],
  },
  {
    group: "Punches & location",
    reports: [
      { kind: "punch-log", label: "Raw punch log", hint: "Every punch as recorded, including voided and manager-added ones.", filters: ["range", "employee"] },
      { kind: "gps", label: "GPS", hint: "Punch locations with distance from the store, fence result and accuracy.", filters: ["range", "employee"] },
    ],
  },
  {
    group: "People",
    reports: [
      { kind: "birthdays", label: "Birthdays", hint: "Employees with a birthday in the chosen month.", filters: ["birthMonth", "department"] },
      { kind: "hiring", label: "Hiring", hint: "Employees who joined in the period.", filters: ["range", "department"] },
      { kind: "separation", label: "Separation", hint: "Employees who left in the period, with the reason.", filters: ["range", "department"] },
      { kind: "employee-details", label: "Employee details", hint: "The employee master as a list.", filters: ["department"] },
    ],
  },
];

const REPORTS: ReportDef[] = REPORT_GROUPS.flatMap((g) => g.reports);

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleDateString("en-IN", { month: "long" }),
);

function ReportCentre() {
  const { storeId, setStoreId, stores } = useStoreFilter();
  const [kind, setKind] = useState<ReportKind>("daily-register");
  const [period, setPeriod] = useState<PeriodState>(initialPeriod);
  const [month, setMonth] = useState(() => localYmd(new Date()).slice(0, 7));
  const [departmentId, setDepartmentId] = useState("all");
  const [userId, setUserId] = useState("all");
  const [minDays, setMinDays] = useState(2);
  const [birthMonth, setBirthMonth] = useState(() => new Date().getMonth() + 1);

  const def = REPORTS.find((r) => r.kind === kind) ?? REPORTS[0];
  const has = (f: FilterKey) => def.filters.includes(f);

  // Only the filters this report uses reach the API (and the cache key).
  const params: ReportParams = {
    storeId,
    ...(has("range") ? { from: period.from, to: period.to } : {}),
    ...(has("month") ? monthRange(month) : {}),
    ...(has("department") && departmentId !== "all" ? { departmentId } : {}),
    ...(has("employee") && userId !== "all" ? { userId } : {}),
    ...(has("minDays") ? { minDays } : {}),
    ...(has("birthMonth") ? { month: birthMonth } : {}),
  };

  const query = useAttendanceReportData(kind, params);
  const download = useDownloadReportCsv();

  function downloadCsv() {
    download.mutate(
      { kind, params },
      {
        onSuccess: ({ filename }) => toast.success(`Downloaded ${filename}`),
        onError: (e) => toast.error(apiErrorMessage(e, "Couldn't download the CSV.")),
      },
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            Report centre
          </CardTitle>
          <CardDescription>{def.hint}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 items-end gap-3 sm:flex sm:flex-wrap">
            <div className="grid gap-1.5">
              <Label>Report</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as ReportKind)}>
                <SelectTrigger className="w-full sm:w-56" aria-label="Report">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_GROUPS.map((g) => (
                    <SelectGroup key={g.group}>
                      <SelectLabel>{g.group}</SelectLabel>
                      {g.reports.map((r) => (
                        <SelectItem key={r.kind} value={r.kind}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {has("range") ? <PeriodFilter value={period} onChange={setPeriod} /> : null}
            {has("month") ? (
              <div className="grid gap-1.5">
                <Label htmlFor="report-month">Month</Label>
                <Input
                  id="report-month"
                  type="month"
                  value={month}
                  onChange={(e) => e.target.value && setMonth(e.target.value)}
                  className="w-full sm:w-auto"
                />
              </div>
            ) : null}
            {has("birthMonth") ? (
              <div className="grid gap-1.5">
                <Label>Birthday month</Label>
                <Select
                  value={String(birthMonth)}
                  onValueChange={(v) => setBirthMonth(Number(v))}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Birthday month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((n, i) => (
                      <SelectItem key={n} value={String(i + 1)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <StoreFilterSelect value={storeId} onChange={setStoreId} stores={stores} />
            {has("department") ? (
              <DepartmentFilterSelect
                value={departmentId}
                onChange={setDepartmentId}
                storeId={storeId}
              />
            ) : null}
            {has("employee") ? (
              <EmployeeFilterSelect value={userId} onChange={setUserId} storeId={storeId} />
            ) : null}
            {has("minDays") ? (
              <div className="grid gap-1.5">
                <Label htmlFor="report-min-days">Min. consecutive days</Label>
                <Input
                  id="report-min-days"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={62}
                  value={minDays}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    if (n >= 1 && n <= 62) setMinDays(n);
                  }}
                  className="w-full sm:w-28"
                />
              </div>
            ) : null}

            <Button
              variant="outline"
              onClick={downloadCsv}
              disabled={download.isPending}
              className="sm:ml-auto"
            >
              {download.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Download CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <Skeleton className="h-80 rounded-xl" />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => query.refetch()} />
      ) : query.data ? (
        <ReportTable kind={kind} title={def.label} data={query.data} fetching={query.isFetching} />
      ) : null}
    </div>
  );
}

/** Employee picker (GET /hrms/employees), narrowed to the chosen store. */
function EmployeeFilterSelect({
  value,
  onChange,
  storeId,
}: {
  value: string;
  onChange: (v: string) => void;
  storeId: string;
}) {
  const { data = [] } = useEmployees(storeId === "all" ? {} : { storeId });
  return (
    <div className="grid gap-1.5">
      <Label>Employee</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full sm:w-48" aria-label="Employee">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Everyone</SelectItem>
          {data.map((e) => (
            <SelectItem key={e.userId} value={e.userId}>
              {e.name}
              {e.employeeCode ? ` (${e.employeeCode})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Report table — driven entirely by the response `columns`            */
/* ------------------------------------------------------------------ */

/** Muster state codes → cell tint + legend label. The letter carries the meaning; the tint only helps scanning. */
const MUSTER_CODES: Record<string, { label: string; className: string }> = {
  P: { label: "Present", className: "bg-success/15" },
  L: { label: "Late", className: "bg-warning/20" },
  HD: { label: "Half day", className: "bg-chart-1/15" },
  A: { label: "Absent", className: "bg-destructive/15" },
  LV: { label: "Leave", className: "bg-chart-2/15" },
  WO: { label: "Week off", className: "bg-muted text-muted-foreground" },
  H: { label: "Holiday", className: "bg-chart-6/15" },
  "-": { label: "Not marked / not employed", className: "text-muted-foreground" },
};

function formatCell(v: ReportCell | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return v;
}

function ReportTable({
  kind,
  title,
  data,
  fetching,
}: {
  kind: ReportKind;
  title: string;
  data: ReportResponse;
  fetching: boolean;
}) {
  const { columns, rows, totals } = data;
  // Muster / IN-OUT: the per-day columns (keyed YYYY-MM-DD) are a compact grid.
  const dayCol = (key: string) =>
    (kind === "muster" || kind === "in-out") && /^\d{4}-\d{2}-\d{2}$/.test(key);
  // Keep the person visible while scrolling sideways.
  const stickyKey = columns.some((c) => c.key === "name") ? "name" : columns[0]?.key;
  // A column is numeric (right-aligned, mono) when its first real value is a number.
  const numeric = new Set(
    columns
      .filter((c) => {
        const first = rows.find((r) => r[c.key] != null)?.[c.key];
        return typeof first === "number";
      })
      .map((c) => c.key),
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FileSpreadsheet}
        title={`Nothing to show in the ${title.toLowerCase()} report`}
        description="No rows match these filters. Try a wider period or another store."
      />
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {fetching ? "Refreshing… " : ""}
          <span className="num">{rows.length.toLocaleString("en-IN")}</span>{" "}
          {rows.length === 1 ? "row" : "rows"}
          {data.period ? ` · ${formatDayLabel(data.period.from)} – ${formatDayLabel(data.period.to)}` : ""}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {kind === "muster" ? (
          <ul className="flex flex-wrap gap-2 text-xs" aria-label="Muster legend">
            {Object.entries(MUSTER_CODES).map(([code, m]) => (
              <li key={code} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "inline-flex h-6 min-w-7 items-center justify-center rounded px-1 font-mono font-medium",
                    m.className,
                  )}
                >
                  {code}
                </span>
                <span className="text-muted-foreground">{m.label}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="max-h-[70vh] overflow-auto rounded-md border">
          <table className="w-full caption-bottom text-sm">
            <thead>
              <tr className="border-b">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-[2] whitespace-nowrap bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground",
                      numeric.has(c.key) && "text-right",
                      dayCol(c.key) && "px-1 text-center",
                      c.key === stickyKey && "left-0 z-[3]",
                    )}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b last:border-0 hover:bg-muted/30">
                  {columns.map((c) => {
                    const v = r[c.key];
                    const code =
                      kind === "muster" && dayCol(c.key) && typeof v === "string"
                        ? MUSTER_CODES[v]
                        : undefined;
                    return (
                      <td
                        key={c.key}
                        className={cn(
                          "whitespace-nowrap px-3 py-2",
                          numeric.has(c.key) && "num text-right",
                          c.key === stickyKey && "sticky left-0 z-[1] bg-card font-medium",
                          dayCol(c.key) && "px-1 py-1 text-center font-mono text-xs",
                        )}
                      >
                        {code ? (
                          <span
                            title={code.label}
                            className={cn(
                              "inline-flex h-6 min-w-7 items-center justify-center rounded px-1 font-medium",
                              code.className,
                            )}
                          >
                            {v as string}
                          </span>
                        ) : (
                          formatCell(v)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {totals ? (
              <tfoot>
                <tr className="border-t bg-muted/50 font-medium">
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={cn(
                        "sticky bottom-0 whitespace-nowrap bg-muted px-3 py-2",
                        numeric.has(c.key) && "num text-right",
                        c.key === stickyKey && "left-0 z-[3]",
                      )}
                    >
                      {totals[c.key] != null
                        ? formatCell(totals[c.key])
                        : i === 0
                          ? "Total"
                          : ""}
                    </td>
                  ))}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* My attendance — own date-range report (every role)                  */
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

function MyAttendanceReport() {
  // Draft inputs vs. the applied range (only committed on Search).
  const [draft] = useState(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    return { from: localYmd(from), to: localYmd(to) };
  });
  const [from, setFrom] = useState(draft.from);
  const [to, setTo] = useState(draft.to);
  const [range, setRange] = useState<{ from: string; to: string }>(draft);

  const query = useAttendanceReport({ from: range.from, to: range.to });
  const report = query.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            My attendance
          </CardTitle>
          <CardDescription>
            Choose a date range to review your attendance, worked hours and
            check-in locations.
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
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : query.isError ? (
        <LoadError onRetry={() => query.refetch()} />
      ) : report ? (
        <>
          <StatTiles
            tiles={[
              { label: "Present", value: String(report.summary.present), icon: CheckCircle2 },
              { label: "Late", value: String(report.summary.late), icon: Clock },
              {
                label: "Absent",
                value: String(report.summary.absent),
                hint: `${report.summary.onLeave} on leave`,
                icon: AlertTriangle,
              },
              { label: "Worked (total)", value: formatWorked(report.summary.totalWorkedMins), icon: Timer },
              { label: "Avg / day", value: formatWorked(report.summary.avgWorkedMins), icon: Gauge },
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
                      <TableCell className="font-medium">{formatDayLabel(r.date)}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} isLate={r.isLate} lateMinutes={r.lateMinutes} />
                      </TableCell>
                      <TableCell className="num">{formatTime(r.checkInAt)}</TableCell>
                      <TableCell className="num">{formatTime(r.checkOutAt)}</TableCell>
                      <TableCell className="num">{formatWorked(r.workedMins)}</TableCell>
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
