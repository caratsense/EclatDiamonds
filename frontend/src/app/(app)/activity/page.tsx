"use client";

import { useState } from "react";
import { PackageOpen, Receipt, TrendingUp, Warehouse } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AreaChart } from "@/components/chart/echart";
import { getNavItem } from "@/lib/navigation";
import { formatINR, formatINRCompact } from "@/lib/format";
import { DASHBOARD_PERIODS, type DashboardPeriod } from "@/lib/queries/dashboard";
import { useActivity, type ActivityDocType } from "@/lib/queries/activity";

/**
 * A document's kind, said in the words the shop uses, and coloured so the two
 * that must never be confused cannot be: a bill earns money, a branch transfer
 * only moves stock between two of your own shops.
 */
const DOC_LABEL: Record<ActivityDocType, { text: string; tone: string }> = {
  sale: { text: "Sale", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  sale_return: { text: "Sale return", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  purchase: { text: "Purchase", tone: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  purchase_return: { text: "Purchase return", tone: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  branch_transfer: { text: "Branch transfer", tone: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  proforma: { text: "Proforma", tone: "bg-muted text-muted-foreground" },
};

/** "14 Jul 2026, 3:40 pm" — the document's own date, in the reader's locale. */
function whenOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <span className="rounded-lg bg-muted p-2">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="num truncate text-xl font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground">{sub}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ActivityPage() {
  const item = getNavItem("activity");
  // 30 days by default, not today: this page exists to show what happened, and
  // a shop that has not billed since lunchtime still had a month.
  const [period, setPeriod] = useState<DashboardPeriod>("month");
  const query = useActivity(period);
  const data = query.data;

  const flow = data?.flow ?? [];
  const docs = data?.documents ?? [];
  const soldTop = data?.sold.top ?? [];
  const buckets = data?.unsold.buckets ?? [];

  return (
    <>
      <SectionHeader title={item?.title ?? "Activity"} purpose={item?.purpose ?? ""} />

      <div className="mb-3 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">Showing</span>
        {DASHBOARD_PERIODS.map((p) => (
          <Button
            key={p.value}
            size="sm"
            variant={period === p.value ? "default" : "outline"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {query.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            icon={TrendingUp}
            label="Sold"
            value={formatINR(data?.sold.value ?? 0)}
            sub={`${data?.sold.pieces ?? 0} pieces billed`}
          />
          <Tile
            icon={Receipt}
            label="Bills"
            value={String(flow.reduce((n, d) => n + d.bills, 0))}
            sub="sales only, transfers excluded"
          />
          <Tile
            icon={Warehouse}
            label="Still in stock"
            value={formatINR(data?.unsold.value ?? 0)}
            sub={`${data?.unsold.pieces ?? 0} pieces unsold`}
          />
          <Tile
            icon={PackageOpen}
            label="Sitting over 180 days"
            value={formatINR(buckets.find((b) => b.label === "Over 180 days")?.value ?? 0)}
            sub={`${buckets.find((b) => b.label === "Over 180 days")?.pieces ?? 0} pieces`}
          />
        </div>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>When it came in</CardTitle>
          <CardDescription>
            Billed sales per day. A day with no bar is a day nobody billed, which is
            worth seeing rather than skipping.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-[260px] rounded-xl" />
          ) : (
            <AreaChart
              categories={flow.map((d) => d.label)}
              series={[{ name: "Sales", data: flow.map((d) => d.sales) }]}
              height={260}
              valueFormatter={formatINRCompact}
            />
          )}
        </CardContent>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>What sold</CardTitle>
            <CardDescription>By value, over the chosen window.</CardDescription>
          </CardHeader>
          <CardContent>
            {soldTop.length === 0 ? (
              <EmptyState icon={Receipt} title="Nothing billed yet" description="No sale in this window." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Design</TableHead>
                    <TableHead className="text-right">Pieces</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {soldTop.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="max-w-[240px] truncate">{r.name}</TableCell>
                      <TableCell className="num text-right">{r.pieces}</TableCell>
                      <TableCell className="num text-right">{formatINR(r.value)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What has not sold</CardTitle>
            <CardDescription>
              Stock on hand by how long it has been sitting. The older bands are the
              money the shop cannot spend.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {buckets.length === 0 ? (
              <EmptyState icon={Warehouse} title="No stock on hand" description="Nothing is in stock right now." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Age</TableHead>
                    <TableHead className="text-right">Pieces</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buckets.map((b) => (
                    <TableRow key={b.label}>
                      <TableCell>{b.label}</TableCell>
                      <TableCell className="num text-right">{b.pieces}</TableCell>
                      <TableCell className="num text-right">{formatINR(b.value)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Every document</CardTitle>
          <CardDescription>
            Newest first, with its own date. Sales, transfers and purchases together,
            each labelled — a transfer between your own shops is not revenue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-[320px] rounded-xl" />
          ) : docs.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="Nothing in this window"
              description="Try a wider period — this shop's history may be older than the window."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => {
                  const kind = DOC_LABEL[d.docType] ?? DOC_LABEL.proforma;
                  return (
                    <TableRow key={d.id} className={d.isCancelled ? "opacity-50" : undefined}>
                      <TableCell className="whitespace-nowrap text-xs">{whenOf(d.docDate)}</TableCell>
                      <TableCell className="max-w-[220px] truncate font-medium">{d.docNo}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={kind.tone}>
                          {kind.text}
                        </Badge>
                        {d.isCancelled ? (
                          <span className="ml-1 text-xs text-muted-foreground">cancelled</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate">{d.store}</TableCell>
                      <TableCell className="max-w-[180px] truncate">{d.customer || "—"}</TableCell>
                      <TableCell className="num text-right">{formatINR(d.amount)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
