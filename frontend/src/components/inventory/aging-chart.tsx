"use client";

import * as React from "react";
import type { EChartsOption } from "echarts";

import {
  axisTooltipFormatter,
  ChartEmpty,
  EChart,
  emphasisShadow,
  useChartTokens,
} from "@/components/chart/echart";
import { formatINRCompact, formatNumber } from "@/lib/format";
import type { AgingBucket } from "@/lib/mock/inventory";

interface AgingChartProps {
  data: AgingBucket[];
  /** Plot piece counts (default) or stock value per bucket. */
  metric?: "items" | "value";
}

/** Bars shade warmer as stock ages — visual cue for dead-stock buckets. */
export function AgingChart({ data, metric = "items" }: AgingChartProps) {
  const t = useChartTokens();
  const byValue = metric === "value";

  const option = React.useMemo<EChartsOption>(() => {
    // Warm-to-hot ramp across the palette: fresh → aging → dead stock.
    const fills = [t.palette[4], t.palette[1], t.palette[3], t.palette[0], t.palette[2]];
    // The buckets partition the whole stock, so "38% is sitting over 180 days"
    // is the figure a merchandiser actually acts on.
    const stockTotal = data.reduce(
      (sum, d) => sum + (byValue ? (d.value ?? 0) : d.items),
      0,
    );
    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: axisTooltipFormatter({
          format: (v) =>
            byValue ? formatINRCompact(v) : `${formatNumber(v)} ${v === 1 ? "item" : "items"}`,
          shareTotal: stockTotal,
        }),
      },
      xAxis: { type: "category", data: data.map((d) => d.bucket) },
      yAxis: {
        type: "value",
        minInterval: byValue ? undefined : 1,
        axisLabel: byValue
          ? { formatter: (v: number) => formatINRCompact(v) }
          : undefined,
      },
      series: [
        {
          type: "bar",
          name: byValue ? "Value" : "Stock",
          barMaxWidth: 36,
          data: data.map((d, i) => ({
            value: byValue ? (d.value ?? 0) : d.items,
            itemStyle: {
              color: fills[i % fills.length],
              borderRadius: [6, 6, 0, 0] as [number, number, number, number],
            },
          })),
          // Lift only. Each bucket owns its place on the warm-to-hot ramp, and
          // an emphasis that recolours it loses the one thing the ramp says.
          emphasis: { itemStyle: emphasisShadow(t) },
        },
      ],
    };
  }, [data, t, byValue]);

  const hasData = byValue
    ? data.some((d) => (d.value ?? 0) > 0)
    : data.some((d) => d.items > 0);
  if (!hasData) {
    return <ChartEmpty height={220} message="No stock in these buckets" />;
  }
  return <EChart option={option} height={220} notMerge />;
}
