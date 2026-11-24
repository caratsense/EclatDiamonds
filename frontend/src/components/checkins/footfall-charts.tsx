"use client";

import * as React from "react";
import type { EChartsOption } from "echarts";

import {
  axisTooltipFormatter,
  ChartEmpty,
  EChart,
  emphasisShadow,
  horizontalBarHeight,
  useChartTokens,
} from "@/components/chart/echart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { HourlyFootfall, StoreFootfall } from "@/lib/mock/checkins";

export function FootfallByHourChart({ data }: { data: HourlyFootfall[] }) {
  const t = useChartTokens();
  // Math.max(...[]) is -Infinity — guard the empty case (no walk-ins yet).
  const peak = data.length ? Math.max(...data.map((d) => d.visitors)) : 0;
  const hasData = data.some((d) => d.visitors > 0);

  const option = React.useMemo<EChartsOption>(() => {
    const dayTotal = data.reduce((sum, d) => sum + d.visitors, 0);
    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        // The hours compose the day, so each bar's share of it is a real answer
        // — "a third of the footfall arrived between 6 and 7".
        formatter: axisTooltipFormatter({
          format: (v) => `${formatNumber(v)} ${v === 1 ? "visitor" : "visitors"}`,
          shareTotal: dayTotal,
        }),
      },
      xAxis: { type: "category", data: data.map((d) => d.hour) },
      yAxis: { type: "value", minInterval: 1 },
      series: [
        {
          type: "bar",
          name: "Visitors",
          barMaxWidth: 28,
          data: data.map((d) => ({
            value: d.visitors,
            itemStyle: {
              // Peak hour highlighted in amber, rest in the accent hue.
              color: d.visitors === peak ? t.palette[3] : t.palette[2],
              borderRadius: [4, 4, 0, 0] as [number, number, number, number],
            },
          })),
          // Each bar carries its own colour, so emphasis only lifts it — the
          // peak hour must still be the amber one under the cursor.
          emphasis: { itemStyle: emphasisShadow(t) },
        },
      ],
    };
  }, [data, peak, t]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Footfall by hour</CardTitle>
        <CardDescription>Peak hour highlighted.</CardDescription>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <EChart option={option} height={240} notMerge />
        ) : (
          <ChartEmpty height={240} message="No walk-ins recorded yet" />
        )}
      </CardContent>
    </Card>
  );
}

export function FootfallByStoreChart({ data }: { data: StoreFootfall[] }) {
  const t = useChartTokens();
  const rows = data.map((d) => ({
    name: d.store.split(" — ")[1] ?? d.store,
    today: d.today,
    converted: d.converted,
  }));
  const hasData = rows.some((r) => r.today > 0 || r.converted > 0);

  const option = React.useMemo<EChartsOption>(() => {
    const round = [0, 4, 4, 0] as [number, number, number, number];
    return {
      legend: { show: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        /*
         * No share here: walk-ins and sales closed are two measures of the same
         * store, not two parts of one total, and a percentage across them would
         * read as a conversion rate while meaning nothing of the kind.
         */
        formatter: axisTooltipFormatter({ format: (v) => formatNumber(v) }),
      },
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      xAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { color: t.muted, fontSize: 12, fontFamily: t.fontSans },
      },
      yAxis: {
        type: "category",
        data: rows.map((r) => r.name),
        /*
         * Pin every branch name and truncate the long ones (client CEO,
         * 23 Nov). This axis carried no label settings at all, so it ran on
         * ECharts' `interval: "auto"` — which drops whichever labels would
         * collide. Three branches fitted; at Nibhana's eleven it silently
         * dropped half of them and left bars with nothing beside them, the
         * same disappearing-store-label failure `storeCompareLabel`
         * documents. It also ran on ECharts' built-in grey, which is 3.4:1 on
         * the dark card — the muted token is theme-resolved and clears 8:1.
         */
        axisLabel: {
          color: t.muted,
          fontSize: 12,
          fontFamily: t.fontSans,
          interval: 0,
          width: 160,
          overflow: "truncate",
          ellipsis: "…",
        },
      },
      series: [
        {
          name: "Today",
          type: "bar",
          barMaxWidth: 18,
          data: rows.map((r) => r.today),
          itemStyle: { color: t.palette[5], borderRadius: round },
          emphasis: {
            focus: "series",
            itemStyle: { color: t.palette[5], ...emphasisShadow(t) },
          },
          blur: { itemStyle: { opacity: 0.3 } },
        },
        {
          name: "Converted",
          type: "bar",
          barMaxWidth: 18,
          data: rows.map((r) => r.converted),
          itemStyle: { color: t.palette[4], borderRadius: round },
          emphasis: {
            focus: "series",
            itemStyle: { color: t.palette[4], ...emphasisShadow(t) },
          },
          blur: { itemStyle: { opacity: 0.3 } },
        },
      ],
    };
  }, [rows, t]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Footfall by store</CardTitle>
        <CardDescription>Today&apos;s walk-ins vs sales closed.</CardDescription>
      </CardHeader>
      <CardContent>
        {hasData ? (
          // Sized by the branch count, not fixed: a flat 240 left eleven
          // branches under twenty pixels of row each.
          <EChart option={option} height={horizontalBarHeight(rows.length, 2)} notMerge />
        ) : (
          <ChartEmpty height={240} message="No walk-ins recorded yet" />
        )}
      </CardContent>
    </Card>
  );
}
