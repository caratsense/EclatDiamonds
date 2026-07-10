"use client";

import { Trophy } from "lucide-react";

import { BarChart, useChartTokens } from "@/components/chart/echart";

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
import { formatINRCompact, formatPercent } from "@/lib/format";
import type { LeaderboardRow } from "@/lib/mock/hrms";

const RANK_BADGE = [
  "bg-gold text-gold-foreground",
  "bg-secondary text-secondary-foreground",
  "bg-secondary text-secondary-foreground",
];

export function LeaderboardTab({ rows }: { rows: LeaderboardRow[] }) {
  const t = useChartTokens();

  // Rank by sales closed, then revenue.
  const ranked = [...rows].sort(
    (a, b) => b.closed - a.closed || b.revenue - a.revenue,
  );

  const categories = ranked.map((r) => r.name.split(" ")[0]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Conversion funnel by staff</CardTitle>
          <CardDescription>
            Footfall attended → quotes made → sales closed (this month).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BarChart
            categories={categories}
            series={[
              { name: "Footfall", data: ranked.map((r) => r.footfall), color: t.palette[5] },
              { name: "Quotes", data: ranked.map((r) => r.quotes), color: t.palette[2] },
              { name: "Closed", data: ranked.map((r) => r.closed), color: t.palette[3] },
            ]}
            height={300}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-muted-foreground" />
            Sales-staff leaderboard
          </CardTitle>
          <CardDescription>
            Ranked by deals closed. Conversion = closed ÷ footfall attended.
          </CardDescription>
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
              {ranked.map((r, i) => {
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
        </CardContent>
      </Card>
    </div>
  );
}
