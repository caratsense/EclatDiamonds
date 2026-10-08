"use client";

import { useState } from "react";

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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getNavItem } from "@/lib/navigation";
import type { ReportPeriod } from "@/lib/queries/reporting";
import { useDsr, useMovers } from "@/lib/queries/reporting";

/** Where a headline KPI tile links: the screen that explains its number. */
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
        // Filing is the page's one action (client, 8 Oct) — the old button
        // previewed the digest text, which the digest already delivers. This
        // one takes you to the form.
        primaryAction={item?.primaryAction}
        onPrimaryAction={() =>
          document
            .getElementById("file-dsr")
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
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

