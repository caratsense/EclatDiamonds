"use client";

import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveBalance,
} from "@/lib/mock/hrms";
import { useLeaveBalances, useLeaveRequests } from "@/lib/queries/hrms";
import { useSession } from "@/store/use-session";
import {
  LEAVE_STATUS_BADGE,
  durationLabel,
  isPaidLeaveType,
} from "@/components/hrms/leave-policy";
import { leaveRange } from "@/components/hrms/leave-request-detail";

/**
 * The leave summary: one restrained card per leave type, with the three figures
 * the employee is owed an answer on — AVAILABLE, USED and PENDING.
 *
 * `available` is the server's `allocated − used − pending`, not `allocated −
 * used`. Those differ by every day already committed to a request nobody has
 * decided yet, and showing the larger of the two is how an employee books days
 * they do not have and is refused at submit. The legend under the grid says so
 * out loud, because "pending" is the figure people misread.
 *
 * Extracted from the original leave-balances tile row so the Leave Tracker and
 * the HRMS tab render the same arithmetic from the same component rather than
 * two copies that drift.
 */
export function LeaveSummaryCards({ staffId }: { staffId?: string }) {
  const { data: balances = [], isLoading, isError, refetch } = useLeaveBalances(staffId);

  // Index by type so the cards render in the fixed display order, and a type
  // with no allocation row still gets a card saying so.
  const byType = useMemo(() => {
    const map = new Map<string, LeaveBalance>();
    for (const b of balances) map.set(b.type, b);
    return map;
  }, [balances]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 p-3 text-sm">
        Couldn&apos;t load the leave balances.{" "}
        <button type="button" className="underline" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {LEAVE_TYPE_ORDER.map((type) => {
          const row = byType.get(type);
          const paid = isPaidLeaveType(type);
          // `pending` and `available` arrived with the reserved-days change;
          // fall back to the same arithmetic for a row served without them.
          const pending = row?.pending ?? 0;
          const available = row?.available ?? (row ? Math.max(0, row.balance - pending) : 0);
          return (
            <Card key={type}>
              <CardContent className="space-y-1 p-4">
                <p className="text-xs text-muted-foreground">{LEAVE_TYPE_LABELS[type]}</p>
                {!paid ? (
                  <>
                    <p className="text-2xl font-semibold text-muted-foreground">Unpaid</p>
                    <p className="text-xs text-muted-foreground">No balance is charged</p>
                  </>
                ) : !row ? (
                  <>
                    <p className="text-2xl font-semibold text-muted-foreground">—</p>
                    <p className="text-xs text-muted-foreground">Not allotted</p>
                  </>
                ) : (
                  <>
                    <p className="num text-2xl font-semibold">
                      {available}
                      <span className="text-sm font-normal text-muted-foreground">
                        {" "}
                        available
                      </span>
                    </p>
                    <p className="num text-xs text-muted-foreground">
                      {row.used} used · {pending} pending
                      <span className="block">of {row.allocated} allotted</span>
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Available = allotted − used − pending. Pending days are already reserved for requests
        awaiting a decision, so they cannot be booked twice.
      </p>
    </div>
  );
}

/** The financial-year label the balance rows carry, for a section heading. */
export function useLeaveFinancialYear(staffId?: string): string | undefined {
  const { data: balances = [] } = useLeaveBalances(staffId);
  return balances.find((b) => b.financialYearLabel)?.financialYearLabel;
}

/**
 * The next time off this person has coming, in one line.
 *
 * A balance tells you what you may book; this tells you what you have booked,
 * which is the other question anybody opens a leave summary to answer. Pending
 * counts — it is still time the employee is expecting to take.
 */
export function UpcomingLeaveLine() {
  const userId = useSession((s) => s.user.id);
  const { data: requests = [] } = useLeaveRequests();

  const next = useMemo(() => {
    const today = todayKey();
    return (requests ?? [])
      .filter(
        (r) =>
          r.staffId === userId &&
          (r.status === "approved" || r.status === "pending") &&
          (r.toDate ?? "") >= today,
      )
      .sort((a, b) => (a.fromDate ?? "").localeCompare(b.fromDate ?? ""))[0];
  }, [requests, userId]);

  if (!next) {
    return (
      <p className="text-sm text-muted-foreground">You have no upcoming time off booked.</p>
    );
  }
  const badge = LEAVE_STATUS_BADGE[next.status];
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Next time off:</span>
      <span className="font-medium">{next.type}</span>
      <span className="num text-muted-foreground">
        {leaveRange(next)} · {durationLabel(next.days)}
      </span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
    </p>
  );
}

/** Store-local today as YYYY-MM-DD, which compares as a plain string. */
function todayKey(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
