"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApplyLeaveDialog } from "@/components/hrms/apply-leave-dialog";
import { LeaveHolidaysPanel } from "@/components/hrms/leave-holidays";
import { MyLeaveRequestsPanel } from "@/components/hrms/leave-my-requests";
import {
  LeaveSummaryCards,
  UpcomingLeaveLine,
  useLeaveFinancialYear,
} from "@/components/hrms/leave-summary";
import { TeamLeaveRequestsPanel } from "@/components/hrms/leave-team-requests";
import { useLeaveRequests } from "@/lib/queries/hrms";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Leave Tracker (Module 6).
 *
 * The page is split by AUDIENCE first and subject second, which is the split
 * the client asked for after the Zoho People walkthrough: My Data | Team |
 * Holidays across the top, the subject tabs for whichever audience is chosen
 * underneath, then one summary row, one filter bar, and the list.
 *
 * A manager gets BOTH halves and a real personal view — that is the whole point
 * of the split. Before this, leave lived inside the HRMS tab strip, where a
 * store manager's own balances sat in the same panel as their team's approvals
 * and their own request was something they appeared able to sign off themselves.
 *
 * Only the TEAM half is role-gated, and the gate matches the server's: the
 * decision route is store_manager and above, and the hierarchy rolls up, so an
 * area manager and head office see it and a salesperson or marketing user does
 * not. Nothing here is a security boundary — the API refuses regardless — but a
 * tab whose every row 403s reads as a broken product.
 */
export default function LeaveTrackerPage() {
  const role = useSession((s) => s.role);
  const userId = useSession((s) => s.user.id);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const [applyOpen, setApplyOpen] = useState(false);
  const fyLabel = useLeaveFinancialYear();

  // The Team tab's badge, read off the list the Team panel already loads —
  // somebody else's request, still waiting. The panel itself decides who may
  // actually decide each one.
  const { data: requests = [] } = useLeaveRequests();
  const waiting = useMemo(
    () =>
      isManager
        ? requests.filter((r) => r.status === "pending" && r.staffId !== userId).length
        : 0,
    [requests, isManager, userId],
  );

  return (
    <>
      <Link
        href="/hrms"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> HRMS &amp; Attendance
      </Link>

      <SectionHeader
        title="Leave Tracker"
        purpose="Your balances and requests, and — for a manager — the team's, decided one rank above the person who asked."
        primaryAction="Apply for Leave"
        onPrimaryAction={() => setApplyOpen(true)}
      />

      {/* Audience first: who this screen is about. */}
      <Tabs defaultValue="my" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="my">My Data</TabsTrigger>
          {isManager ? (
            <TabsTrigger value="team" className="gap-1.5">
              Team
              {waiting > 0 ? (
                <span
                  className="num rounded-full bg-destructive px-1.5 text-[11px] leading-5 text-destructive-foreground"
                  aria-label={`${waiting} waiting on a decision`}
                >
                  {waiting}
                </span>
              ) : null}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="holidays">Holidays</TabsTrigger>
        </TabsList>

        <TabsContent value="my">
          {/* Subject second, scoped to the audience above. */}
          <Tabs defaultValue="summary" className="space-y-3">
            <SubTabsList>
              <SubTab value="summary">Leave Summary</SubTab>
              <SubTab value="requests">Leave Requests</SubTab>
            </SubTabsList>

            <TabsContent value="summary">
              <Card>
                <CardContent className="space-y-4 p-4">
                  <div>
                    <h2 className="text-sm font-medium">
                      My leave balances{fyLabel ? ` · FY ${fyLabel}` : ""}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Allocations reset in April, with the financial year.
                    </p>
                  </div>
                  <LeaveSummaryCards />
                  <UpcomingLeaveLine />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="requests">
              <Card>
                <CardContent className="space-y-3 p-4">
                  <div>
                    <h2 className="text-sm font-medium">My leave requests</h2>
                    <p className="text-xs text-muted-foreground">
                      Every request you have made, including the ones you withdrew.
                    </p>
                  </div>
                  <MyLeaveRequestsPanel />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>

        {isManager ? (
          <TabsContent value="team">
            <Tabs defaultValue="requests" className="space-y-3">
              <SubTabsList>
                <SubTab value="requests">Leave Requests</SubTab>
              </SubTabsList>

              <TabsContent value="requests">
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <div>
                      <h2 className="text-sm font-medium">Team leave requests</h2>
                      <p className="text-xs text-muted-foreground">
                        Waiting first. Review a row to see the reason and what approving it does
                        to that person&rsquo;s balance.
                      </p>
                    </div>
                    <TeamLeaveRequestsPanel />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </TabsContent>
        ) : null}

        <TabsContent value="holidays">
          <Card>
            <CardContent className="space-y-3 p-4">
              <div>
                <h2 className="text-sm font-medium">Holidays</h2>
                <p className="text-xs text-muted-foreground">
                  Declared by head office under Shifts &amp; Schedule.
                </p>
              </div>
              <LeaveHolidaysPanel />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ApplyLeaveDialog open={applyOpen} onOpenChange={setApplyOpen} />
    </>
  );
}

/**
 * The second tab level, styled DOWN from the first.
 *
 * Two identical tab strips stacked on each other read as one confused strip, so
 * the subject tabs lose the segmented background and keep only an underline for
 * the active one.
 */
function SubTabsList({ children }: { children: React.ReactNode }) {
  return (
    <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 rounded-none border-b bg-transparent p-0">
      {children}
    </TabsList>
  );
}

function SubTab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="rounded-none border-b-2 border-transparent px-3 pb-2 pt-1 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}
