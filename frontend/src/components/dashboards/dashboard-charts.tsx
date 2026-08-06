"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

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

/**
 * A chart card that, when `href` is set, becomes a tappable link to the matching
 * detail page (the whole card is the target — clicks on the chart bubble up).
 */
function ChartCard({
  title,
  description,
  href,
  children,
}: {
  title: string;
  description: string;
  href?: string;
  children: React.ReactNode;
}) {
  const card = (
    <Card className={href ? "group transition-shadow hover:shadow-md" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {title}
          {href ? (
            <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          ) : null}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block">
      {card}
    </Link>
  ) : (
    card
  );
}

export function SalesTrendChart({ data, href }: { data: TrendPoint[]; href?: string }) {
  const categories = data.map((d) => d.day);
  const t = useChartTokens();

  return (
    <ChartCard
      title="Sales Trend"
      description="Monthly revenue vs target — last 12 months"
      href={href}
    >
      <AreaChart
        categories={categories}
        valueFormatter={formatINRCompact}
        series={[
          { name: "Sales", data: data.map((d) => d.sales) },
          { name: "Target", data: data.map((d) => d.target), dashed: true, color: t.palette[1] },
        ]}
        height={260}
      />
    </ChartCard>
  );
}

export function StoreComparisonChart({ data, href }: { data: StoreCompare[]; href?: string }) {
  const categories = data.map((d) => d.store);
  const t = useChartTokens();

  return (
    <ChartCard
      title="Store Comparison"
      description="This month's revenue vs target by store"
      href={href}
    >
      <BarChart
        categories={categories}
        valueFormatter={formatINRCompact}
        series={[
          { name: "Revenue", data: data.map((d) => d.revenue) },
          { name: "Target", data: data.map((d) => d.target), color: t.palette[2] },
        ]}
        height={260}
      />
    </ChartCard>
  );
}
