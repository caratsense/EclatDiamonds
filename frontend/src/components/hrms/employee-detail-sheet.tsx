"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ATTENDANCE_STATUS_LABELS, LEAVE_TYPE_LABELS } from "@/lib/mock/hrms";
import {
  EMPLOYMENT_TYPE_LABELS,
  formatYmd,
  useEmployee,
  type EmployeeRow,
} from "@/lib/queries/hrms-employees";
import { ROLE_LABELS } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Right-hand drawer: the full profile, leave balances and the last 30 days of
 * attendance for one person. Built on Dialog (no Sheet primitive in ui/).
 */
export function EmployeeDetailSheet({
  userId,
  onOpenChange,
  onEdit,
  canManage,
}: {
  userId: string | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (row: EmployeeRow) => void;
  canManage: boolean;
}) {
  const { data: e, isLoading, isError, error, refetch } = useEmployee(userId);

  return (
    <Dialog open={!!userId} onOpenChange={onOpenChange}>
      <DialogContent className="left-auto right-0 top-0 h-dvh max-w-xl translate-x-0 translate-y-0 content-start overflow-y-auto sm:rounded-none">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {e?.name ?? "Employee"}
            {e ? <EmployeeStatusBadge row={e} /> : null}
          </DialogTitle>
          <DialogDescription>
            {e
              ? [e.employeeCode, e.designation?.name, e.department?.name].filter(Boolean).join(" · ") ||
                ROLE_LABELS[e.role]
              : "Profile, leave and attendance"}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : isError || !e ? (
          <div className="space-y-3 rounded-xl border border-dashed p-6 text-center text-sm">
            <AlertTriangle className="mx-auto h-5 w-5 text-destructive" />
            <p>{apiErrorMessage(error, "Could not load this employee.")}</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {canManage ? (
              <Button size="sm" variant="outline" className="w-fit" onClick={() => onEdit(e)}>
                <Pencil /> {e.hasProfile ? "Edit profile" : "Create profile"}
              </Button>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Item label="Role">{ROLE_LABELS[e.role]}</Item>
              <Item label="Stores">{(e.storeNames ?? []).join(", ") || "—"}</Item>
              <Item label="Shift">
                {e.currentShift
                  ? `${e.currentShift.name} (${e.currentShift.startTime}–${e.currentShift.endTime})`
                  : (e.shiftCode ?? "—")}
              </Item>
              <Item label="Reporting to">{e.reportingManager?.name ?? "—"}</Item>
              <Item label="Employment">
                {e.employmentType ? EMPLOYMENT_TYPE_LABELS[e.employmentType] : "—"}
              </Item>
              <Item label="Joined">{formatYmd(e.dateOfJoining)}</Item>
              <Item label="Confirmed">{formatYmd(e.dateOfConfirmation)}</Item>
              {e.exitDate ? (
                <Item label="Exit">
                  {formatYmd(e.exitDate)}
                  {e.exitReason ? ` · ${e.exitReason}` : ""}
                </Item>
              ) : null}
              <Item label="Mobile">{e.phone ?? "—"}</Item>
              <Item label="Personal email">{e.personalEmail ?? "—"}</Item>
              <Item label="Login">{e.loginEmail ?? "—"}</Item>
              <Item label="Legacy attendance ID">{e.biometricNo ?? "—"}</Item>
              <Item label="Unit">{e.unit ?? "—"}</Item>
              <Item label="Source">{e.source ?? "—"}</Item>
              {/* Sensitive fields: the API only sends them to head office. */}
              {e.dateOfBirth ? <Item label="Date of birth">{formatYmd(e.dateOfBirth)}</Item> : null}
              {e.bloodGroup ? <Item label="Blood group">{e.bloodGroup}</Item> : null}
              {e.address ? (
                <div className="col-span-2">
                  <Item label="Address">{e.address}</Item>
                </div>
              ) : null}
            </dl>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Leave balances</h3>
              {(e.leaveBalances ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                  No leave balances for this year.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Allocated</TableHead>
                      <TableHead className="text-right">Used</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(e.leaveBalances ?? []).map((b) => (
                      <TableRow key={`${b.type}-${b.year}`}>
                        <TableCell>
                          {LEAVE_TYPE_LABELS[b.type] ?? leaveLabel(b.type)}{" "}
                          <span className="text-xs text-muted-foreground">{b.year}</span>
                        </TableCell>
                        <TableCell className="num text-right">{b.allocated}</TableCell>
                        <TableCell className="num text-right">{b.used}</TableCell>
                        <TableCell className="num text-right font-medium">{b.balance}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Last 30 days</h3>
              {(e.recentAttendance ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                  No attendance recorded in the last 30 days.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">In</TableHead>
                      <TableHead className="text-right">Out</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(e.recentAttendance ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="num whitespace-nowrap">{formatYmd(r.date)}</TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-1">
                            {ATTENDANCE_STATUS_LABELS[r.status] ?? r.status}
                            {r.isLate ? (
                              <Badge variant="warning">
                                Late{r.lateMinutes ? ` ${r.lateMinutes}m` : ""}
                              </Badge>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell className="num text-right">{r.checkIn ?? "—"}</TableCell>
                        <TableCell className="num text-right">{r.checkOut ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "No profile" (login without an employee-master row) / status chip. */
export function EmployeeStatusBadge({ row }: { row: EmployeeRow }) {
  if (!row.hasProfile) return <Badge variant="warning">No profile</Badge>;
  if (row.status === "separated") return <Badge variant="destructive">Separated</Badge>;
  if (row.status === "inactive" || !row.isActive)
    return <Badge variant="secondary">{row.status === "inactive" ? "Inactive" : "Login off"}</Badge>;
  return <Badge variant="success">Active</Badge>;
}

/** `week_off_leave` is not in the frontend LeaveType union yet. */
function leaveLabel(type: string): string {
  return type === "week_off_leave" ? "Week-off leave" : type;
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
