"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Send } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR, formatINRCompact, formatNumber } from "@/lib/format";
import type { DailyReport } from "@/lib/mock/reporting";
import { useDailyReports } from "@/lib/queries/reporting";
import { DailyReportSendDialog } from "@/components/reporting/daily-report-send-dialog";

/** yyyy-mm-dd -> "05 Jul 2026" (falls back to the raw value if unparsable). */
function dateLabel(iso: string): string {
  try {
    return format(parseISO(iso), "dd MMM yyyy");
  } catch {
    return iso;
  }
}

/** Recent filed DSRs with a View / Send action per row. */
export function DailyReportsTable() {
  const query = useDailyReports();
  const reports = query.data ?? [];
  const [selected, setSelected] = useState<DailyReport | null>(null);
  const [open, setOpen] = useState(false);

  function view(report: DailyReport) {
    setSelected(report);
    setOpen(true);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Submitted reports</CardTitle>
          <CardDescription>
            Recent store-close reports — view the full text or send it on
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Walk-ins</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Bookings</TableHead>
                <TableHead className="text-right">Advance</TableHead>
                <TableHead className="text-right">Cash</TableHead>
                <TableHead className="text-right">Card</TableHead>
                <TableHead className="text-right">UPI</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={10}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : query.isError ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center">
                    <p className="text-sm font-medium">
                      Couldn&apos;t load submitted reports.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => query.refetch()}
                    >
                      Retry
                    </Button>
                  </TableCell>
                </TableRow>
              ) : reports.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No reports filed yet. Fill the form above to file the first
                    one.
                  </TableCell>
                </TableRow>
              ) : (
                reports.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      {r.storeName ?? r.storeId}
                    </TableCell>
                    <TableCell className="num">{dateLabel(r.reportDate)}</TableCell>
                    <TableCell className="num text-right">
                      {formatNumber(r.walkIns)}
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {formatINR(r.deliveredBilled)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {formatINR(r.bookingsNew)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {formatINR(r.advanceReceived)}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {formatINRCompact(r.cash)}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {formatINRCompact(r.card)}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {formatINRCompact(r.upi)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => view(r)}
                      >
                        <Send className="h-3.5 w-3.5" />
                        View / Send
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <DailyReportSendDialog
        report={selected}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
