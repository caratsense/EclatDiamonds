"use client";

import { useState } from "react";
import { Download, Send } from "lucide-react";
import { toast } from "sonner";

import {
  DailyReportForm,
  todayLocal,
} from "@/components/reporting/daily-report-form";
import { DailyReportsTable } from "@/components/reporting/daily-reports-table";
import { DsrSheetSendDialog } from "@/components/reporting/dsr-sheet-send-dialog";
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

/**
 * Download or send the filed DSRs as the store's paper sheet — the day, its
 * Mon–Sun week or its month, to print (PDF) or to work on (Excel). One store
 * per sheet, so on "All Stores" pick one.
 */
function DsrSheetDownload() {
  const { currentStore, stores } = useSession();
  const [pickedStoreId, setPickedStoreId] = useState("");
  const storeId = currentStore.isAggregate ? pickedStoreId : currentStore.id;
  const [period, setPeriod] = useState<DsrSheetPeriod>("day");
  const [date, setDate] = useState(todayLocal());
  const [format, setFormat] = useState<DsrSheetFormat>("xlsx");
  const [sending, setSending] = useState(false);
  const download = useDownloadDsrSheet();

  const onDownload = () =>
    download.mutate(
      { storeId, period, date, format },
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
        disabled={!storeId || !date || download.isPending}
        onClick={onDownload}
      >
        <Download className="h-4 w-4" />
        {download.isPending ? "Preparing…" : "Download"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!storeId || !date}
        onClick={() => setSending(true)}
      >
        <Send className="h-4 w-4" />
        Send
      </Button>
      <DsrSheetSendDialog
        sheet={{ storeId, period, date, format }}
        open={sending}
        onOpenChange={setSending}
      />
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
