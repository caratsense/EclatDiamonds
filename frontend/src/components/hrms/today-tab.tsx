"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, RefreshCw, Search, Users } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

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
import { Input } from "@/components/ui/input";
import { PaginationBar } from "@/components/ui/pagination-bar";
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
          {/* Nine: "Due today" plus one per state, the same grid the loaded
              board settles into, so nothing shifts when the data lands. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-xl" />
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
  const first = data.stores[0]?.date;
  const dateLabel = first
    ? new Date(`${first}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : "";
  const dates = [...new Set(data.stores.map((s) => `${s.date} · ${s.timezone}`))];
  /*
   * One line, not two. This stated the time with its timezone, then the
   * business date with the SAME timezone directly beneath it — and where
   * branches disagreed it recited every branch, its date and its zone inline.
   * The split only matters when the dates actually differ, so that is the only
   * case that says anything; the detail moves to the tooltip.
   */
  const split = dates.length > 1;
  const detail = split
    ? data.stores.map((s) => `${s.storeName}: ${s.date} (${s.timezone})`).join(", ")
    : undefined;
  return (
    <div className="text-sm">
      <p className="font-medium" title={detail}>
        <span className="num">{at}</span>
        {dateLabel ? <span className="text-muted-foreground"> · {dateLabel}</span> : null}
        {split ? (
          <span className="text-muted-foreground">
            {" "}· {dates.length} business dates across branches
          </span>
        ) : null}
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
  // Each employee holds exactly one state, so the tiles must sum to the number
  // due. Warned rather than rendered: the customer cannot act on a broken
  // invariant, and the console is where whoever can will see it.
  useEffect(() => {
    if (sum !== data.denominator) {
      console.warn(
        `[attendance] day states sum to ${sum} but ${data.denominator} are due`,
        data.counts,
      );
    }
  }, [sum, data.denominator, data.counts]);
  /*
   * Eight tiles, always, each carrying its share of the people due — the
   * designer's comp (Figma 1395:2681) and the client's call over the audit's
   * suggestion to hide the empty ones. A state that reads 0 is information on
   * this board: "nobody is absent" is the thing a manager wants confirmed, and
   * a tile that comes and goes with the data moves every tile beside it.
   *
   * The figure is 24px rather than the comp's 34px, which is the size the
   * client settled on: the hero number on the page without reopening the
   * complaint that the product's numerals shout.
   */
  const share = (n: number) =>
    data.denominator > 0 ? `${Math.round((n / data.denominator) * 100)}%` : "—";
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <button
        type="button"
        onClick={() => onFilter(null)}
        data-active={filter === null ? "" : undefined}
        className="facet-top rounded-xl border bg-card p-4 text-left shadow-sm transition-shadow hover:shadow-md"
      >
        <p className="text-[13px] text-muted-foreground">Due today</p>
        <p className="num mt-1 text-[24px] font-semibold leading-none">{data.denominator}</p>
        <p className="mt-1.5 text-xs text-muted-foreground">Show everyone</p>
      </button>
      {DAY_STATES.map((s) => {
        const active = filter === s;
        const count = data.counts[s] ?? 0;
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
              className="flex-1 rounded-xl p-4 pb-1 text-left"
            >
              <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: STATE_COLORS[s] }}
                />
                {DAY_STATE_LABELS[s]}
              </span>
              <span className="num mt-1 block text-[24px] font-semibold leading-none">{count}</span>
              <span className="mt-1.5 block text-xs text-muted-foreground">{share(count)}</span>
            </button>
            {s === "present" ? (
              <button
                type="button"
                aria-pressed={filter === "late"}
                onClick={() => onFilter(filter === "late" ? null : "late")}
                className={cn(
                  "px-4 pb-3 text-left text-xs underline-offset-2 hover:underline",
                  filter === "late" ? "font-semibold text-warning" : "text-muted-foreground",
                )}
              >
                incl. <span className="num">{data.counts.late ?? 0}</span> late
              </button>
            ) : (
              <span className="pb-3" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StateDonut({ data }: { data: TodaySnapshot }) {
  const slices = DAY_STATES.map((s) => ({
    state: s,
    name: DAY_STATE_LABELS[s],
    value: data.counts[s] ?? 0,
  })).filter((d) => d.value > 0);
  const pct = (n: number) =>
    data.denominator > 0 ? `${Math.round((n / data.denominator) * 100)}%` : "—";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Today at a glance</CardTitle>
        <CardDescription>
          Share of the <span className="num">{data.denominator}</span> people due today.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/*
          Donut beside a readout, per the comp (Figma 1395:2681). The ring alone
          could be hovered for a number; the table states every one of them at
          once, which is what somebody scanning the board actually wants. Only
          states with somebody in them appear — a zero slice has no arc to
          label, so listing it would point at nothing.
        */}
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <div className="relative h-44 w-44 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="64%"
                  outerRadius="92%"
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
              <span className="num text-[24px] font-semibold leading-none">
                {data.denominator}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">Due today</span>
            </div>
          </div>
          <dl className="min-w-0 flex-1 space-y-1.5">
            {slices.map((d) => (
              <div key={d.state} className="flex items-center gap-2 text-[13px]">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: STATE_COLORS[d.state] }}
                />
                <dt className="min-w-0 flex-1 truncate text-muted-foreground">{d.name}</dt>
                <dd className="num font-semibold">{d.value}</dd>
                <dd className="num w-10 text-right text-muted-foreground">{pct(d.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}

function StoreBars({ data }: { data: TodaySnapshot }) {
  /*
   * One bar per branch: how many of its staff are due today, biggest first.
   *
   * This was a stacked recharts bar carrying all eight states at once, which
   * asked the reader to compare seven colours across five rows to answer the
   * question the card actually poses — which branch has the most people in.
   * The comp (Figma 1395:2681) draws a single track per branch, and the state
   * breakdown stays one card to the left where the donut already gives it.
   */
  const rows = useMemo(() => {
    const due = data.stores.map((st) => ({
      storeId: st.storeId,
      name: st.storeName,
      count: data.rows.filter((r) => r.storeId === st.storeId).length,
    }));
    return due.sort((a, b) => b.count - a.count);
  }, [data]);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">By store</CardTitle>
        <CardDescription>Each bar is one store&apos;s staff due today.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.storeId} className="flex items-center gap-3 text-[13px]">
              <span className="w-32 shrink-0 truncate text-right text-muted-foreground" title={r.name}>
                {r.name}
              </span>
              <span className="h-5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary/70"
                  style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }}
                />
              </span>
              <span className="num w-8 shrink-0 text-right font-semibold">{r.count}</span>
            </li>
          ))}
        </ul>
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
  // Search and paging, per the comp (Figma 1395:2681). Both are client-side:
  // the snapshot already holds every row due today, so asking the server again
  // to show somebody a different slice of what is on the page would be slower
  // and no more correct.
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const matched = rows
    .filter((r) =>
      filter === null ? true : filter === "late" ? r.state === "present" && r.isLate : r.state === filter,
    )
    .filter((r) => {
      const needle = q.trim().toLowerCase();
      if (!needle) return true;
      return [r.employeeCode, r.name, r.storeName, refName(r.department)]
        .some((v) => (v ?? "").toLowerCase().includes(needle));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // A narrowed filter or search can strip the page out from under the reader.
  const lastPage = Math.max(1, Math.ceil(matched.length / pageSize));
  const safePage = Math.min(page, lastPage);
  const shown = matched.slice((safePage - 1) * pageSize, safePage * pageSize);

  const title =
    filter === null ? "Everyone due today" : filter === "late" ? "Late today" : DAY_STATE_LABELS[filter];

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">
          {title} <span className="num text-muted-foreground">({matched.length})</span>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              aria-label="Search the people due today"
              placeholder="Search by code, name, store or department…"
              className="h-9 w-full pl-8 sm:w-[300px]"
            />
          </div>
          {filter !== null ? (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Show everyone
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {matched.length === 0 ? (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            {q.trim() ? `Nobody matches “${q.trim()}”.` : "Nobody in this group right now."}
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
        {matched.length > pageSize ? (
          <PaginationBar
            page={safePage}
            pageSize={pageSize}
            total={matched.length}
            onPageChange={setPage}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
            // Bounded by headcount, not by catalogue size: the shared default
            // starts at 50, which a branch roster never reaches.
            pageSizeOptions={[25, 50, 100]}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
