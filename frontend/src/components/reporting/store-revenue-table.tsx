"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatGrams, formatINR, formatNumber } from "@/lib/format";
import type { DsrBasis, StoreRevenue } from "@/lib/mock/reporting";

interface StoreRevenueTableProps {
  data: StoreRevenue[];
  basis?: DsrBasis;
  isLoading?: boolean;
}

/** "1 of 3 · 33.3%", or "—" when there was nothing to convert. */
function conversion(numerator: number, denominator: number): string {
  if (!denominator) return "—";
  const pct = Math.round((numerator / denominator) * 1000) / 10;
  return `${formatNumber(numerator)} of ${formatNumber(denominator)} · ${pct}%`;
}

const COLUMNS = 10;

/**
 * Branch against branch, today. Returns and cancellations sit beside revenue and
 * are never netted off it; visit-to-sale shows its numerator and denominator.
 */
export function StoreRevenueTable({ data, basis, isLoading }: StoreRevenueTableProps) {
  const totals = data.reduce(
    (acc, r) => ({
      walkins: acc.walkins + r.walkins,
      leads: acc.leads + (r.leads ?? 0),
      quotes: acc.quotes + (r.quotes ?? 0),
      bills: acc.bills + r.bills,
      converted: acc.converted + (r.visitToSale?.numerator ?? 0),
      returns: acc.returns + (r.returns?.amount ?? 0),
      returnCount: acc.returnCount + (r.returns?.count ?? 0),
      cancelled: acc.cancelled + (r.cancelled?.amount ?? 0),
      cancelledCount: acc.cancelledCount + (r.cancelled?.count ?? 0),
      revenue: acc.revenue + r.revenue,
      goldGrams: acc.goldGrams + r.goldGrams,
    }),
    {
      walkins: 0, leads: 0, quotes: 0, bills: 0, converted: 0, returns: 0,
      returnCount: 0, cancelled: 0, cancelledCount: 0, revenue: 0, goldGrams: 0,
    },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branch comparison</CardTitle>
        <CardDescription>
          {basis
            ? `${basis.date} · day boundaries in ${basis.timezone}${
                basis.zonesInScope.length > 1
                  ? ` (branches span ${basis.zonesInScope.join(", ")})`
                  : ""
              } · amounts in ${basis.currency}`
            : "Today's performance across branches"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Store</TableHead>
              <TableHead className="text-right">Walk-ins</TableHead>
              <TableHead className="text-right">Enquiries</TableHead>
              <TableHead className="text-right">Quotes</TableHead>
              <TableHead className="text-right">Bills</TableHead>
              <TableHead className="text-right" title={basis?.definitions.visitToSale}>
                Visit → sale
              </TableHead>
              <TableHead className="text-right" title={basis?.definitions.returns}>
                Returns
              </TableHead>
              <TableHead className="text-right" title={basis?.definitions.cancelled}>
                Cancelled
              </TableHead>
              <TableHead className="text-right">Gold (net)</TableHead>
              <TableHead className="text-right" title={basis?.definitions.revenue}>
                Revenue
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={COLUMNS}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No branches in scope.
                </TableCell>
              </TableRow>
            ) : (
              data.map((r) => (
                <TableRow key={r.storeId ?? r.store}>
                  <TableCell className="font-medium whitespace-nowrap">{r.store}</TableCell>
                  <TableCell className="num text-right">{formatNumber(r.walkins)}</TableCell>
                  <TableCell className="num text-right">{formatNumber(r.leads ?? 0)}</TableCell>
                  <TableCell className="num text-right">{formatNumber(r.quotes ?? 0)}</TableCell>
                  <TableCell className="num text-right">{formatNumber(r.bills)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap">
                    {r.visitToSale
                      ? conversion(r.visitToSale.numerator, r.visitToSale.denominator)
                      : "—"}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap">
                    {r.returns?.count
                      ? `${formatINR(r.returns.amount)} (${formatNumber(r.returns.count)})`
                      : "—"}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap">
                    {r.cancelled?.count
                      ? `${formatINR(r.cancelled.amount)} (${formatNumber(r.cancelled.count)})`
                      : "—"}
                  </TableCell>
                  <TableCell className="num text-right">{formatGrams(r.goldGrams, 0)}</TableCell>
                  <TableCell className="num text-right font-medium">{formatINR(r.revenue)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Total</TableCell>
              <TableCell className="num text-right">{formatNumber(totals.walkins)}</TableCell>
              <TableCell className="num text-right">{formatNumber(totals.leads)}</TableCell>
              <TableCell className="num text-right">{formatNumber(totals.quotes)}</TableCell>
              <TableCell className="num text-right">{formatNumber(totals.bills)}</TableCell>
              <TableCell className="num text-right whitespace-nowrap">
                {conversion(totals.converted, totals.walkins)}
              </TableCell>
              <TableCell className="num text-right whitespace-nowrap">
                {totals.returnCount ? formatINR(totals.returns) : "—"}
              </TableCell>
              <TableCell className="num text-right whitespace-nowrap">
                {totals.cancelledCount ? formatINR(totals.cancelled) : "—"}
              </TableCell>
              <TableCell className="num text-right">{formatGrams(totals.goldGrams, 0)}</TableCell>
              <TableCell className="num text-right">{formatINR(totals.revenue)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}
