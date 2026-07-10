"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  GitCompare,
} from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  BarChart,
  useChartTokens,
  type ChartSeries,
} from "@/components/chart/echart";
import { formatINR, formatINRCompact, formatPercent } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useStoreComparison } from "@/lib/queries/store-comparison";

/**
 * Store Comparison (Module 10, area/HO only) — every store side by side WITHOUT
 * switching the active store. Reads the pan-India aggregate from the same
 * `/dashboard/charts` → storeComparison feed the dashboard uses, forced to all
 * stores regardless of the topbar selector (see useStoreComparison).
 */

type SortKey = "store" | "revenue" | "share" | "target" | "achievement";
type SortDir = "asc" | "desc";

interface Row {
  /** Stable id = position in the source feed (rows carry no id of their own). */
  id: number;
  store: string;
  revenue: number;
  target: number;
  /** Share of total revenue across all stores (%). */
  share: number;
  /** Revenue ÷ target (%); 0 when no target is set. */
  achievement: number;
}

function sortValue(r: Row, key: SortKey): number | string {
  switch (key) {
    case "store":
      return r.store;
    case "revenue":
      return r.revenue;
    case "share":
      return r.share;
    case "target":
      return r.target;
    case "achievement":
      return r.achievement;
  }
}

export default function StoreComparisonPage() {
  const item = getNavItem("store-comparison");
  const query = useStoreComparison();
  const t = useChartTokens();

  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "revenue",
    dir: "desc",
  });

  const data = useMemo(() => query.data ?? [], [query.data]);

  const total = useMemo(
    () => data.reduce((sum, d) => sum + d.revenue, 0),
    [data],
  );
  const totalTarget = useMemo(
    () => data.reduce((sum, d) => sum + d.target, 0),
    [data],
  );
  // Backend leaves target = 0 until store targets are configured — only surface
  // the target/achievement columns once at least one store actually has one.
  const hasTargets = useMemo(() => data.some((d) => d.target > 0), [data]);

  const rows: Row[] = useMemo(
    () =>
      data.map((d, i) => ({
        id: i,
        store: d.store,
        revenue: d.revenue,
        target: d.target,
        share: total > 0 ? (d.revenue / total) * 100 : 0,
        achievement: d.target > 0 ? (d.revenue / d.target) * 100 : 0,
      })),
    [data, total],
  );

  // Top / lowest by revenue — computed from the data, independent of the
  // current sort, so the highlight stays put when the user re-sorts.
  const { topId, lowId } = useMemo(() => {
    let hi = -Infinity;
    let lo = Infinity;
    let topId = -1;
    let lowId = -1;
    for (const r of rows) {
      if (r.revenue > hi) {
        hi = r.revenue;
        topId = r.id;
      }
      if (r.revenue < lo) {
        lo = r.revenue;
        lowId = r.id;
      }
    }
    return { topId, lowId };
  }, [rows]);
  // Only flag a "lowest" once there are ≥2 distinct stores to compare.
  const showLowest = rows.length >= 2 && lowId !== topId;

  const sorted = useMemo(() => {
    const arr = [...rows];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      const cmp =
        typeof av === "string" || typeof bv === "string"
          ? String(av).localeCompare(String(bv))
          : av - bv;
      return dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, sort]);

  // Chart always renders stores highest-revenue-first for a clean descending read.
  const chartRows = useMemo(
    () => [...rows].sort((a, b) => b.revenue - a.revenue),
    [rows],
  );
  const chartSeries: ChartSeries[] = useMemo(() => {
    const series: ChartSeries[] = [
      { name: "Revenue", data: chartRows.map((r) => r.revenue) },
    ];
    if (hasTargets) {
      series.push({
        name: "Target",
        data: chartRows.map((r) => r.target),
        color: t.palette[2],
      });
    }
    return series;
  }, [chartRows, hasTargets, t]);

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "store" ? "asc" : "desc" },
    );
  }

  return (
    <>
      <SectionHeader
        title={item?.title ?? "Store Comparison"}
        purpose={item?.purpose ?? ""}
      />

      {query.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[360px] rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : query.isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">
            Couldn&apos;t load store figures.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The connection may have dropped. Check your network and try again.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={GitCompare}
          title="No store data yet"
          description="Store figures appear as sales and orders are recorded."
        />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Revenue by store</CardTitle>
              <CardDescription>
                Every store side by side — today&apos;s revenue across all
                branches, whichever store is active.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BarChart
                categories={chartRows.map((r) => r.store)}
                valueFormatter={formatINRCompact}
                series={chartSeries}
                height={320}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All stores</CardTitle>
              <CardDescription>
                Ranked by revenue. Share = each store&apos;s slice of total
                revenue. Tap a column to re-sort.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <SortButton
                        label="Store"
                        k="store"
                        sort={sort}
                        onSort={toggleSort}
                      />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortButton
                        label="Revenue"
                        k="revenue"
                        sort={sort}
                        onSort={toggleSort}
                        align="right"
                      />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortButton
                        label="Share"
                        k="share"
                        sort={sort}
                        onSort={toggleSort}
                        align="right"
                      />
                    </TableHead>
                    {hasTargets ? (
                      <>
                        <TableHead className="text-right">
                          <SortButton
                            label="Target"
                            k="target"
                            sort={sort}
                            onSort={toggleSort}
                            align="right"
                          />
                        </TableHead>
                        <TableHead className="text-right">
                          <SortButton
                            label="Achieved"
                            k="achievement"
                            sort={sort}
                            onSort={toggleSort}
                            align="right"
                          />
                        </TableHead>
                      </>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((r) => {
                    const isTop = r.id === topId;
                    const isLow = showLowest && r.id === lowId;
                    return (
                      <TableRow
                        key={r.id}
                        className={cn(
                          isTop &&
                            "bg-[color-mix(in_srgb,var(--gold)_7%,transparent)]",
                        )}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{r.store}</span>
                            {isTop ? <Badge variant="gold">Top</Badge> : null}
                            {isLow ? (
                              <Badge variant="warning">Lowest</Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="num text-right font-medium">
                          {formatINR(r.revenue)}
                        </TableCell>
                        <TableCell className="num text-right text-muted-foreground">
                          {formatPercent(r.share, 1)}
                        </TableCell>
                        {hasTargets ? (
                          <>
                            <TableCell className="num text-right text-muted-foreground">
                              {formatINR(r.target)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge
                                variant={
                                  r.achievement >= 100 ? "success" : "secondary"
                                }
                              >
                                <span className="num">
                                  {formatPercent(r.achievement, 0)}
                                </span>
                              </Badge>
                            </TableCell>
                          </>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-medium">
                      All stores ({rows.length})
                    </TableCell>
                    <TableCell className="num text-right font-semibold">
                      {formatINR(total)}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {formatPercent(total > 0 ? 100 : 0, 1)}
                    </TableCell>
                    {hasTargets ? (
                      <>
                        <TableCell className="num text-right text-muted-foreground">
                          {formatINR(totalTarget)}
                        </TableCell>
                        <TableCell className="num text-right font-medium">
                          {formatPercent(
                            totalTarget > 0 ? (total / totalTarget) * 100 : 0,
                            0,
                          )}
                        </TableCell>
                      </>
                    ) : null}
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function SortButton({
  label,
  k,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
        align === "right" && "flex-row-reverse",
      )}
    >
      {label}
      <Icon
        className={cn("h-3.5 w-3.5", active ? "text-foreground" : "opacity-50")}
      />
    </button>
  );
}
