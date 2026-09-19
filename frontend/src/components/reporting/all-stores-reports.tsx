"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Check, Minus, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DailyReportSendDialog } from "@/components/reporting/daily-report-send-dialog";
import { formatINR, formatNumber } from "@/lib/format";
import type { DailyReport } from "@/lib/mock/reporting";
import { useDailyReports, useDsrCompliance } from "@/lib/queries/reporting";
import { cn } from "@/lib/utils";

const via = (source?: string | null) => (source === "whatsapp" ? "WhatsApp" : "App");
const day = (iso: string) => format(parseISO(iso), "EEE d MMM");

/**
 * Every branch's DSR for one day, side by side, however it was filed (the app
 * or the WhatsApp bot). Head office reads the three parts each store reports —
 * footfall, the counter sale and the customised sale — and sees at a glance who
 * has not filed.
 */
export function AllStoresReports() {
  const compliance = useDsrCompliance(7);
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? compliance.data?.to ?? null;
  const reports = useDailyReports(date ?? undefined);
  const [open, setOpen] = useState<DailyReport | null>(null);

  const stores = compliance.data?.stores ?? [];
  const dates = stores[0]?.entries.map((e) => e.date) ?? [];
  const byStore = new Map((reports.data ?? []).map((r) => [r.storeId, r]));
  const filed = stores.filter((s) => byStore.has(s.storeId));
  const sum = (f: (r: DailyReport) => number) => filed.reduce((t, s) => t + f(byStore.get(s.storeId)!), 0);

  if (compliance.isLoading) return <Skeleton className="h-72 w-full rounded-xl" />;
  if (!stores.length) {
    return <p className="text-sm text-muted-foreground">No branches in your scope file a DSR.</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Who filed, last 7 days</CardTitle>
          <CardDescription>Tap a day to open every branch&apos;s report for it.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                {dates.map((d) => (
                  <TableHead key={d} className="text-center">
                    <button
                      type="button"
                      onClick={() => setPicked(d)}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs",
                        d === date ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                      )}
                    >
                      {day(d)}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((s) => (
                <TableRow key={s.storeId}>
                  <TableCell className="whitespace-nowrap font-medium">{s.storeName}</TableCell>
                  {s.entries.map((e) => (
                    <TableCell key={e.date} className="text-center">
                      {e.submitted ? (
                        <span
                          title={`Filed via ${via(e.source)}`}
                          className="inline-flex items-center gap-0.5 text-xs text-[var(--success)]"
                        >
                          <Check className="h-3.5 w-3.5" />
                          {e.source === "whatsapp" ? "WA" : "App"}
                        </span>
                      ) : (
                        <Minus className="mx-auto h-3.5 w-3.5 text-muted-foreground/60" aria-label="Not filed" />
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {date ? day(date) : "—"} · {filed.length} of {stores.length} branches filed
          </CardTitle>
          <CardDescription>
            Footfall, the counter sale (Table A) and the customised sale (Table B), per branch.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {reports.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead>Filed</TableHead>
                  <TableHead className="text-right">Walk-ins</TableHead>
                  <TableHead className="text-right">Serious</TableHead>
                  <TableHead className="text-right">Bought</TableHead>
                  <TableHead className="text-right">Counter sale</TableHead>
                  <TableHead className="text-right">Booked (custom)</TableHead>
                  <TableHead className="text-right">Advance</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {stores.map((s) => {
                  const r = byStore.get(s.storeId);
                  return (
                    <TableRow key={s.storeId} className={r ? undefined : "text-muted-foreground"}>
                      <TableCell className="whitespace-nowrap font-medium text-foreground">{s.storeName}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r ? (
                          <Badge variant="outline" className="font-normal">
                            {via(r.source)}
                            {r.reportTime ? ` · ${r.reportTime}` : ""}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="font-normal">
                            Not filed
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="num text-right">{r ? formatNumber(r.walkIns) : "—"}</TableCell>
                      <TableCell className="num text-right">{r ? formatNumber(r.seriousEnquiries) : "—"}</TableCell>
                      <TableCell className="num text-right">{r ? formatNumber(r.conversions ?? 0) : "—"}</TableCell>
                      <TableCell className="num text-right font-medium">{r ? formatINR(r.deliveredBilled) : "—"}</TableCell>
                      <TableCell className="num text-right">{r ? formatINR(r.bookingsNew) : "—"}</TableCell>
                      <TableCell className="num text-right">{r ? formatINR(r.advanceReceived) : "—"}</TableCell>
                      <TableCell className="text-right">
                        {r ? (
                          <Button variant="outline" size="sm" onClick={() => setOpen(r)}>
                            <Send className="h-3.5 w-3.5" />
                            View
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {filed.length > 1 ? (
                  <TableRow className="font-semibold">
                    <TableCell>All branches</TableCell>
                    <TableCell />
                    <TableCell className="num text-right">{formatNumber(sum((r) => r.walkIns))}</TableCell>
                    <TableCell className="num text-right">{formatNumber(sum((r) => r.seriousEnquiries))}</TableCell>
                    <TableCell className="num text-right">{formatNumber(sum((r) => r.conversions ?? 0))}</TableCell>
                    <TableCell className="num text-right">{formatINR(sum((r) => r.deliveredBilled))}</TableCell>
                    <TableCell className="num text-right">{formatINR(sum((r) => r.bookingsNew))}</TableCell>
                    <TableCell className="num text-right">{formatINR(sum((r) => r.advanceReceived))}</TableCell>
                    <TableCell />
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <DailyReportSendDialog report={open} open={open !== null} onOpenChange={(o) => (o ? null : setOpen(null))} />
    </div>
  );
}
