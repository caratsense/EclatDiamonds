"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { KpiCard } from "@/components/dashboards/kpi-card";
import { PaymentPie } from "@/components/reporting/payment-pie";
import { StoreRevenueTable } from "@/components/reporting/store-revenue-table";
import { MoversTable } from "@/components/reporting/movers-table";
import { DsrPushCard } from "@/components/reporting/dsr-push-card";
import { PeriodRollup } from "@/components/reporting/period-rollup";
import { SendReportDialog } from "@/components/reporting/send-report-dialog";
import { DailyReportSection } from "@/components/reporting/daily-report-section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatINR, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import type { DsrResponse, ReportPeriod } from "@/lib/queries/reporting";
import { useDsr, useMovers } from "@/lib/queries/reporting";

/** Build a plain-text DSR summary from the data already on the page. */
function buildDsrSummary(dsr?: DsrResponse): string {
  if (!dsr) return "";
  const today = new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const find = (id: string) => dsr.headline.find((h) => h.id === id)?.value;
  const fmt = (id: string) => {
    const k = dsr.headline.find((h) => h.id === id);
    if (!k) return "—";
    return k.format === "inr" ? formatINR(k.value) : formatNumber(k.value);
  };

  const lines = [
    `Daily Sales Report — ${today}`,
    `Walk-ins: ${fmt("walkins")}`,
    `Bills generated: ${fmt("bills")}`,
    `Total sales: ${fmt("sales")}`,
  ];
  if (find("atv") != null) lines.push(`Avg. ticket value: ${fmt("atv")}`);

  if (dsr.storeRevenue.length > 0) {
    lines.push("", "Store-wise:");
    for (const s of dsr.storeRevenue) {
      lines.push(
        `• ${s.store}: ${formatINR(s.revenue)} (${formatNumber(s.bills)} bills, ${formatNumber(s.walkins)} walk-ins)`,
      );
    }
  }
  return lines.join("\n");
}

export default function ReportingPage() {
  const item = getNavItem("reporting");
  const [dsrOpen, setDsrOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [period, setPeriod] = useState<ReportPeriod>("daily");

  // DSR (headline + payment mix + store rows) and movers come live, store-scoped.
  const dsrQuery = useDsr();
  const moversQuery = useMovers();

  const headline = dsrQuery.data?.headline ?? [];
  const paymentSources = dsrQuery.data?.paymentSources ?? [];
  const storeRevenue = dsrQuery.data?.storeRevenue ?? [];
  const movers = moversQuery.data ?? [];

  const dsrSummary = useMemo(
    () => buildDsrSummary(dsrQuery.data),
    [dsrQuery.data],
  );

  return (
    <>
      <SectionHeader
        title="Reporting & Daily Sales Report (DSR)"
        purpose={item?.purpose ?? ""}
        primaryAction={item?.primaryAction}
        onPrimaryAction={() => setDsrOpen(true)}
      />

      <GenerateDsrDialog
        open={dsrOpen}
        onOpenChange={setDsrOpen}
        summary={dsrSummary}
        isLoading={dsrQuery.isLoading}
      />

      <PeriodRollup
        period={period}
        onPeriodChange={setPeriod}
        onSendReport={() => setSendOpen(true)}
      />

      <SendReportDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        initialPeriod={period}
      />

      <div className="my-6 h-px bg-gradient-to-r from-border via-border to-transparent" />

      <DailyReportSection />

      <div className="my-6 h-px bg-gradient-to-r from-border via-border to-transparent" />

      <h2 className="mb-4 font-display text-lg font-medium tracking-tight text-foreground">
        Today&apos;s DSR
      </h2>

      {dsrQuery.isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load today&apos;s DSR.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The connection may have dropped. Check your network and try again.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => dsrQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {dsrQuery.isLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 rounded-xl" />
                ))
              : headline.map((k) => (
                  <KpiCard
                    key={k.id}
                    label={k.label}
                    value={k.value}
                    format={k.format}
                    delta={k.delta}
                  />
                ))}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-1">
              {dsrQuery.isLoading ? (
                <Skeleton className="h-[340px] rounded-xl" />
              ) : (
                <PaymentPie data={paymentSources} />
              )}
            </div>
            <div className="lg:col-span-2">
              <StoreRevenueTable
                data={storeRevenue}
                isLoading={dsrQuery.isLoading}
              />
            </div>
          </div>
        </>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DsrPushCard />
        <MoversTable
          data={movers}
          isLoading={moversQuery.isLoading}
          isError={moversQuery.isError}
          onRetry={() => moversQuery.refetch()}
        />
      </div>
    </>
  );
}

function GenerateDsrDialog({
  open,
  onOpenChange,
  summary,
  isLoading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: string;
  isLoading: boolean;
}) {
  const [sending, setSending] = useState(false);

  async function sendToOwner() {
    if (!summary) {
      toast.error("No DSR data to send yet.");
      return;
    }
    setSending(true);
    try {
      await api.post("/integrations/whatsapp/send", {
        to: "9876500000",
        body: summary,
      });
      toast.success("DSR sent to owner's WhatsApp");
      onOpenChange(false);
    } catch {
      toast.error("Could not send the DSR.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Today&apos;s DSR</DialogTitle>
          <DialogDescription>
            Generated from today&apos;s figures. Send a copy to the owner over
            WhatsApp.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <Skeleton className="h-48 rounded-lg" />
        ) : summary ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed">
            {summary}
          </pre>
        ) : (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            No DSR data available yet.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={sendToOwner} disabled={sending || !summary}>
            {sending ? "Sending…" : "Send to owner"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
