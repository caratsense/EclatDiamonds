"use client";

import * as React from "react";
import type { EChartsOption } from "echarts";

import { EChart, useChartTokens } from "@/components/chart/echart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { HourlyFootfall, StoreFootfall } from "@/lib/mock/checkins";

export function FootfallByHourChart({ data }: { data: HourlyFootfall[] }) {
  const t = useChartTokens();
  const peak = Math.max(...data.map((d) => d.visitors));

  const option = React.useMemo<EChartsOption>(() => {
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
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
        },
      ],
    };
  }, [data, peak, t]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Footfall by hour</CardTitle>
        <CardDescription>
          Walk-ins across the trading day. Peak hour highlighted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <EChart option={option} height={240} notMerge />
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

  const option = React.useMemo<EChartsOption>(() => {
    const round = [0, 4, 4, 0] as [number, number, number, number];
    return {
      legend: { show: true },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      xAxis: { type: "value", minInterval: 1 },
      yAxis: { type: "category", data: rows.map((r) => r.name) },
      series: [
        {
          name: "Today",
          type: "bar",
          barMaxWidth: 18,
          data: rows.map((r) => r.today),
          itemStyle: { color: t.palette[5], borderRadius: round },
        },
        {
          name: "Converted",
          type: "bar",
          barMaxWidth: 18,
          data: rows.map((r) => r.converted),
          itemStyle: { color: t.palette[4], borderRadius: round },
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
        <EChart option={option} height={240} notMerge />
      </CardContent>
    </Card>
  );
}
