"use client";

import { useMemo, useState } from "react";
import { Pencil, RefreshCw, Users } from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
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
import {
  AttendanceEditDialog,
  type EditableAttendance,
} from "@/components/hrms/attendance-edit-dialog";
import {
  DAY_STATE_LABELS,
  DAY_STATES,
  refName,
  useTodaySnapshot,
  type DayState,
  type TodayRow,
  type TodaySnapshot,
} from "@/lib/queries/hrms-ops";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** One colour per primary state — tiles double as the chart legend. */
export const STATE_COLORS: Record<DayState, string> = {
  present: "var(--success)",
  half_day: "var(--warning)",
  absent: "var(--destructive)",
  on_leave: "var(--chart-1)",
  week_off: "var(--chart-2)",
  holiday: "var(--chart-6)",
  not_marked: "var(--muted-foreground)",
};

const BADGE_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
  present: "success",
  late: "success",
  half_day: "warning",
  absent: "destructive",
  on_leave: "secondary",
  week_off: "outline",
  holiday: "outline",
  not_marked: "outline",
};

const STATE_LABEL: Record<string, string> = { ...DAY_STATE_LABELS, late: "Present" };

/** Status chip used by Today and the register. */
export function StateBadge({ state, isLate }: { state: string; isLate?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={BADGE_VARIANT[state] ?? "outline"}>{STATE_LABEL[state] ?? state}</Badge>
      {isLate || state === "late" ? <Badge variant="warning">Late</Badge> : null}
    </span>
  );
}

type Filter = DayState | "late" | null;

const ALL = "__all";

/**
 * Today — who is in, late, off or unaccounted for, right now. Every eligible
 * employee has exactly one primary state, so the tiles sum to the denominator;
 * `late` is a sub-count of present. Click a tile to filter the list below.
 */
export function TodayTab({
  canEdit,
  onMark,
}: {
  canEdit: boolean;
  /** Store managers mark someone who has no row yet (head office does not mark). */
  onMark?: (r: { userId: string; storeId: string }) => void;
}) {
  const { currentStore, stores, user } = useSession();
  const [storeFilter, setStoreFilter] = useState("");
  const query = useTodaySnapshot(storeFilter || undefined);
  const [filter, setFilter] = useState<Filter>(null);
  const [editing, setEditing] = useState<EditableAttendance | null>(null);

  const data = query.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {data ? <SnapshotMeta data={data} /> : <span />}
        <div className="flex items-center gap-2">
          {currentStore.isAggregate ? (
            <Select
              value={storeFilter || ALL}
              onValueChange={(v) => setStoreFilter(v === ALL ? "" : v)}
            >
              <SelectTrigger className="h-9 w-[200px]" aria-label="Store">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All stores</SelectItem>
                {stores
                  .filter((s) => !s.isAggregate)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : query.isError || !data ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load today&apos;s attendance.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : data.denominator === 0 ? (
        <EmptyState
          icon={Users}
          title="Nobody is due at work today"
          description="No active employees belong to this store, or everyone has joined after today or left before it."
        />
      ) : (
        <>
          <KpiTiles data={data} filter={filter} onFilter={setFilter} />
          <div className="grid gap-4 lg:grid-cols-2">
            <StateDonut data={data} />
            {data.stores.length > 1 ? <StoreBars data={data} /> : null}
          </div>
          <DrillDown
            rows={data.rows}
            filter={filter}
            onClear={() => setFilter(null)}
            multiStore={data.stores.length > 1}
            date={(storeId) => data.stores.find((s) => s.storeId === storeId)?.date}
            onEdit={canEdit ? setEditing : undefined}
            onMark={onMark}
            selfId={user.id}
          />
        </>
      )}

      <AttendanceEditDialog
        key={editing?.recordId ?? "none"}
        record={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function SnapshotMeta({ data }: { data: TodaySnapshot }) {
  const tz = data.stores[0]?.timezone;
  const at = new Date(data.snapshotAt).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  });
  const dates = [...new Set(data.stores.map((s) => `${s.date} · ${s.timezone}`))];
  return (
    <div className="text-sm">
      <p className="font-medium">
        Snapshot at <span className="num">{at}</span>
        {tz ? <span className="text-muted-foreground"> ({tz})</span> : null}
      </p>
      <p className="text-xs text-muted-foreground">
        Business date{" "}
        {dates.length === 1 ? (
          <span className="num">{dates[0]}</span>
        ) : (
          data.stores.map((s) => (
            <span key={s.storeId} className="mr-2 inline-block">
              {s.storeName}: <span className="num">{s.date}</span> ({s.timezone})
            </span>
          ))
        )}
      </p>
    </div>
  );
}

function KpiTiles({
  data,
  filter,
  onFilter,
}: {
  data: TodaySnapshot;
  filter: Filter;
  onFilter: (f: Filter) => void;
}) {
  const sum = DAY_STATES.reduce((n, s) => n + (data.counts[s] ?? 0), 0);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <button
          type="button"
          onClick={() => onFilter(null)}
          data-active={filter === null ? "" : undefined}
          className="facet-top rounded-xl border bg-card p-3 text-left shadow-sm transition-shadow hover:shadow-md"
        >
          <p className="text-xs text-muted-foreground">Due today</p>
          <p className="num text-2xl font-semibold">{data.denominator}</p>
          <p className="text-xs text-muted-foreground">Show everyone</p>
        </button>
        {DAY_STATES.map((s) => {
          const active = filter === s;
          return (
            <div
              key={s}
              className={cn(
                "flex flex-col rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md",
                active && "border-primary ring-2 ring-primary/30",
              )}
            >
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onFilter(active ? null : s)}
                className="flex-1 rounded-xl p-3 pb-1 text-left"
              >
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: STATE_COLORS[s] }}
                  />
                  {DAY_STATE_LABELS[s]}
                </span>
                <span className="num block text-2xl font-semibold">{data.counts[s] ?? 0}</span>
              </button>
              {s === "present" ? (
                <button
                  type="button"
                  aria-pressed={filter === "late"}
                  onClick={() => onFilter(filter === "late" ? null : "late")}
                  className={cn(
                    "px-3 pb-2 text-left text-xs underline-offset-2 hover:underline",
                    filter === "late" ? "font-semibold text-warning" : "text-muted-foreground",
                  )}
                >
                  incl. <span className="num">{data.counts.late ?? 0}</span> late
                </button>
              ) : (
                <span className="pb-2" />
              )}
            </div>
          );
        })}
      </div>
      <p className="num text-xs text-muted-foreground">
        {DAY_STATES.map((s) => data.counts[s] ?? 0).join(" + ")} = {sum}
        {sum !== data.denominator ? (
          <span className="ml-2 font-sans text-destructive">
            (does not match {data.denominator} due — report this)
          </span>
        ) : null}
      </p>
    </div>
  );
}

