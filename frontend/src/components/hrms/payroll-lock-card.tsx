"use client";

import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import {
  refName,
  useLockPayrollMonth,
  usePayrollLocks,
  useReopenPayrollMonth,
  type PayrollLock,
} from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";

function monthKey(offset: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

/**
 * Head office: close a payroll month to edits. Attendance, leave and punches
 * dated inside a locked month are refused until it is reopened with a reason.
 */
export function PayrollLockCard() {
  const locks = usePayrollLocks();
  const lock = useLockPayrollMonth();
  const reopen = useReopenPayrollMonth();
  const [confirmLock, setConfirmLock] = useState<string | null>(null);
  const [reopening, setReopening] = useState<PayrollLock | null>(null);

  const rows = [...(locks.data ?? [])].sort((a, b) => b.month.localeCompare(a.month));
  const isLocked = (m: string) => rows.some((r) => r.month === m && !r.reopenedAt);

  function doLock(month: string) {
    lock.mutate(month, {
      onSuccess: () => {
        toast.success(`${monthLabel(month)} locked`);
        setConfirmLock(null);
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Could not lock the month.")),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          Payroll locks
        </CardTitle>
        <CardDescription>
          Lock a month once payroll is run so nobody changes attendance under it.
          Payslips can still be generated for a locked month.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {[-1, 0].map((off) => {
            const m = monthKey(off);
            return (
              <Button
                key={m}
                variant="outline"
                size="sm"
                disabled={isLocked(m) || lock.isPending || locks.isLoading}
                onClick={() => setConfirmLock(m)}
              >
                <Lock className="h-4 w-4" />
                {isLocked(m) ? `${monthLabel(m)} locked` : `Lock ${monthLabel(m)}`}
              </Button>
            );
          })}
        </div>

        {locks.isLoading ? (
          <Skeleton className="h-14 rounded-lg" />
        ) : locks.isError ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load payroll locks.{" "}
            <button type="button" className="underline" onClick={() => locks.refetch()}>
              Retry
            </button>
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
            No month has been locked yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium">{monthLabel(r.month)}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.reopenedAt
                      ? `Reopened ${new Date(r.reopenedAt).toLocaleDateString("en-IN")}${r.reopenedBy ? ` by ${refName(r.reopenedBy)}` : ""}${r.reopenReason ? ` · ${r.reopenReason}` : ""}`
                      : `Locked ${new Date(r.lockedAt).toLocaleDateString("en-IN")}${r.lockedBy ? ` by ${refName(r.lockedBy)}` : ""}`}
                  </p>
                </div>
                {r.reopenedAt ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="warning">Open</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={lock.isPending}
                      onClick={() => setConfirmLock(r.month)}
                    >
                      Lock again
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Badge variant="success">Locked</Badge>
                    <Button size="sm" variant="ghost" onClick={() => setReopening(r)}>
                      <LockOpen className="h-4 w-4" />
                      Reopen
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {confirmLock ? (
        <ReasonDialog
          key={confirmLock}
          open
          onOpenChange={(o) => (o ? null : setConfirmLock(null))}
          title={`Lock ${monthLabel(confirmLock)}?`}
          description="Attendance, leave and punch changes dated in this month will be refused until head office reopens it."
          withReason={false}
          confirmLabel="Lock month"
          pending={lock.isPending}
          onConfirm={() => doLock(confirmLock)}
        />
      ) : null}
      {reopening ? (
        <ReasonDialog
          key={reopening.id}
          open
          onOpenChange={(o) => (o ? null : setReopening(null))}
          title={`Reopen ${monthLabel(reopening.month)}?`}
          description="Edits to this month become possible again. Payroll already issued may no longer match — say why."
          confirmLabel="Reopen month"
          destructive
          pending={reopen.isPending}
          onConfirm={(reason) =>
            reopen.mutate(
              { month: reopening.month, reason },
              {
                onSuccess: () => {
                  toast.success(`${monthLabel(reopening.month)} reopened`);
                  setReopening(null);
                },
                onError: (err) => toast.error(apiErrorMessage(err, "Could not reopen the month.")),
              },
            )
          }
        />
      ) : null}
    </Card>
  );
}
