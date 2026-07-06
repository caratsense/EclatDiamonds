"use client";

import * as React from "react";
import type { EChartsOption } from "echarts";

import { EChart, useChartTokens } from "@/components/chart/echart";
import type { AgingBucket } from "@/lib/mock/inventory";

interface AgingChartProps {
  data: AgingBucket[];
}

/** Bars shade warmer as stock ages — visual cue for dead-stock buckets. */
export function AgingChart({ data }: AgingChartProps) {
  const t = useChartTokens();

  const option = React.useMemo<EChartsOption>(() => {
    // Warm-to-hot ramp across the palette: fresh → aging → dead stock.
    const fills = [t.palette[4], t.palette[1], t.palette[3], t.palette[0], t.palette[2]];
    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v) => `${Number(v)} items`,
      },
      xAxis: { type: "category", data: data.map((d) => d.bucket) },
      yAxis: { type: "value", minInterval: 1 },
      series: [
        {
          type: "bar",
          name: "Stock",
          barMaxWidth: 36,
          data: data.map((d, i) => ({
            value: d.items,
            itemStyle: {
              color: fills[i % fills.length],
              borderRadius: [6, 6, 0, 0] as [number, number, number, number],
            },
          })),
        },
      ],
    };
  }, [data, t]);

  return <EChart option={option} height={220} notMerge />;
}
