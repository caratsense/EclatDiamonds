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
import {
  AreaChart,
  BarChart,
  DonutChart,
  horizontalBarHeight,
  useChartTokens,
} from "@/components/chart/echart";
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
    <Card className={href ? "group transition-colors hover:border-primary/40" : undefined}>
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
        emptyMessage="No billed sales in the last 12 months yet"
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
  /*
   * The pie reads the SAME days the bars show, not the period totals: on
   * "Today" with nothing filed yet the period is honestly zero, and a pie
   * that says "No data" beside bars full of this week's leads looked broken
   * (client, 10 Oct). The header line still carries the period's own totals.
   */
  const stripCame = days.reduce((sum, d) => sum + d.came, 0);
  const stripConverted = days.reduce((sum, d) => sum + d.converted, 0);
  const open = Math.max(0, stripCame - stripConverted);
  const rate = stripCame > 0 ? Math.round((stripConverted / stripCame) * 100) : null;

  return (
    <ChartCard
      title="Leads — came vs converted"
      description={`${periodLabel}: ${formatNumber(totals.came)} came · ${formatNumber(totals.converted)} converted`}
      href={href}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <DonutChart
          data={[
            { name: "Converted", value: stripConverted, color: t.palette[4] },
            { name: "In progress", value: open, color: t.palette[0] },
          ]}
          valueFormatter={formatNumber}
          centerValue={rate != null ? `${rate}%` : "—"}
          centerLabel="CONVERTED"
          height={220}
          emptyMessage="No leads in these days yet"
        />
        <BarChart
          categories={days.map((d) => dayLabel(d.date))}
          series={[
            { name: "Came", data: days.map((d) => d.came), color: t.palette[0] },
            { name: "Converted", data: days.map((d) => d.converted), color: t.palette[4] },
          ]}
          valueFormatter={formatNumber}
          height={220}
          emptyMessage="No leads in these days yet"
        />
      </div>
    </ChartCard>
  );
}

/**
 * How many branches the dashboard card plots before rolling the rest into one
 * row.
 *
 * The card is a summary that links through to Store Comparison, where every
 * branch is listed in full with its share and achievement; its job here is
 * "which branches are carrying the month", not the complete ledger. Six rows
 * plus the roll-up keeps the card about as tall as the Sales Trend card beside
 * it in the dashboard's two-column grid — a card that grew to eleven rows
 * would leave its neighbour half empty.
 */
const CARD_BRANCHES = 6;

/**
 * Best-first, with the tail rolled up — the rows this card actually plots.
 *
 * Kept module-level, pure and exported so the component body stays as flat as
 * its neighbours in this file and the roll-up can be tested without a DOM.
 */
export function rankedForCard(data: StoreCompare[]): StoreCompare[] {
  const ranked = [...data].sort((a, b) => b.revenue - a.revenue);
  // Rolling one branch up into "Other branches (1)" would hide a name to save
  // nothing, so the roll-up only starts once it replaces at least two.
  if (ranked.length <= CARD_BRANCHES + 1) return ranked;

  const tail = ranked.slice(CARD_BRANCHES);
  const withTarget = tail.filter((s) => s.target != null);
  return [
    ...ranked.slice(0, CARD_BRANCHES),
    {
      store: `Other branches (${tail.length})`,
      revenue: tail.reduce((sum, s) => sum + s.revenue, 0),
      // Only the branches that HAVE a target are summed; a tail where nobody
      // set one stays null, so the roll-up never invents a target of zero.
      target: withTarget.length
        ? withTarget.reduce((sum, s) => sum + (s.target ?? 0), 0)
        : null,
    },
  ];
}

export function StoreComparisonChart({ data, href }: { data: StoreCompare[]; href?: string }) {
  const t = useChartTokens();
  const rows = rankedForCard(data);
  const rolledUp = rows.length < data.length;

  /*
   * Bars lie down here (client CEO, 23 Nov).
   *
   * Nibhana has eleven trading branches and this card stood all eleven names
   * on a vertical axis inside a half-width dashboard card — forty pixels per
   * name. Every label was drawn over its neighbour and the axis read
   * "MUMBAILEDRPVREASHIBASCHRASHILK SHARPUNE AMANDRAVEAMBLDELHI ROOHRIMRTBAI
   * BAND". The tooltip was fine; nobody could tell which bar it belonged to.
   *
   * See BarChart's `horizontal` for why rotating the labels is not the fix.
   */
  return (
    <ChartCard
      title="Store Comparison"
      description={
        rolledUp
          ? `This month's revenue vs target — top ${CARD_BRANCHES} of ${data.length} branches`
          : "This month's revenue vs target by store"
      }
      href={href}
    >
      <BarChart
        categories={rows.map(storeCompareLabel)}
        valueFormatter={formatINRCompact}
        series={[
          { name: "Revenue", data: rows.map((d) => d.revenue) },
          { name: "Target", data: rows.map((d) => d.target), color: t.palette[2] },
        ]}
        horizontal
        height={horizontalBarHeight(rows.length, 2)}
        emptyMessage="No store revenue or targets recorded this month yet"
      />
    </ChartCard>
  );
}
