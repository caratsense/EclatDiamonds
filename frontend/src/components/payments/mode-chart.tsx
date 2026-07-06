"use client";

import { DonutChart } from "@/components/chart/echart";
import { formatINRCompact } from "@/lib/format";

interface ModeBreakdownSlice {
  mode: string;
  amount: number;
}

interface ModeChartProps {
  data: ModeBreakdownSlice[];
}

/** Donut breakdown of collections by payment mode. */
export function ModeChart({ data }: ModeChartProps) {
  const slices = data
    .filter((d) => d.amount > 0)
    .map((d) => ({ name: d.mode, value: d.amount }));

  return (
    <DonutChart
      data={slices}
      valueFormatter={formatINRCompact}
      height={240}
    />
  );
}