function StateDonut({ data }: { data: TodaySnapshot }) {
  const slices = DAY_STATES.map((s) => ({
    state: s,
    name: DAY_STATE_LABELS[s],
    value: data.counts[s] ?? 0,
  })).filter((d) => d.value > 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Today at a glance</CardTitle>
        <CardDescription>Share of the {data.denominator} people due today.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="relative h-56">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius="62%"
                outerRadius="90%"
                paddingAngle={1}
                stroke="var(--card)"
                isAnimationActive={false}
              >
                {slices.map((d) => (
                  <Cell key={d.state} fill={STATE_COLORS[d.state]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => [`${v} people`, ""]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="num text-2xl font-semibold">
              {data.denominator > 0
                ? Math.round(
                    ((data.counts.present + data.counts.half_day) / data.denominator) * 100,
                  )
                : 0}
              %
            </span>
            <span className="text-xs text-muted-foreground">at work</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StoreBars({ data }: { data: TodaySnapshot }) {
  const rows = useMemo(
    () =>
      data.stores.map((st) => {
        const row: Record<string, string | number> = { store: st.storeName };
        for (const s of DAY_STATES) row[s] = 0;
        for (const r of data.rows) {
          if (r.storeId === st.storeId) row[r.state] = (row[r.state] as number) + 1;
        }
        return row;
      }),
    [data],
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">By store</CardTitle>
        <CardDescription>Each bar is one store&apos;s staff due today.</CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ height: Math.max(160, rows.length * 44 + 40) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="store"
                width={120}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              {DAY_STATES.map((s) => (
                <Bar
                  key={s}
                  dataKey={s}
                  name={DAY_STATE_LABELS[s]}
                  stackId="a"
                  fill={STATE_COLORS[s]}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function DrillDown({
  rows,
  filter,
  onClear,
  multiStore,
  date,
  onEdit,
  onMark,
  selfId,
}: {
  rows: TodayRow[];
  filter: Filter;
  onClear: () => void;
  multiStore: boolean;
  date: (storeId: string) => string | undefined;
  onEdit?: (r: EditableAttendance) => void;
  onMark?: (r: { userId: string; storeId: string }) => void;
  /** Nobody corrects their own attendance (the API refuses it too). */
  selfId?: string;
}) {
  const shown = rows
    .filter((r) =>
      filter === null ? true : filter === "late" ? r.state === "present" && r.isLate : r.state === filter,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const title =
    filter === null ? "Everyone due today" : filter === "late" ? "Late today" : DAY_STATE_LABELS[filter];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-base">
          {title} <span className="num text-muted-foreground">({shown.length})</span>
        </CardTitle>
        {filter !== null ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Show everyone
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            Nobody in this group right now.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  {multiStore ? <TableHead>Store</TableHead> : null}
                  <TableHead>Department</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">In</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                  <TableHead className="text-right">Late (min)</TableHead>
                  {onEdit ? <TableHead className="sr-only">Actions</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={`${r.userId}-${r.storeId}`}>
                    <TableCell className="num text-xs">{r.employeeCode ?? "—"}</TableCell>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    {multiStore ? <TableCell className="text-sm">{r.storeName}</TableCell> : null}
                    <TableCell className="text-sm">{refName(r.department)}</TableCell>
                    <TableCell className="text-sm">{refName(r.shift)}</TableCell>
                    <TableCell>
                      <StateBadge state={r.state} isLate={r.isLate} />
                    </TableCell>
                    <TableCell className="num text-right">{r.checkIn ?? "—"}</TableCell>
                    <TableCell className="num text-right">{r.checkOut ?? "—"}</TableCell>
                    <TableCell className="num text-right">
                      {r.isLate && r.lateMinutes ? r.lateMinutes : "—"}
                    </TableCell>
                    {onEdit ? (
                      <TableCell className="text-right">
                        {r.userId === selfId ? null : r.recordId ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit attendance for ${r.name}`}
                            onClick={() =>
                              onEdit({
                                recordId: r.recordId!,
                                name: r.name,
                                storeId: r.storeId,
                                date: date(r.storeId),
                                status: r.state,
                                checkIn: r.checkIn,
                                checkOut: r.checkOut,
                                shiftId:
                                  r.shift && typeof r.shift === "object" ? r.shift.id : undefined,
                              })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                            Edit
                          </Button>
                        ) : onMark ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Mark attendance for ${r.name}`}
                            onClick={() => onMark({ userId: r.userId, storeId: r.storeId })}
                          >
                            <Pencil className="h-4 w-4" />
                            Mark
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
