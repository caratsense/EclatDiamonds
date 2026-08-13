"use client";

import { useState } from "react";
import { Download, Trophy } from "lucide-react";

import { BarChart, useChartTokens } from "@/components/chart/echart";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINRCompact, formatNumber, formatPercent } from "@/lib/format";
import type { LeaderboardRow } from "@/lib/mock/hrms";

const RANK_BADGE = [
  "bg-gold text-gold-foreground",
  "bg-secondary text-secondary-foreground",
  "bg-secondary text-secondary-foreground",
];

/** How many staff to show before the "View all" toggle. */
const TOP_N = 10;

/** Escape a CSV cell — quote it when it contains a comma, quote or newline. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function LeaderboardTab({ rows }: { rows: LeaderboardRow[] }) {
  const t = useChartTokens();
  const [showAll, setShowAll] = useState(false);

  // Rank by sales closed, then revenue.
  const ranked = [...rows].sort(
    (a, b) => b.closed - a.closed || b.revenue - a.revenue,
  );

  // Conversion funnel = team totals per stage. Staff belong on the leaderboard
  // table below; the funnel is one descending bar per stage (footfall → quotes
  // → closed), not a bar per person — that collapsed to a single group whenever
  // only one staffer had activity.
  const funnel = [
    { stage: "Footfall", value: ranked.reduce((s, r) => s + r.footfall, 0) },
    { stage: "Quotes", value: ranked.reduce((s, r) => s + r.quotes, 0) },
    { stage: "Closed", value: ranked.reduce((s, r) => s + r.closed, 0) },
  ];

  const visible = showAll ? ranked : ranked.slice(0, TOP_N);

  function exportCsv() {
    const header = [
      "Rank",
      "Staff",
      "Role",
      "Footfall",
      "Quotes",
      "Closed",
      "Conversion %",
      "Revenue",
    ];
    const body = ranked.map((r, i) => {
      const conv = r.footfall ? (r.closed / r.footfall) * 100 : 0;
      return [
        i + 1,
        r.name,
        r.role,
        r.footfall,
        r.quotes,
        r.closed,
        conv.toFixed(1),
        r.revenue,
      ];
    });
    const csv = [header, ...body]
      .map((row) => row.map(csvCell).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-leaderboard-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Conversion funnel</CardTitle>
          <CardDescription>
            Footfall attended → quotes made → sales closed — team totals this
            month.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BarChart
            categories={funnel.map((f) => f.stage)}
            series={[
              {
                name: "Count",
                data: funnel.map((f) => f.value),
                color: t.palette[0],
              },
            ]}
            valueFormatter={(v) => formatNumber(v)}
            height={300}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-muted-foreground" />
              Sales-staff leaderboard
            </CardTitle>
            <CardDescription>
              Ranked by deals closed. Conversion = closed ÷ footfall attended.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={ranked.length === 0}
          >
            <Download className="mr-1.5 h-4 w-4" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Staff</TableHead>
                <TableHead className="text-right">Footfall</TableHead>
                <TableHead className="text-right">Quotes</TableHead>
                <TableHead className="text-right">Closed</TableHead>
                <TableHead className="text-right">Conversion</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No staff activity ranked yet — figures appear as the team logs
                    footfall and sales.
                  </TableCell>
                </TableRow>
              ) : null}
              {visible.map((r, i) => {
                const conv = r.footfall ? (r.closed / r.footfall) * 100 : 0;
                return (
                  <TableRow key={r.staffId}>
                    <TableCell>
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                          RANK_BADGE[i] ?? "bg-muted text-muted-foreground"
                        }`}
                      >
                        {i + 1}
                      </span>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium leading-tight">{r.name}</p>
                      <p className="text-xs text-muted-foreground">{r.role}</p>
                    </TableCell>
                    <TableCell className="num text-right">{r.footfall}</TableCell>
                    <TableCell className="num text-right">{r.quotes}</TableCell>
                    <TableCell className="num text-right font-medium">
                      {r.closed}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={conv >= 35 ? "success" : "secondary"}>
                        <span className="num">{formatPercent(conv, 0)}</span>
                      </Badge>
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {formatINRCompact(r.revenue)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {ranked.length > TOP_N ? (
            <div className="mt-3 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? "Show top 10" : `View all (${ranked.length})`}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
