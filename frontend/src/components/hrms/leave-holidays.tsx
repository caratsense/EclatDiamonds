"use client";

import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useHolidays } from "@/lib/queries/hrms";
import { useSession } from "@/store/use-session";
import { formatLeaveDay } from "@/components/hrms/leave-request-detail";

/**
 * HOLIDAYS: the store's declared holidays, read-only.
 *
 * It belongs on the Leave Tracker because it is the other half of the day count
 * — a holiday inside a leave range is not charged, and this is where an employee
 * checks whether the day they are about to apply for is already free. Declaring
 * one stays where it was (Shifts &amp; Schedule, head office); duplicating the
 * editor here would give the same list two owners.
 */
export function LeaveHolidaysPanel() {
  const storeName = useSession((s) => s.currentStore.name);
  const { data: holidays = [], isLoading, isError, refetch } = useHolidays();

  // Store-local YYYY-MM-DD compares as a string, so "today" needs no parsing.
  const today = useMemo(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }, []);

  const ordered = useMemo(
    () => [...holidays].sort((a, b) => a.date.localeCompare(b.date)),
    [holidays],
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 p-3 text-sm">
        Couldn&apos;t load the holiday list.{" "}
        <button type="button" className="underline" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        No holidays have been declared for {storeName}.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Holidays at {storeName}. A holiday inside a leave range is not charged to your balance.
      </p>
      <ul className="divide-y rounded-lg border">
        {ordered.map((holiday) => {
          const past = holiday.date < today;
          return (
            <li
              key={holiday.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
            >
              <span className={past ? "text-sm text-muted-foreground" : "text-sm font-medium"}>
                {holiday.label || "Holiday"}
              </span>
              <span className="flex items-center gap-2">
                <span className="num text-xs text-muted-foreground">
                  {formatLeaveDay(holiday.date, holiday.date)}
                </span>
                {holiday.date === today ? <Badge variant="gold">Today</Badge> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
