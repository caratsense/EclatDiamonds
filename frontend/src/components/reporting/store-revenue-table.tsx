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
import type { StoreRevenue } from "@/lib/mock/reporting";

interface StoreRevenueTableProps {
  data: StoreRevenue[];
  isLoading?: boolean;
}

/** Store-wise revenue table for the DSR. */
export function StoreRevenueTable({ data, isLoading }: StoreRevenueTableProps) {
  const totals = data.reduce(
    (acc, r) => ({
      walkins: acc.walkins + r.walkins,
      bills: acc.bills + r.bills,
      revenue: acc.revenue + r.revenue,
      goldGrams: acc.goldGrams + r.goldGrams,
    }),
    { walkins: 0, bills: 0, revenue: 0, goldGrams: 0 },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store-wise Revenue</CardTitle>
        <CardDescription>Today&apos;s performance across branches</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Store</TableHead>
              <TableHead className="text-right">Walk-ins</TableHead>
              <TableHead className="text-right">Bills</TableHead>
              <TableHead className="text-right">Gold (net)</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No sales recorded today for this store yet.
                </TableCell>
              </TableRow>
            ) : (
              data.map((r) => (
                <TableRow key={r.store}>
                  <TableCell className="font-medium">{r.store}</TableCell>
                  <TableCell className="num text-right">{formatNumber(r.walkins)}</TableCell>
                  <TableCell className="num text-right">{formatNumber(r.bills)}</TableCell>
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
              <TableCell className="num text-right">{formatNumber(totals.bills)}</TableCell>
              <TableCell className="num text-right">{formatGrams(totals.goldGrams, 0)}</TableCell>
              <TableCell className="num text-right">{formatINR(totals.revenue)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}
