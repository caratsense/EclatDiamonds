"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RosterGrid } from "@/components/hrms/roster-grid";
import { RosterHolidaysCard } from "@/components/hrms/roster-holidays-card";
import { RosterMySchedule } from "@/components/hrms/roster-my-schedule";
import { useHolidays } from "@/lib/queries/hrms";
import { todayYmd } from "@/lib/queries/hrms-roster";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Roster & Shifts (Module 6).
 *
 * Audience first, subject second — the same split as Leave Tracker and
 * Attendance: My Data | Team | Holidays across the top, the subject tabs under
 * whichever audience is chosen. A manager gets both halves and keeps a real
 * personal view, because a manager works a shift too. Before this there was
 * nowhere at all for a person to see their own week: every off endpoint is
 * manager-and-above, so the one whose Tuesday it was had no screen for it.
 *
 * The Team half is the primary place a week is planned. Roster & Pay keeps PAY —
 * payslips, runs, the month's figures — and its two off editors stay there for
 * planning a whole month in one pass. Both write the SAME rows through the same
 * endpoints, so the two screens cannot disagree about who is off.
 *
 * Nothing here is a security boundary. `GET /hrms/roster` is
 * @Roles('store_manager') and rolls up, so the Team tab is drawn for the roles
 * the server would actually answer; a salesperson is shown their own week
 * instead of a grid whose every cell would 403.
 */
export default function RosterPage() {
  const role = useSession((s) => s.role);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const [audience, setAudience] = useState(isManager ? "team" : "my");

  const holidays = useHolidays();
  // From today: a holiday that has already passed is not something anybody
  // plans around.
  const upcoming = useMemo(() => {
    const today = todayYmd();
    return (holidays.data ?? [])
      .filter((h) => h.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [holidays.data]);

  return (
    <>
      <Link
        href="/hrms"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> HRMS &amp; Attendance
      </Link>

      <SectionHeader
        title="Roster & Shifts"
        purpose="Plan the week by date — who is on which shift, and whose off falls where."
      />

      <Tabs value={audience} onValueChange={setAudience} className="space-y-4">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="my">My Data</TabsTrigger>
          {isManager ? <TabsTrigger value="team">Team</TabsTrigger> : null}
          <TabsTrigger value="holidays">Holidays</TabsTrigger>
        </TabsList>

        <TabsContent value="my" className="space-y-4">
          <RosterMySchedule />
        </TabsContent>

        {isManager ? (
          <TabsContent value="team">
            <RosterGrid />
          </TabsContent>
        ) : (
          <TabsContent value="team">
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                The branch roster is planned by your manager.
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="holidays">
          <RosterHolidaysCard
            holidays={upcoming}
            caption="The days the branch is shut, from today. Head office declares them under Shifts & Schedule."
            emptyText="No holiday is set for this branch yet."
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
