"use client";

import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import {
  AlertTriangle,
  CalendarX2,
  Clock,
  Fingerprint,
  Gauge,
  Palmtree,
  SplitSquareHorizontal,
  Timer,
  UserPlus,
  Users,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartEmpty, EChart, useChartTokens } from "@/components/chart/echart";
import { StatTiles } from "@/components/hrms/stat-tiles";
import {
  DepartmentFilterSelect,
  initialPeriod,
  LoadError,
  PeriodFilter,
  StoreFilterSelect,
  type PeriodState,
} from "@/components/hrms/attendance-reports-tab";
import {
  useAttendanceOverview,
  useStoreFilter,
  type AnalyticsOverview,
  type BreakdownRow,
  type TrendPoint,
} from "@/lib/queries/hrms-analytics";

const n = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 1 });
const pct = (v: number) => `${v.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;

/**
 * Attendance analytics (Module 6) — store_manager+. Period / store / department
 * filters, KPI tiles, daily state trend, by-store and by-department rates and
 * the late / absent leaderboards. All numbers come from GET /hrms/analytics/overview.
 */
export function AnalyticsTab() {
  const { storeId, setStoreId, stores } = useStoreFilter();
  const [period, setPeriod] = useState<PeriodState>(initialPeriod);
  const [departmentId, setDepartmentId] = useState("all");

  const query = useAttendanceOverview({
    from: period.from,
    to: period.to,
    storeId,
    departmentId: departmentId === "all" ? undefined : departmentId,
  });
  const data = query.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-end gap-3 sm:flex sm:flex-wrap">
        <PeriodFilter value={period} onChange={setPeriod} />
        <StoreFilterSelect value={storeId} onChange={setStoreId} stores={stores} />
        <DepartmentFilterSelect value={departmentId} onChange={setDepartmentId} storeId={storeId} />
        {query.isFetching && data ? (
          <span className="text-xs text-muted-foreground sm:ml-auto" aria-live="polite">
            Refreshing…
          </span>
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-xl" />
        </div>
      ) : query.isError ? (
        <LoadError what="attendance analytics" error={query.error} onRetry={() => query.refetch()} />
      ) : data ? (
        <Overview data={data} showStores={storeId === "all" && data.byStore.length > 1} />
      ) : null}
    </div>
  );
}

function Overview({ data, showStores }: { data: AnalyticsOverview; showStores: boolean }) {
  const k = data.kpis;
  return (
    <>
      <StatTiles
        tiles={[
          { label: "Attendance rate", value: pct(k.attendanceRate), hint: `${n(k.presentDays)} present days`, icon: Gauge },
          { label: "Headcount", value: n(data.headcount), icon: Users },
          {
            label: "Late arrivals",
            value: n(k.lateCount),
            hint: k.lateCount ? `avg ${n(k.avgLateMinutes)} min late` : undefined,
            icon: Clock,
          },
          { label: "Absent days", value: n(k.absentDays), icon: CalendarX2 },
          { label: "Leave days", value: n(k.leaveDays), icon: Palmtree },
          { label: "Half days", value: n(k.halfDays), icon: SplitSquareHorizontal },
          { label: "Overtime", value: `${n(k.overtimeHours)} h`, icon: Timer },
          { label: "Missed punches", value: n(k.missedPunches), icon: Fingerprint },
          {
            label: "Joiners / exits",
            value: `${n(k.newJoiners)} / ${n(k.exits)}`,
            icon: UserPlus,
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>Attendance by day</CardTitle>
          <CardDescription>
            Headcount split by the day&apos;s state. Late arrivals are part of
            present, shown as their own band.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart trend={data.trend} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {showStores ? (
          <Card>
            <CardHeader>
              <CardTitle>By store</CardTitle>
              <CardDescription>Attendance rate, late arrivals and absent days.</CardDescription>
            </CardHeader>
            <CardContent>
              <BreakdownBars
                rows={data.byStore.map((s) => ({ ...s, id: s.storeId, name: s.storeName }))}
              />
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>By department</CardTitle>
            <CardDescription>Attendance rate, late arrivals and absent days.</CardDescription>
          </CardHeader>
          <CardContent>
            <BreakdownBars
              rows={data.byDepartment.map((d, i) => ({
                ...d,
                id: d.departmentId ?? `none-${i}`,
                name: d.departmentName,
              }))}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Leaderboard
          title="Most late"
          description="Late arrivals in the period, and how late on average."
          empty="Nobody was late in this period."
          rows={data.topLate.map((r) => ({
            id: r.userId,
            name: r.name,
            value: `${n(r.lateCount)}×`,
            hint: `avg ${n(r.avgLateMinutes)} min`,
          }))}
        />
        <Leaderboard
          title="Most absent"
          description="Absent days in the period."
          empty="Nobody was absent in this period."
          rows={data.topAbsent.map((r) => ({
            id: r.userId,
            name: r.name,
            value: `${n(r.absentDays)} d`,
          }))}
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Trend — stacked area of the day's primary states                    */
/* ------------------------------------------------------------------ */

/** Read a colour token at call time (they are plain hex/rgba in globals.css). */
function cssColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const t = useChartTokens(); // re-resolves on theme flip

  const option = useMemo<EChartsOption>(() => {
    // Late is a modifier of present, so the "on time" band is present − late
    // and the stack never double counts.
    const bands: { name: string; color: string; pick: (p: TrendPoint) => number }[] = [
      { name: "On time", color: cssColor("--success", "#059669"), pick: (p) => Math.max(0, p.present - p.late) },
      { name: "Late", color: cssColor("--warning", "#d97706"), pick: (p) => p.late },
      { name: "Half day", color: cssColor("--chart-1", "#6366f1"), pick: (p) => p.half_day ?? 0 },
      { name: "Absent", color: cssColor("--destructive", "#e11d48"), pick: (p) => p.absent },
      { name: "Leave", color: cssColor("--chart-2", "#06b6d4"), pick: (p) => p.on_leave },
      { name: "Week off", color: t.muted, pick: (p) => p.week_off },
      { name: "Holiday", color: cssColor("--chart-6", "#a855f7"), pick: (p) => p.holiday },
      { name: "Not marked", color: t.border, pick: (p) => p.not_marked ?? 0 },
    ];
    const labels = trend.map((p) => {
      const [y, m, d] = p.date.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    });
    return {
      legend: { show: true, left: 0, right: "auto" },
      grid: { top: 36 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: labels,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 12 },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { color: t.muted, fontSize: 12 },
        splitLine: { lineStyle: { color: t.border, type: [4, 4] } },
      },
      series: bands.map((b) => ({
        name: b.name,
        type: "line",
        stack: "state",
        data: trend.map(b.pick),
        symbol: "none",
        lineStyle: { width: 1, color: b.color },
        itemStyle: { color: b.color },
        areaStyle: { color: b.color, opacity: 0.75 },
        emphasis: { focus: "series" },
      })),
    };
  }, [trend, t]);

  const empty = !trend.some(
    (p) =>
      p.present + (p.half_day ?? 0) + p.absent + p.on_leave + p.week_off + p.holiday + (p.not_marked ?? 0) > 0,
  );
  if (empty) return <ChartEmpty height={300} message="No attendance recorded in this period" />;
  return <EChart option={option} height={300} notMerge />;
}

/* ------------------------------------------------------------------ */
/* Breakdown bars + leaderboards (plain HTML: readable, theme-safe)     */
/* ------------------------------------------------------------------ */

function BreakdownBars({ rows }: { rows: (BreakdownRow & { id: string; name: string })[] }) {
  if (rows.length === 0) {
    return <ChartEmpty height={160} message="No data for this period" />;
  }
  const sorted = [...rows].sort((a, b) => b.attendanceRate - a.attendanceRate);
  return (
    <ul className="space-y-3">
      {sorted.map((r) => (
        <li key={r.id} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate font-medium">{r.name}</span>
            <span className="num shrink-0">{pct(r.attendanceRate)}</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-label={`${r.name} attendance rate`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(r.attendanceRate)}
          >
            <div
              className="h-full rounded-full bg-success"
              style={{ width: `${Math.min(100, Math.max(0, r.attendanceRate))}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="num">{n(r.headcount)}</span> staff ·{" "}
            <span className={r.lateCount ? "num text-foreground" : "num"}>{n(r.lateCount)}</span> late ·{" "}
            <span className="num">{n(r.absentDays)}</span> absent days
          </p>
        </li>
      ))}
    </ul>
  );
}

function Leaderboard({
  title,
  description,
  empty,
  rows,
}: {
  title: string;
  description: string;
  empty: string;
  rows: { id: string; name: string; value: string; hint?: string }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ol className="divide-y">
            {rows.map((r, i) => (
              <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="num w-5 text-right text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                {r.hint ? <span className="text-xs text-muted-foreground">{r.hint}</span> : null}
                <span className="num w-14 text-right">{r.value}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
