"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Download, Eye, FileDown } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR, formatINRCompact, formatNumber } from "@/lib/format";
import type { DailyReport } from "@/lib/mock/reporting";
import {
  useDailyReports,
  useDownloadDsrSheet,
  type DsrSheetFormat,
} from "@/lib/queries/reporting";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";
import { DailyReportViewDialog } from "@/components/reporting/daily-report-view-dialog";

/** yyyy-mm-dd -> "05 Jul 2026" (falls back to the raw value if unparsable). */
function dateLabel(iso: string): string {
  try {
    return format(parseISO(iso), "dd MMM yyyy");
  } catch {
    return iso;
  }
}

const ALL_STORES = "__all__";

/**
 * Recent filed DSRs, each readable in full and downloadable as that day's
 * sheet. Nothing here sends — delivery is the head-office digest.
 *
 * The date filter narrows the LIST (it travels to the server, which returns
 * that day across the viewer's scope); the store filter narrows what is shown
 * (the rows are already loaded, so it costs nothing). Both empty = recent.
 */
export function DailyReportsTable() {
  const stores = useSession((s) => s.stores);
  const realStores = stores.filter((s) => !s.isAggregate);
  const [date, setDate] = useState("");
  const [storeFilter, setStoreFilter] = useState(ALL_STORES);
  const query = useDailyReports(date || undefined);
  const reports = (query.data ?? []).filter(
    (r) => storeFilter === ALL_STORES || r.storeId === storeFilter,
  );
  const [selected, setSelected] = useState<DailyReport | null>(null);
  const [open, setOpen] = useState(false);
  // One download at a time, named by row, so the spinner sits on the right row.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const download = useDownloadDsrSheet();

  // The consolidated from–to download (client, 8 Oct): a button beside the
  // filters opens a dialog asking the store, the range and the format, so the
  // card header stays a header. All stores = one column per store plus a
  // Total; one store = that branch summed over the range.
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeStore, setRangeStore] = useState(ALL_STORES);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [rangeFormat, setRangeFormat] = useState<DsrSheetFormat>("pdf");
  const [rangeBusy, setRangeBusy] = useState(false);

  function downloadRange() {
    setRangeBusy(true);
    download.mutate(
      {
        fromDate,
        toDate,
        format: rangeFormat,
        ...(rangeStore !== ALL_STORES ? { storeId: rangeStore } : {}),
      },
      {
        onSuccess: () => setRangeOpen(false),
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not download the consolidated report.")),
        onSettled: () => setRangeBusy(false),
      },
    );
  }

  function view(report: DailyReport) {
    setSelected(report);
    setOpen(true);
  }

  function downloadPdf(report: DailyReport) {
    setDownloadingId(report.id);
    download.mutate(
      {
        storeId: report.storeId,
        period: "day",
        date: report.reportDate,
        format: "pdf",
      },
      {
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not download the report PDF.")),
        onSettled: () => setDownloadingId(null),
      },
    );
  }

  const filtering = Boolean(date) || storeFilter !== ALL_STORES;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Submitted reports</CardTitle>
              <CardDescription>
                Recent store-close reports — open any to read the full text,
                save a row as PDF, or download the whole range consolidated
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={storeFilter} onValueChange={setStoreFilter}>
                <SelectTrigger className="h-9 w-44" aria-label="Filter by store">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_STORES}>All stores</SelectItem>
                  {realStores.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="date"
                aria-label="Filter by date"
                className="h-9 w-40"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              {filtering ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    setDate("");
                    setStoreFilter(ALL_STORES);
                  }}
                >
                  Clear
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => {
                  // The dialog opens on whatever the card is filtered to.
                  setRangeStore(storeFilter);
                  setRangeOpen(true);
                }}
              >
                <Download className="h-4 w-4" />
                Download reports
              </Button>
            </div>
          </div>
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
                    {filtering
                      ? "No report matches these filters."
                      : "No reports filed yet. Fill the form above to file the first one."}
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
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => view(r)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={downloadingId === r.id}
                          title="Download this report as PDF"
                          onClick={() => downloadPdf(r)}
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          {downloadingId === r.id ? "…" : "PDF"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <DailyReportViewDialog
        report={selected}
        open={open}
        onOpenChange={setOpen}
      />

      {/* The consolidated download: which stores, from when to when, what file. */}
      <Dialog open={rangeOpen} onOpenChange={setRangeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Download reports</DialogTitle>
            <DialogDescription>
              One consolidated file over the dates you pick — every store as its
              own column with a total, or a single store summed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Stores</Label>
              <Select value={rangeStore} onValueChange={setRangeStore}>
                <SelectTrigger aria-label="Stores">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_STORES}>All stores</SelectItem>
                  {realStores.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="dsr-range-from">From</Label>
                <Input
                  id="dsr-range-from"
                  type="date"
                  max={toDate || undefined}
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="dsr-range-to">To</Label>
                <Input
                  id="dsr-range-to"
                  type="date"
                  min={fromDate || undefined}
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Format</Label>
              <Select
                value={rangeFormat}
                onValueChange={(v) => setRangeFormat(v as DsrSheetFormat)}
              >
                <SelectTrigger aria-label="Format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pdf">PDF</SelectItem>
                  <SelectItem value="xlsx">Excel</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              Up to 92 days at a time — a full quarter in one file.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRangeOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!fromDate || !toDate || rangeBusy}
              onClick={downloadRange}
            >
              <Download className="h-4 w-4" />
              {rangeBusy ? "Preparing…" : "Download"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
