"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnalyticsTab } from "@/components/hrms/analytics-tab";
import { AttendanceReportsTab } from "@/components/hrms/attendance-reports-tab";
import { LateFlagsTab } from "@/components/hrms/late-flags-tab";
import { useLateFlags } from "@/lib/queries/hrms";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * HR Reports (Module 6) — the fourth HR module, on its own route.
 *
 * It was the HRMS page's "Reports" tab plus its "Late flags" tab, two tabs
 * apart from each other although both answer the same question: how did the
 * month go. Nothing in here is new; the panels are the ones that were already
 * built, reading the same endpoints with the same figures.
 *
 * There is no audience toggle, unlike the three sibling modules: every report
 * here is about a team. A person's own month is the Attendance module's My Data
 * half, which is where someone goes to check their own figures.
 */
export default function HrReportsPage() {
  const role = useSession((s) => s.role);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  // Current month key (YYYY-MM) for the late-flag roll-up.
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const lateFlags = useLateFlags(month, { enabled: isManager });

  return (
    <>
      <Link
        href="/hrms"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> HR &amp; Attendance
      </Link>

      <SectionHeader
        title="HR Reports"
        purpose="The month in figures — presence, lateness, overtime and the register as an export."
      />

      {!isManager ? (
        /* The register, the report and the analytics controller behind this
           screen are @Roles('store_manager') and roll up, so a front-line
           staffer is told where their own figures are rather than shown panels
           that would 403. */
        <Card>
          <CardContent className="space-y-3 py-10 text-center text-sm text-muted-foreground">
            <p>HR reports cover a whole team, so they are a manager&rsquo;s view.</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/hrms/attendance">See my own month</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="register">Attendance report</TabsTrigger>
            <TabsTrigger value="flags">Late flags</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <AnalyticsTab />
          </TabsContent>

          <TabsContent value="register">
            <AttendanceReportsTab />
          </TabsContent>

          <TabsContent value="flags">
            {lateFlags.isLoading ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : lateFlags.isError ? (
              <Card>
                <CardContent className="space-y-3 py-8 text-center">
                  <p className="text-sm font-medium">Couldn&apos;t load late flags.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => lateFlags.refetch()}
                  >
                    Retry
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <LateFlagsTab rows={lateFlags.data ?? []} month={month} />
            )}
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
