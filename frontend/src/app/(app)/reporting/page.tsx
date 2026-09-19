"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { KpiCard } from "@/components/dashboards/kpi-card";
import { PaymentPie } from "@/components/reporting/payment-pie";
import { StoreRevenueTable } from "@/components/reporting/store-revenue-table";
import { MoversTable } from "@/components/reporting/movers-table";
import { PeriodRollup } from "@/components/reporting/period-rollup";
import { SendReportDialog } from "@/components/reporting/send-report-dialog";
import { DailyReportSection } from "@/components/reporting/daily-report-section";
import { AllStoresReports } from "@/components/reporting/all-stores-reports";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/store/use-session";
import { ROLE_RANK } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatINR, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import type { DsrResponse, ReportPeriod } from "@/lib/queries/reporting";
import { useDsr, useMovers } from "@/lib/queries/reporting";
import { ChannelStatusNotice } from "@/components/integrations/channel-status-notice";

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

/** Where each DSR headline tile drills to when tapped. */
function dsrKpiHref(id: string): string | undefined {
  switch (id) {
    case "sales":
    case "bills":
    case "atv":
      return "/sales-performance";
    case "walkins":
      return "/checkins";
    default:
      return undefined;
  }
}

/**
 * A salesperson files the day's DSR and sees what their store filed; the
 * analytics and cross-branch views are management's (and 403 for them).
 */
export default function ReportingPage() {
  const role = useSession((s) => s.role);
  return ROLE_RANK[role] < ROLE_RANK.store_manager ? <FrontLineReporting /> : <ManagerReporting />;
}

function FrontLineReporting() {
  const item = getNavItem("reporting");
  return (
    <>
      <SectionHeader title="Daily Sales Report (DSR)" purpose={item?.purpose ?? ""} />
      <DailyReportSection />
    </>
  );
}

function ManagerReporting() {
  const item = getNavItem("reporting");
  const [dsrOpen, setDsrOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [period, setPeriod] = useState<ReportPeriod>("daily");
  // Head office, or anyone who sees more than one branch, reads them side by side.
  const { role, stores } = useSession();
  const showAllStores =
    role === "head_office" || stores.filter((st) => !st.isAggregate).length > 1;

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

  const overview = (
    <>
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

      <h2 className="mb-4 font-display text-lg font-bold tracking-tight text-foreground">
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
                    href={dsrKpiHref(k.id)}
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
                basis={dsrQuery.data?.basis}
                isLoading={dsrQuery.isLoading}
              />
            </div>
          </div>
        </>
      )}

      <div className="mt-4">
        <MoversTable
          data={movers}
          isLoading={moversQuery.isLoading}
          isError={moversQuery.isError}
          onRetry={() => moversQuery.refetch()}
        />
      </div>
    </>
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

      {showAllStores ? (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">This view</TabsTrigger>
            <TabsTrigger value="stores">All stores reports</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">{overview}</TabsContent>
          <TabsContent value="stores">
            <AllStoresReports />
          </TabsContent>
        </Tabs>
      ) : (
        overview
      )}
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
  // The recipient is entered/confirmed by the user rather than hardcoded.
  const [recipient, setRecipient] = useState("");

  async function sendToOwner() {
    if (!summary) {
      toast.error("No DSR data to send yet.");
      return;
    }
    const to = recipient.trim();
    if (!to) {
      toast.error("Enter the recipient's WhatsApp number.");
      return;
    }
    setSending(true);
    try {
      // The API answers 200 even when WhatsApp is not connected — the send is a
      // logged no-op in that case. Claiming "sent" off the status code alone told
      // a manager their owner had the day's takings when nothing had left the
      // building, so read the result and say which of the two happened.
      const { data } = await api.post<{ delivered: boolean; dryRun?: boolean }>(
        "/integrations/whatsapp/send",
        { to, body: summary },
      );
      if (data?.delivered) {
        toast.success("DSR sent over WhatsApp");
        onOpenChange(false);
      } else if (data?.dryRun) {
        toast.warning("WhatsApp is not connected yet — the DSR was NOT sent.", {
          description:
            "Copy the text and send it by hand for now. Ask your administrator to connect WhatsApp.",
          duration: 8000,
        });
      } else {
        toast.error("WhatsApp rejected the message — the DSR was not sent.");
      }
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
        <ChannelStatusNotice channel="whatsapp" />
        <div className="grid gap-1.5">
          <Label htmlFor="dsr-recipient">Recipient WhatsApp number</Label>
          <Input
            id="dsr-recipient"
            type="tel"
            inputMode="numeric"
            placeholder="e.g. 9876543210"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={sendToOwner}
            disabled={sending || !summary || !recipient.trim()}
          >
            {sending ? "Sending…" : "Send DSR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
