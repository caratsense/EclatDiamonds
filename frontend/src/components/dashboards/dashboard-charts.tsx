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
import { AreaChart, BarChart, DonutChart, useChartTokens } from "@/components/chart/echart";
import { formatINRCompact, formatNumber } from "@/lib/format";
import type { LeadFunnelDay } from "@/lib/queries/dashboard";
import {
  storeCompareLabel,
  type StoreCompare,
  type TrendPoint,
} from "@/lib/mock/dashboards";

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

/** "Tue 7" from a store-local YYYY-MM-DD, without timezone re-interpretation. */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}`;
}

/**
 * Leads came vs converted (client, 8 Oct): the period's totals as a donut with
 * the conversion rate in the middle, and the last days side by side so "every
 * day" is readable at a glance. "Came" is a lead created that day; "converted"
 * is a lead closed WON that day — activity, not a cohort, so a lead can count
 * on different days for each.
 */
export function LeadFunnelChart({
  totals,
  days,
  periodLabel,
  href,
}: {
  totals: { came: number; converted: number };
  days: LeadFunnelDay[];
  periodLabel: string;
  href?: string;
}) {
  const t = useChartTokens();
  const open = Math.max(0, totals.came - totals.converted);
  const rate = totals.came > 0 ? Math.round((totals.converted / totals.came) * 100) : null;

  return (
    <ChartCard
      title="Leads — came vs converted"
      description={`${periodLabel}: ${formatNumber(totals.came)} came · ${formatNumber(totals.converted)} converted`}
      href={href}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <DonutChart
          data={[
            { name: "Converted", value: totals.converted, color: t.palette[4] },
            { name: "In progress", value: open, color: t.palette[0] },
          ]}
          valueFormatter={formatNumber}
          centerValue={rate != null ? `${rate}%` : "—"}
          centerLabel="CONVERTED"
          height={220}
        />
        <BarChart
          categories={days.map((d) => dayLabel(d.date))}
          series={[
            { name: "Came", data: days.map((d) => d.came), color: t.palette[0] },
            { name: "Converted", data: days.map((d) => d.converted), color: t.palette[4] },
          ]}
          valueFormatter={formatNumber}
          height={220}
        />
      </div>
    </ChartCard>
  );
}

export function StoreComparisonChart({ data, href }: { data: StoreCompare[]; href?: string }) {
  const categories = data.map(storeCompareLabel);
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
