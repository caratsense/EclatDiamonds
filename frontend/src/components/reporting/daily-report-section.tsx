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
  type DsrSheetPeriod,
} from "@/lib/queries/reporting";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Download the filed DSRs as the store's paper sheet — the day, its Mon–Sun
 * week or its month. One store per sheet, so on "All Stores" pick one.
 */
function DsrSheetDownload() {
  const { currentStore, stores } = useSession();
  const [pickedStoreId, setPickedStoreId] = useState("");
  const storeId = currentStore.isAggregate ? pickedStoreId : currentStore.id;
  const [period, setPeriod] = useState<DsrSheetPeriod>("day");
  const [date, setDate] = useState(todayLocal());
  const download = useDownloadDsrSheet();

  const onDownload = () =>
    download.mutate(
      { storeId, period, date },
      {
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not download the DSR sheet.")),
      },
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {currentStore.isAggregate ? (
        <Select value={storeId} onValueChange={setPickedStoreId}>
          <SelectTrigger className="h-9 w-40" aria-label="Store">
            <SelectValue placeholder="Choose a store" />
          </SelectTrigger>
          <SelectContent>
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
        onValueChange={(v) => setPeriod(v as DsrSheetPeriod)}
      >
        <SelectTrigger className="h-9 w-28" aria-label="Period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="day">Day</SelectItem>
          <SelectItem value="week">Week</SelectItem>
          <SelectItem value="month">Month</SelectItem>
        </SelectContent>
      </Select>
      <Input
        type="date"
        aria-label="Date"
        className="h-9 w-40"
        max={todayLocal()}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!storeId || !date || download.isPending}
        onClick={onDownload}
      >
        <Download className="h-4 w-4" />
        {download.isPending ? "Preparing…" : "Download sheet"}
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
            Type it once. Saved here, ready to send on WhatsApp
          </p>
        </div>
        <DsrSheetDownload />
      </div>
      <DailyReportForm />
      <DailyReportsTable />
    </section>
  );
}
