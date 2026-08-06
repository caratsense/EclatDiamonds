"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AreaChart, BarChart, useChartTokens } from "@/components/chart/echart";
import { formatINRCompact } from "@/lib/format";
import type { StoreCompare, TrendPoint } from "@/lib/mock/dashboards";

export function SalesTrendChart({ data }: { data: TrendPoint[] }) {
  const categories = data.map((d) => d.day);
  const t = useChartTokens();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sales Trend</CardTitle>
        <CardDescription>Monthly revenue vs target — last 12 months</CardDescription>
      </CardHeader>
      <CardContent>
        <AreaChart
          categories={categories}
          valueFormatter={formatINRCompact}
          series={[
            { name: "Sales", data: data.map((d) => d.sales) },
            { name: "Target", data: data.map((d) => d.target), dashed: true, color: t.palette[1] },
          ]}
          height={260}
        />
      </CardContent>
    </Card>
  );
}

export function StoreComparisonChart({ data }: { data: StoreCompare[] }) {
  const categories = data.map((d) => d.store);
  const t = useChartTokens();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store Comparison</CardTitle>
        <CardDescription>This month&apos;s revenue vs target by store</CardDescription>
      </CardHeader>
      <CardContent>
        <BarChart
          categories={categories}
          valueFormatter={formatINRCompact}
          series={[
            { name: "Revenue", data: data.map((d) => d.revenue) },
            { name: "Target", data: data.map((d) => d.target), color: t.palette[2] },
          ]}
          height={260}
        />
      </CardContent>
    </Card>
  );
}
