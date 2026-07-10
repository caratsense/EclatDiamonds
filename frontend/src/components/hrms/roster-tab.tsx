"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
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
import {
  ROSTER_DAYS,
  SHIFT_LABELS,
  type LeaveRequest,
  type LeaveStatus,
  type RosterRow,
  type ShiftAssignment,
} from "@/lib/mock/hrms";

const SHIFT_STYLES: Record<ShiftAssignment["shift"], string> = {
  M: "bg-secondary text-secondary-foreground",
  E: "bg-secondary text-secondary-foreground",
  O: "bg-muted text-muted-foreground",
  L: "bg-muted text-muted-foreground",
};

const LEAVE_STATUS_META: Record<
  LeaveStatus,
  { label: string; variant: "success" | "secondary" | "destructive" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
};

interface RosterTabProps {
  roster: RosterRow[];
  leave: LeaveRequest[];
  /**
   * Persist a leave decision to the backend (PATCH /hrms/leave/:id). When
   * omitted the tab falls back to a local optimistic update (e.g. while the
   * roster grid is still mock-only).
   */
  onDecide?: (req: LeaveRequest, status: LeaveStatus) => void;
  /** True while a decision mutation is in flight (disables the buttons). */
  deciding?: boolean;
}

export function RosterTab({ roster, leave, onDecide, deciding }: RosterTabProps) {
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
          <CardTitle>Weekly shift grid</CardTitle>
          <CardDescription>
            Morning / Evening / Off / Leave per staffer for the current week.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 text-sm">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                    Staff
                  </th>
                  {ROSTER_DAYS.map((d) => (
                    <th
                      key={d}
                      className="px-2 py-1 text-center font-medium text-muted-foreground"
                    >
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roster.map((row) => (
                  <tr key={row.staffId}>
                    <td className="px-2 py-1">
                      <p className="font-medium leading-tight">{row.name}</p>
                      <p className="text-xs text-muted-foreground">{row.role}</p>
                    </td>
                    {row.week.map((a) => (
                      <td key={a.day} className="px-1 py-1 text-center">
                        <span
                          className={`inline-flex h-8 w-full min-w-9 items-center justify-center rounded-md text-xs font-semibold ${SHIFT_STYLES[a.shift]}`}
                          title={SHIFT_LABELS[a.shift]}
                        >
                          {a.shift}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {(["M", "E", "O", "L"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-semibold ${SHIFT_STYLES[k]}`}
                >
                  {k}
                </span>
                {SHIFT_LABELS[k]}
              </span>
            ))}
          </div>
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
