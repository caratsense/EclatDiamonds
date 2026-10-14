"use client";

import Link from "next/link";
import { ArrowLeft, CalendarRange } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ShiftsScheduleTab } from "@/components/hrms/shifts-schedule-tab";
import { TeamBalanceEditor } from "@/components/hrms/leave-balances";
import { useHolidays, useShifts } from "@/lib/queries/hrms";
import { useSession } from "@/store/use-session";

/**
 * Shifts & Schedule — the HR policy and configuration screen.
 *
 * This is where the settings that decide how a branch is MEASURED live: the
 * shift definitions and their grace minutes, the branch's weekly off, the
 * holidays, head office's attendance-rules confirmation (the switch that turns
 * automatic absence on), and head office's leave-balance corrections.
 *
 * It is a screen of its own, and not a tab beside the punch card, because that
 * is exactly where it was: somebody marking themselves present was two tabs
 * from the control that decides what "present" means for the whole branch. The
 * other screens' copy already sends people here by this name — "head office
 * declares them under Shifts & Schedule" — so the name is kept.
 *
 * Nothing is new. The panels are the ones the HRMS page already rendered, and
 * every write is the endpoint it always was; the server keeps shift and holiday
 * editing at store_manager+ and the rules confirmation at head office, so a
 * salesperson who opens this reads it and changes nothing.
 */
export default function HrSetupPage() {
  const role = useSession((s) => s.role);
  const isHeadOffice = role === "head_office";

  const shiftsQuery = useShifts();
  const holidaysQuery = useHolidays();
  const loading = shiftsQuery.isLoading || holidaysQuery.isLoading;
  const failed = shiftsQuery.isError || holidaysQuery.isError;

  return (
    <>
      <Link
        href="/hrms"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> HR &amp; Attendance
      </Link>

      <SectionHeader
        title="Shifts & Schedule"
        purpose="Shifts, weekly offs, holidays and the attendance rules each branch is measured against."
      />

      {/* Planning a particular week is the roster's job, not this screen's —
          said here so nobody plans a Tuesday off in two places. */}
      <div className="mb-4">
        <Button asChild variant="outline" size="sm">
          <Link href="/hrms/roster">
            <CalendarRange className="size-4" /> Plan a week on Roster &amp; Shifts
          </Link>
        </Button>
      </div>

      <div className="space-y-6">
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : failed ? (
          <Card>
            <CardContent className="space-y-3 py-8 text-center">
              <p className="text-sm font-medium">
                Couldn&apos;t load shifts &amp; schedule.
              </p>
              <p className="text-xs text-muted-foreground">
                The connection may have dropped. Check your network and try again.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  shiftsQuery.refetch();
                  holidaysQuery.refetch();
                }}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ShiftsScheduleTab
            shifts={shiftsQuery.data ?? []}
            holidays={holidaysQuery.data ?? []}
          />
        )}

        {/* Head office only, and the correction panel alone — not the
            self-service balances that sit above it on the Leave Tracker. */}
        {isHeadOffice ? <TeamBalanceEditor /> : null}
      </div>
    </>
  );
}
