"use client";

import { DailyReportForm } from "@/components/reporting/daily-report-form";
import { DailyReportsTable } from "@/components/reporting/daily-reports-table";

/**
 * Module 10 — Daily Report (DSR) section. The store-close report managers used
 * to type on WhatsApp is now filed here: a grouped entry form with a live
 * WhatsApp-style preview, plus the list of recently submitted reports.
 */
export function DailyReportSection() {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
          Daily Report (DSR)
        </h2>
        <p className="text-sm text-muted-foreground">
          The store-close report, filed on the website instead of WhatsApp
        </p>
      </div>
      <DailyReportForm />
      <DailyReportsTable />
    </section>
  );
}
