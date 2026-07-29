"use client";

import { useState } from "react";
import { Check, Clock, Moon, X } from "lucide-react";
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
import type { LeaveRequest, LeaveStatus, Shift } from "@/lib/mock/hrms";

const LEAVE_STATUS_META: Record<
  LeaveStatus,
  { label: string; variant: "success" | "secondary" | "destructive" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

interface RosterTabProps {
  /**
   * The store's configured shifts / batches (GET /hrms/shifts). There is no
   * per-staff weekly-roster endpoint yet, so we surface the real shift
   * structure rather than a synthetic weekly grid (see the caption).
   */
  shifts: Shift[];
  leave: LeaveRequest[];
  /**
   * Persist a leave decision to the backend (PATCH /hrms/leave/:id). When
   * omitted the tab falls back to a local optimistic update.
   */
  onDecide?: (req: LeaveRequest, status: LeaveStatus) => void;
  /** True while a decision mutation is in flight (disables the buttons). */
  deciding?: boolean;
}

export function RosterTab({ shifts, leave, onDecide, deciding }: RosterTabProps) {
  // Local optimistic fallback when no persistence handler is provided.
  const [decisions, setDecisions] = useState<Record<string, LeaveStatus>>({});

  function decide(req: LeaveRequest, status: LeaveStatus) {
    if (onDecide) {
      onDecide(req, status);
      return;
    }
    setDecisions((d) => ({ ...d, [req.id]: status }));
    toast.success(
      `${status === "approved" ? "Approved" : "Rejected"} ${req.type.toLowerCase()} leave for ${req.name}`,
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Shift structure</CardTitle>
          <CardDescription>
            Configured shifts and batches for this store. Per-staff weekly
            rostering isn&apos;t available yet — lateness is measured against
            each shift&apos;s own start time plus its grace window.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {shifts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No shifts configured for this store yet.
            </p>
          ) : (
            shifts.map((s) => (
              <div
                key={s.id}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-2">
                  {s.isNightBatch ? (
                    <Moon className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Clock className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="font-medium">{s.name}</span>
                  {s.isNightBatch ? (
                    <Badge variant="secondary">Night batch</Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                  <span className="num">
                    {s.startTime}–{s.endTime}
                  </span>
                  <span>
                    Grace <span className="num">{s.bufferMins}</span> min
                  </span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Leave requests</CardTitle>
          <CardDescription>
            Approve or reject staff leave. Pending requests block roster
            confirmation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {leave.map((req) => {
            const status = decisions[req.id] ?? req.status;
            const meta = LEAVE_STATUS_META[status];
            return (
              <div
                key={req.id}
                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{req.name}</span>
                    <Badge variant="outline">{req.type}</Badge>
                    <span className="num text-sm text-muted-foreground">
                      {req.from} – {req.to} · {req.days}d
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{req.reason}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {status === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={deciding}
                        onClick={() => decide(req, "approved")}
                      >
                        <Check className="h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={deciding}
                        onClick={() => decide(req, "rejected")}
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
          })}
          {leave.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No leave requests for this store.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
