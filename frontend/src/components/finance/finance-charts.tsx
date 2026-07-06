"use client";

import { AreaChart, BarChart, useChartTokens } from "@/components/chart/echart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINRCompact } from "@/lib/format";
import type { BudgetActual, CashFlowPoint } from "@/lib/mock/finance";

export function BudgetVarianceChart({ data }: { data: BudgetActual[] }) {
  const t = useChartTokens();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Budget vs Actual</CardTitle>
        <CardDescription>Revenue variance by store / region (MTD)</CardDescription>
      </CardHeader>
      <CardContent>
        <BarChart
          categories={data.map((d) => d.store)}
          valueFormatter={formatINRCompact}
          series={[
            { name: "Budget", data: data.map((d) => d.budget), color: t.palette[2] },
            { name: "Actual", data: data.map((d) => d.actual), color: t.palette[0] },
          ]}
          height={280}
        />
      </CardContent>
    </Card>
  );
}

export function CashFlowChart({ data }: { data: CashFlowPoint[] }) {
  const t = useChartTokens();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash-Flow Forecast</CardTitle>
        <CardDescription>
          Projected inflow vs committed outflows — rentals, salaries, new-store setup
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AreaChart
          categories={data.map((d) => d.month)}
          valueFormatter={formatINRCompact}
          showLegend
          series={[
            { name: "Inflow", data: data.map((d) => d.inflow), color: t.palette[0] },
            { name: "Rentals", data: data.map((d) => d.rentals), dashed: true, color: t.palette[1] },
            { name: "Salaries", data: data.map((d) => d.salaries), dashed: true, color: t.palette[3] },
            { name: "New-Store Setup", data: data.map((d) => d.newStore), dashed: true, color: t.palette[4] },
          ]}
          height={280}
        />
      </CardContent>
    </Card>
  );
}
