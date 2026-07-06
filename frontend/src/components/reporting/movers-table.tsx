"use client";

import { TrendingDown, TrendingUp } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { MoverRow } from "@/lib/mock/reporting";

interface MoversTableProps {
  data: MoverRow[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

/** Trend analysis — slow vs fast movers. */
export function MoversTable({ data, isLoading, isError, onRetry }: MoversTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fast vs Slow Movers</CardTitle>
        <CardDescription>Category velocity and aging stock signal</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Units (30d)</TableHead>
              <TableHead className="text-right">Days of Stock</TableHead>
              <TableHead>Trend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={4} className="py-10">
                  <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
                    <p className="text-sm font-medium">
                      Couldn&apos;t load movement data.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The connection may have dropped. Check your network and try
                      again.
                    </p>
                    {onRetry ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={onRetry}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No movement data for this store yet — check back as stock sells.
                </TableCell>
              </TableRow>
            ) : (
              data.map((m) => (
              <TableRow key={m.category}>
                <TableCell className="font-medium">{m.category}</TableCell>
                <TableCell className="num text-right">{formatNumber(m.unitsSold)}</TableCell>
                <TableCell
                  className={cn(
                    "num text-right",
                    m.daysOfStock > 90 && "font-medium text-destructive",
                  )}
                >
                  {m.daysOfStock}
                </TableCell>
                <TableCell>
                  {m.trend === "fast" ? (
                    <Badge variant="success" className="gap-1">
                      <TrendingUp className="h-3 w-3" />
                      Fast
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="gap-1">
                      <TrendingDown className="h-3 w-3" />
                      Slow
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
