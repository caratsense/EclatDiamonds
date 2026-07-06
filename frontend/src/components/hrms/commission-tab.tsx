"use client";

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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR, formatINRCompact, formatPercent } from "@/lib/format";
import type { CommissionRow } from "@/lib/mock/hrms";

function AchievementBar({ pct }: { pct: number }) {
  const capped = Math.min(pct, 100);
  const hit = pct >= 100;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${hit ? "bg-emerald-500" : "bg-amber-500"}`}
          style={{ width: `${capped}%` }}
        />
      </div>
      <span className="num text-xs font-medium">{formatPercent(pct, 0)}</span>
    </div>
  );
}

export function CommissionTab({ rows }: { rows: CommissionRow[] }) {
  const totalIncentive = rows.reduce((s, r) => s + r.incentive, 0);
  const totalSales = rows.reduce((s, r) => s + r.salesValue, 0);
  const achievers = rows.filter((r) => r.salesValue >= r.target).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Attributed sales</p>
            <p className="num text-2xl font-semibold">
              {formatINRCompact(totalSales)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Payable incentive</p>
            <p className="num text-2xl font-semibold">
              {formatINRCompact(totalIncentive)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Target achievers</p>
            <p className="num text-2xl font-semibold">
              {achievers}/{rows.length}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Commission engine</CardTitle>
          <CardDescription>
            Incentive = attributed sales × applicable rate. Target achievement
            unlocks the higher slab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Staff</TableHead>
                <TableHead className="text-right">Sales value</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Incentive</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead>Achievement</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No commission attributed yet — close a sale to start earning.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((r) => {
                const pct = r.target ? (r.salesValue / r.target) * 100 : 0;
                return (
                  <TableRow key={r.staffId}>
                    <TableCell>
                      <p className="font-medium leading-tight">{r.name}</p>
                      <p className="text-xs text-muted-foreground">{r.role}</p>
                    </TableCell>
                    <TableCell className="num text-right">
                      {formatINR(r.salesValue)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline">
                        <span className="num">{formatPercent(r.rate * 100, 1)}</span>
                      </Badge>
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {formatINR(r.incentive)}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {formatINRCompact(r.target)}
                    </TableCell>
                    <TableCell>
                      <AchievementBar pct={pct} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <TableCell className="num text-right">
                  {formatINR(totalSales)}
                </TableCell>
                <TableCell />
                <TableCell className="num text-right">
                  {formatINR(totalIncentive)}
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
