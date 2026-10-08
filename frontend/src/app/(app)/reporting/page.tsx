"use client";

import { useMemo, useState } from "react";

import { SectionHeader } from "@/components/section/section-header";
import { KpiCard } from "@/components/dashboards/kpi-card";
import { PaymentPie } from "@/components/reporting/payment-pie";
import { StoreRevenueTable } from "@/components/reporting/store-revenue-table";
import { MoversTable } from "@/components/reporting/movers-table";
import { PeriodRollup } from "@/components/reporting/period-rollup";
import { DailyReportSection } from "@/components/reporting/daily-report-section";
import { DsrDigestCard } from "@/components/reporting/dsr-digest-card";
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
import { Skeleton } from "@/components/ui/skeleton";
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
      <PeriodRollup period={period} onPeriodChange={setPeriod} />

      <div className="my-6 h-px bg-gradient-to-r from-border via-border to-transparent" />

      <DailyReportSection />

      {role === "head_office" ? (
        <div className="mt-6">
          <DsrDigestCard />
        </div>
      ) : null}

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
        // The preview shows the consolidated message the evening digest sends,
        // which only head office receives — a store manager has no use for it,
        // and their own figures are already on the page below.
        primaryAction={role === "head_office" ? item?.primaryAction : undefined}
        onPrimaryAction={() => setDsrOpen(true)}
      />

      {role === "head_office" ? (
        <GenerateDsrDialog
          open={dsrOpen}
          onOpenChange={setDsrOpen}
          summary={dsrSummary}
          isLoading={dsrQuery.isLoading}
        />
      ) : null}

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

/**
 * Preview only, head office only.
 *
 * This dialog used to carry a "Recipient WhatsApp number" box and a Send
 * button — any manager could text the day's takings to any number they typed.
 * Delivery now has exactly one route: the evening digest, which sends ONE
 * consolidated message to head office on a schedule. So the send machinery is
 * gone, and what remains is a preview of that message for the people who will
 * receive it.
 */
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Today&apos;s DSR</DialogTitle>
          <DialogDescription>
            Generated from today&apos;s figures — what the evening digest sends
            to head office.
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
