"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR } from "@/lib/format";
import type { LedgerEntry } from "@/lib/mock/finance";

const STATUS_META: Record<
  string,
  { label: string; variant: "secondary" | "success" | "destructive" | "outline" }
> = {
  open: { label: "Open", variant: "outline" },
  partial: { label: "Partial", variant: "secondary" },
  cleared: { label: "Cleared", variant: "success" },
  overdue: { label: "Overdue", variant: "destructive" },
};

interface LedgerTableProps {
  data: LedgerEntry[];
  isLoading?: boolean;
}

/** General-ledger style AP/AR register. */
export function LedgerTable({ data, isLoading }: LedgerTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>General Ledger — AP / AR</CardTitle>
        <CardDescription>Recent receivables and payables across stores</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ref</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Store</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No ledger entries for this store yet.
                </TableCell>
              </TableRow>
            ) : (
              data.map((e) => {
              const status = STATUS_META[e.status] ?? {
                label: e.status,
                variant: "outline" as const,
              };
              return (
                <TableRow key={e.key ?? e.id}>
                  <TableCell className="font-medium">
                    <span className="num">{e.id}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{e.date}</TableCell>
                  <TableCell>{e.account}</TableCell>
                  <TableCell className="text-muted-foreground">{e.party}</TableCell>
                  <TableCell>{e.store}</TableCell>
                  <TableCell>
                    <Badge variant={e.type === "AR" ? "secondary" : "outline"}>{e.type}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {e.debit ? <span className="num">{formatINR(e.debit)}</span> : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {e.credit ? <span className="num">{formatINR(e.credit)}</span> : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </TableCell>
                </TableRow>
              );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
