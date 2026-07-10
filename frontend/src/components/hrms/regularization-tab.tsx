"use client";

import { useState } from "react";
import { Check, Clock3, Plus, X } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import type { LeaveStatus, Regularization } from "@/lib/mock/hrms";
import {
  useDecideRegularization,
  useRegularizations,
} from "@/lib/queries/hrms";
import { RegularizeDialog } from "@/components/hrms/regularize-dialog";

const STATUS_META: Record<
  LeaveStatus,
  { label: string; variant: "success" | "secondary" | "destructive" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
};

/** "Wed 8 Jul" from YYYY-MM-DD (local). */
function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RegularizationTab() {
  const { role } = useSession();
  const canDecide = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const { data: rows = [], isLoading, isError, refetch } = useRegularizations();
  const decide = useDecideRegularization();
  const [open, setOpen] = useState(false);

  function handleDecide(row: Regularization, status: LeaveStatus) {
    decide.mutate(
      { id: row.id, status },
      {
        onSuccess: () =>
          toast.success(
            `${status === "approved" ? "Approved" : "Rejected"} attendance fix for ${row.name}`,
          ),
        onError: () => toast.error("Could not update the request."),
      },
    );
  }

  // Pending first, then most recent date.
  const ordered = [...rows].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return b.date.localeCompare(a.date);
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              Fix attendance
            </CardTitle>
            <CardDescription>
              {canDecide
                ? "Review and approve staff requests to fix a missed or wrong punch."
                : "Request a fix for a missed or wrong punch — your manager approves it."}
            </CardDescription>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            Request fix
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <>
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </>
          ) : isError ? (
            <div className="rounded-lg border bg-muted/30 p-4 text-center">
              <p className="text-sm font-medium">
                Couldn&apos;t load regularizations.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : ordered.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No attendance-fix requests for this store.
            </p>
          ) : (
            ordered.map((row) => {
              const meta = STATUS_META[row.status];
              return (
                <div
                  key={row.id}
                  className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="text-xs">
                        {row.initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{row.name}</span>
                        <Badge variant="outline">{formatDay(row.date)}</Badge>
                      </div>
                      <p className="num text-sm text-muted-foreground">
                        In {formatTime(row.requestedCheckIn)} · Out{" "}
                        {formatTime(row.requestedCheckOut)}
                      </p>
                      {row.reason ? (
                        <p className="text-sm text-muted-foreground">
                          {row.reason}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 sm:pl-3">
                    {canDecide && row.status === "pending" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={decide.isPending}
                          onClick={() => handleDecide(row, "approved")}
                        >
                          <Check className="h-4 w-4" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={decide.isPending}
                          onClick={() => handleDecide(row, "rejected")}
                        >
                          <X className="h-4 w-4" />
                          Reject
                        </Button>
                      </>
                    ) : (
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <RegularizeDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
