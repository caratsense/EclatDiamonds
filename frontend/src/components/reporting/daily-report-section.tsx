"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import {
  DailyReportForm,
  todayLocal,
} from "@/components/reporting/daily-report-form";
import { DailyReportsTable } from "@/components/reporting/daily-reports-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDownloadDsrSheet,
  type DsrSheetFormat,
  type DsrSheetPeriod,
} from "@/lib/queries/reporting";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const ALL = "__all__";

/**
 * Download the filed DSRs as the store's paper sheet — the day, its Mon–Sun
 * week, its month, or an arbitrary from–to range. A single store per sheet in
 * the fixed periods; the RANGE consolidates — one column per store with a
 * Total — which is the head-office ask (client, 8 Oct): "the consolidated DSR
 * from this to this date", in PDF or Excel.
 */
function DsrSheetDownload() {
  const { currentStore, stores } = useSession();
  const [pickedStoreId, setPickedStoreId] = useState("");
  const storeId = currentStore.isAggregate ? pickedStoreId : currentStore.id;
  const [period, setPeriod] = useState<DsrSheetPeriod | "range">("day");
  const [date, setDate] = useState(todayLocal());
  const [toDate, setToDate] = useState(todayLocal());
  const [format, setFormat] = useState<DsrSheetFormat>("xlsx");
  const download = useDownloadDsrSheet();

  const isRange = period === "range";
  const ready = isRange
    ? Boolean(date && toDate)
    : Boolean(storeId && storeId !== ALL && date);

  const onDownload = () =>
    download.mutate(
      isRange
        ? {
            format,
            fromDate: date,
            toDate,
            ...(storeId && storeId !== ALL ? { storeId } : {}),
          }
        : { storeId, period: period as DsrSheetPeriod, date, format },
      {
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not download the DSR sheet.")),
      },
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {currentStore.isAggregate ? (
        <Select value={storeId || undefined} onValueChange={setPickedStoreId}>
          <SelectTrigger className="h-9 w-40" aria-label="Store">
            <SelectValue placeholder="Choose a store" />
          </SelectTrigger>
          <SelectContent>
            {/* The consolidated range is the only mode that spans stores. */}
            {isRange ? <SelectItem value={ALL}>All stores</SelectItem> : null}
            {stores
              .filter((s) => !s.isAggregate)
              .map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ) : null}
      <Select
        value={period}
        onValueChange={(v) => {
          setPeriod(v as DsrSheetPeriod | "range");
          // Leaving range mode with "All stores" picked would arm a Download
          // the fixed periods must refuse; clearing beats a dead button.
          if (v !== "range" && pickedStoreId === ALL) setPickedStoreId("");
        }}
      >
        <SelectTrigger className="h-9 w-32" aria-label="Period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="day">Day</SelectItem>
          <SelectItem value="week">Week</SelectItem>
          <SelectItem value="month">Month</SelectItem>
          <SelectItem value="range">Date range</SelectItem>
        </SelectContent>
      </Select>
      <Input
        type="date"
        aria-label={isRange ? "From date" : "Date"}
        className="h-9 w-40"
        max={todayLocal()}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      {isRange ? (
        <>
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="To date"
            className="h-9 w-40"
            min={date || undefined}
            max={todayLocal()}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </>
      ) : null}
      <Select
        value={format}
        onValueChange={(v) => setFormat(v as DsrSheetFormat)}
      >
        <SelectTrigger className="h-9 w-28" aria-label="Format">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="xlsx">Excel</SelectItem>
          <SelectItem value="pdf">PDF</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready || download.isPending}
        onClick={onDownload}
      >
        <Download className="h-4 w-4" />
        {download.isPending ? "Preparing…" : "Download"}
      </Button>
    </div>
  );
}

/**
 * Module 10 — Daily Report (DSR) section. The store-close report managers used
 * to type on WhatsApp is now filed here: a grouped entry form with a live
 * WhatsApp-style preview, plus the list of recently submitted reports.
 */
export function DailyReportSection() {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
            Daily Report (DSR)
          </h2>
          <p className="text-sm text-muted-foreground">
            Type it once. Head office reads every store’s evening digest.
          </p>
        </div>
        <DsrSheetDownload />
      </div>
      <DailyReportForm />
      <DailyReportsTable />
    </section>
  );
}
