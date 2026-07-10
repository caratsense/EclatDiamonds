"use client";

import { format, parseISO } from "date-fns";
import {
  IndianRupee,
  Package,
  Send,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatINR, formatINRCompact, formatNumber } from "@/lib/format";
import {
  REPORT_PERIODS,
  formatPaymentMode,
  type ReportPeriod,
  type ReportSummary,
} from "@/lib/mock/reporting";
import { useReportSummary } from "@/lib/queries/reporting";

/** Human-friendly from–to range label for a rollup window. */
function rangeLabel(s: ReportSummary): string {
  const from = parseISO(s.from);
  const to = parseISO(s.to);
  if (s.from === s.to) return format(from, "dd MMM yyyy");
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();
  if (sameMonth) return `${format(from, "dd")} – ${format(to, "dd MMM yyyy")}`;
  if (sameYear) return `${format(from, "dd MMM")} – ${format(to, "dd MMM yyyy")}`;
  return `${format(from, "dd MMM yyyy")} – ${format(to, "dd MMM yyyy")}`;
}

interface TileRow {
  label: string;
  value: string;
}

/**
 * Grouped rollup tile — a headline figure plus its supporting breakdown.
 * The hero tile carries the gold light-catch, mirroring KpiCard's signature.
 */
function RollupTile({
  icon: Icon,
  label,
  value,
  rows,
  hero,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  rows: TileRow[];
  hero?: boolean;
}) {
  return (
    <Card className="facet-top group relative overflow-hidden">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br to-transparent blur-2xl",
          hero
            ? "from-[color-mix(in_srgb,var(--gold)_22%,transparent)] opacity-90"
            : "from-[color-mix(in_srgb,var(--foreground)_8%,transparent)] opacity-50",
        )}
      />
      <CardContent className="relative p-5">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl",
              hero
                ? "bg-[color-mix(in_srgb,var(--gold)_14%,transparent)] text-gold-strong"
                : "bg-secondary text-muted-foreground",
            )}
          >
            <Icon className="h-5 w-5" />
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {label}
          </p>
        </div>
        {/* Numeric hero in the mono readout — serif oldstyle figures misalign. */}
        <p className="num mt-3.5 text-[26px] font-semibold leading-none tracking-tight text-foreground">
          {value}
        </p>
        <div className="mt-4 space-y-1.5 border-t pt-3">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between text-xs"
            >
              <span className="text-muted-foreground">{r.label}</span>
              <span className="num font-medium tabular-nums">{r.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Module 10 — period rollup. Daily / Weekly / Monthly segmented control that
 * fetches GET /reporting/summary and renders Sales / Orders / Payments tiles
 * with the covered from–to range. "Send report" opens the delivery dialog.
 */
export function PeriodRollup({
  period,
  onPeriodChange,
  onSendReport,
}: {
  period: ReportPeriod;
  onPeriodChange: (period: ReportPeriod) => void;
  onSendReport: () => void;
}) {
  const query = useReportSummary(period);
  const s = query.data;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
            Period rollup
          </h2>
          <p className="text-sm text-muted-foreground">
            Daily figures rolled up into weekly and monthly reports
            {s ? (
              <>
                {" · "}
                <span className="num">{rangeLabel(s)}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            value={period}
            onValueChange={(v) => onPeriodChange(v as ReportPeriod)}
          >
            <TabsList>
              {REPORT_PERIODS.map((p) => (
                <TabsTrigger key={p.key} value={p.key}>
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button onClick={onSendReport} className="shrink-0">
            <Send className="h-4 w-4" />
            Send report
          </Button>
        </div>
      </div>

      {query.isError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
            <p>Couldn&apos;t load the {period} rollup.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {query.isLoading || !s ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))
          ) : (
            (() => {
              // `sales`/`orders` are always present; `payments` is NOT in the
              // live /reporting/summary shape — fall back so the tile can't crash.
              const payments = s.payments ?? {
                count: 0,
                total: 0,
                byMode: {} as Record<string, number>,
              };
              return (
                <>
                  <RollupTile
                    hero
                    icon={IndianRupee}
                    label="Sales (net)"
                    value={formatINRCompact(s.sales.net)}
                    rows={[
                      { label: "Bills", value: formatNumber(s.sales.count) },
                      { label: "Gross", value: formatINR(s.sales.gross) },
                      { label: "Discount", value: formatINR(s.sales.discount) },
                    ]}
                  />
                  <RollupTile
                    icon={Package}
                    label="Orders booked"
                    value={formatNumber(s.orders.count)}
                    rows={[
                      { label: "Advance", value: formatINR(s.orders.advance) },
                      {
                        label: "Estimation",
                        value: formatINR(s.orders.estimation),
                      },
                    ]}
                  />
                  <RollupTile
                    icon={Wallet}
                    label="Payments collected"
                    value={formatINRCompact(payments.total)}
                    rows={[
                      {
                        label: "Transactions",
                        value: formatNumber(payments.count),
                      },
                      ...Object.entries(payments.byMode).map(([mode, amt]) => ({
                        label: formatPaymentMode(mode),
                        value: formatINR(amt),
                      })),
                    ]}
                  />
                </>
              );
            })()
          )}
        </div>
      )}
    </section>
  );
}
