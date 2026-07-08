"use client";

import { useMemo, useState } from "react";
import { CalendarPlus } from "lucide-react";

import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveBalance,
  type LeaveType,
} from "@/lib/mock/hrms";
import { useLeaveBalances } from "@/lib/queries/hrms";
import { ApplyLeaveDialog } from "@/components/hrms/apply-leave-dialog";

/** Colour accent per leave type for the tile. */
const TYPE_ACCENT: Record<LeaveType, string> = {
  casual: "text-sky-600 dark:text-sky-400",
  sick: "text-rose-600 dark:text-rose-400",
  earned: "text-emerald-600 dark:text-emerald-400",
  festival: "text-amber-600 dark:text-amber-400",
};

/**
 * Leave balances row + "Apply for leave" action (Module 6). Balances are the
 * current user's own (self-service); managers approve requests below in the list.
 */
export function LeaveBalances() {
  const { data: balances = [], isLoading } = useLeaveBalances();
  const [applyOpen, setApplyOpen] = useState(false);

  // Index by type so we render in a fixed display order.
  const byType = useMemo(() => {
    const map = new Map<string, LeaveBalance>();
    for (const b of balances) map.set(b.type, b);
    return map;
  }, [balances]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">My leave balances</h3>
          <p className="text-xs text-muted-foreground">
            Remaining paid leave for {new Date().getFullYear()}.
          </p>
        </div>
        <Button size="sm" onClick={() => setApplyOpen(true)}>
          <CalendarPlus className="h-4 w-4" />
          Apply for leave
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {LEAVE_TYPE_ORDER.map((type) => {
            const b = byType.get(type);
            const isFestival = type === "festival";
            return (
              <Card key={type}>
                <CardContent className="space-y-1 p-4">
                  <p className="text-xs text-muted-foreground">
                    {LEAVE_TYPE_LABELS[type]}
                    {isFestival ? " · unpaid" : ""}
                  </p>
                  {isFestival ? (
                    <p className={`text-2xl font-semibold ${TYPE_ACCENT[type]}`}>
                      Unpaid
                    </p>
                  ) : (
                    <>
                      <p
                        className={`num text-2xl font-semibold ${TYPE_ACCENT[type]}`}
                      >
                        {b ? b.balance : "—"}
                        <span className="text-sm font-normal text-muted-foreground">
                          {" "}
                          left
                        </span>
                      </p>
                      <p className="num text-xs text-muted-foreground">
                        {b ? `${b.used} / ${b.allocated} used` : "no allocation"}
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ApplyLeaveDialog open={applyOpen} onOpenChange={setApplyOpen} />
    </div>
  );
}
