"use client";

import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getNavItem } from "@/lib/navigation";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { LeaderboardTab } from "@/components/hrms/leaderboard-tab";
import { EditableCommissionTab } from "@/components/hrms/editable-commission-tab";
import { useCommission, useLeaderboard } from "@/lib/queries/hrms";

/**
 * Sales → Sales Performance (Module 6, moved off HRMS in round-2). Leaderboard +
 * commission are sales artifacts, not HR. Store-scoped + role-aware: commission
 * rates are editable only for store_manager and above.
 */
export default function SalesPerformancePage() {
  const nav = getNavItem("sales-performance");
  const { role } = useSession();
  const canEditRates = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const leaderboardQuery = useLeaderboard();
  const commissionQuery = useCommission();
  const { data: leaderboard = [], isLoading: lbLoading } = leaderboardQuery;
  const { data: commissions = [], isLoading: commLoading } = commissionQuery;

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Sales Performance"}
        purpose={nav?.purpose ?? ""}
      />

      <Tabs defaultValue="leaderboard" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
          <TabsTrigger value="incentives">Incentives &amp; Commission</TabsTrigger>
        </TabsList>

        <TabsContent value="leaderboard">
          {lbLoading ? (
            <TabSkeleton />
          ) : leaderboardQuery.isError ? (
            <TabError
              what="the leaderboard"
              onRetry={() => leaderboardQuery.refetch()}
            />
          ) : (
            <LeaderboardTab rows={leaderboard} />
          )}
        </TabsContent>

        <TabsContent value="incentives">
          {commLoading ? (
            <TabSkeleton />
          ) : commissionQuery.isError ? (
            <TabError
              what="commission figures"
              onRetry={() => commissionQuery.refetch()}
            />
          ) : (
            <EditableCommissionTab rows={commissions} canEdit={canEditRates} />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function TabError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
      <p className="text-sm font-medium">Couldn&apos;t load {what}.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        The connection may have dropped. Check your network and try again.
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function TabSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
