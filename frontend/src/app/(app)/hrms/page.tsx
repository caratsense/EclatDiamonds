"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/store/use-session";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { getNavItem } from "@/lib/navigation";
import { ROLE_RANK } from "@/lib/types";
import { useStaff } from "@/lib/queries/users";
import type { LeaveRequest, LeaveStatus } from "@/lib/mock/hrms";
import { AttendanceTab } from "@/components/hrms/attendance-tab";
import { RosterTab } from "@/components/hrms/roster-tab";
import { ShiftsScheduleTab } from "@/components/hrms/shifts-schedule-tab";
import { LateFlagsTab } from "@/components/hrms/late-flags-tab";
import { GeoPunchCard } from "@/components/hrms/geo-punch-card";
import { LeaveBalances } from "@/components/hrms/leave-balances";
import { RegularizationTab } from "@/components/hrms/regularization-tab";
import { AttendanceReportsTab } from "@/components/hrms/attendance-reports-tab";
import {
  useAttendance,
  useDecideLeave,
  useGeofence,
  useHolidays,
  useLateFlags,
  useLeaveRequests,
  useMarkAttendance,
  useShifts,
  type AttendanceStatus,
} from "@/lib/queries/hrms";
import { apiErrorMessage } from "@/lib/utils";

const ATTENDANCE_STATUSES: { value: AttendanceStatus; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "absent", label: "Absent" },
  { value: "on_leave", label: "On leave" },
];

export default function HrmsPage() {
  const { currentStore, role } = useSession();
  const nav = getNavItem("hrms");
  const isAggregate = currentStore.isAggregate;
  const [markOpen, setMarkOpen] = useState(false);
  // Head office is view-only for attendance: no personal punch card, no
  // marking attendance for others — it only observes store-wise data.
  const isHeadOffice = role === "head_office";
  // Role split (rank-monotonic; area_manager collapses to the store_manager
  // tier). A salesperson gets an attendance-ONLY view — self punch + own
  // history + a leave request; every manager/observer tab is store_manager+.
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  // Only the store tier marks attendance FOR others (backend: @Roles
  // store_manager+; HO stays deliberately observe-only).
  const canMarkOthers = isManager && !isHeadOffice;

  // Live, already store/role-scoped server-side (keyed on the active store).
  const attendanceQuery = useAttendance();
  const leaveQuery = useLeaveRequests();
  const shiftsQuery = useShifts();
  const holidaysQuery = useHolidays();
  // Current month key (YYYY-MM) for the late-flag roll-up.
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const lateFlagsQuery = useLateFlags(month);
  const { data: attendance = [], isLoading: attLoading } = attendanceQuery;
  const { data: leave = [], isLoading: leaveLoading } = leaveQuery;
  const { data: shifts = [] } = shiftsQuery;
  const { data: holidays = [] } = holidaysQuery;
  const { data: lateFlags = [], isLoading: flagsLoading } = lateFlagsQuery;
  const decideLeave = useDecideLeave();

  const scheduleLoading = shiftsQuery.isLoading || holidaysQuery.isLoading;
  const scheduleError = shiftsQuery.isError || holidaysQuery.isError;

  // Store geofence comes live from GET /hrms/geofence (the caller's resolved
  // store centre + radius). Single-store only — the aggregate has no fence.
  const geofenceQuery = useGeofence();
  const fence = isAggregate ? undefined : geofenceQuery.data;

  function handleDecide(req: LeaveRequest, status: LeaveStatus) {
    decideLeave.mutate(
      { id: req.id, status },
      {
        onSuccess: () =>
          toast.success(
            `${status === "approved" ? "Approved" : "Rejected"} ${req.type.toLowerCase()} leave for ${req.name}`,
          ),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the leave request.")),
      },
    );
  }

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "HRMS & Attendance"}
        purpose={nav?.purpose ?? ""}
        primaryAction={canMarkOthers ? nav?.primaryAction : undefined}
        onPrimaryAction={canMarkOthers ? () => setMarkOpen(true) : undefined}
      />

      {isHeadOffice ? null : (
        <div className="mb-4">
          <GeoPunchCard />
        </div>
      )}

      <Tabs
        defaultValue={isManager ? "attendance" : "roster"}
        className="space-y-4"
      >
        <TabsList className="flex h-auto flex-wrap">
          {/* Store-wide attendance, shift/holiday setup and late-flag roll-ups
              are manager/observer tools — hidden from a salesperson, whose view
              is self punch + own history + leave. */}
          {isManager ? (
            <>
              <TabsTrigger value="attendance">Attendance</TabsTrigger>
              <TabsTrigger value="schedule">Shifts &amp; Schedule</TabsTrigger>
              <TabsTrigger value="flags">Late Flags</TabsTrigger>
            </>
          ) : null}
          <TabsTrigger value="roster">
            {isManager ? "Roster & Leave" : "Leave"}
          </TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="regularize">Fix attendance</TabsTrigger>
        </TabsList>

        {isManager ? (
          <>
            <TabsContent value="attendance">
              {attLoading ? (
                <TabSkeleton />
              ) : attendanceQuery.isError ? (
                <TabError
                  what="today's attendance"
                  onRetry={() => attendanceQuery.refetch()}
                />
              ) : (
                <AttendanceTab records={attendance} fence={fence} />
              )}
            </TabsContent>
            <TabsContent value="schedule">
              {scheduleLoading ? (
                <TabSkeleton />
              ) : scheduleError ? (
                <TabError
                  what="shifts & schedule"
                  onRetry={() => {
                    shiftsQuery.refetch();
                    holidaysQuery.refetch();
                  }}
                />
              ) : (
                <ShiftsScheduleTab shifts={shifts} holidays={holidays} />
              )}
            </TabsContent>
            <TabsContent value="flags">
              {flagsLoading ? (
                <TabSkeleton />
              ) : lateFlagsQuery.isError ? (
                <TabError
                  what="late flags"
                  onRetry={() => lateFlagsQuery.refetch()}
                />
              ) : (
                <LateFlagsTab rows={lateFlags} month={month} />
              )}
            </TabsContent>
          </>
        ) : null}

        <TabsContent value="roster">
          <div className="space-y-4">
            {/* Self-service balances + "Apply for leave" — every role. The
                approval list below is the manager control (store-scoped). */}
            <LeaveBalances />
            {isManager ? (
              leaveLoading ? (
                <TabSkeleton />
              ) : leaveQuery.isError ? (
                <TabError
                  what="leave requests"
                  onRetry={() => leaveQuery.refetch()}
                />
              ) : (
                <RosterTab
                  shifts={shifts}
                  leave={leave}
                  onDecide={handleDecide}
                  deciding={decideLeave.isPending}
                />
              )
            ) : null}
          </div>
        </TabsContent>
        <TabsContent value="reports">
          <AttendanceReportsTab />
        </TabsContent>
        <TabsContent value="regularize">
          <RegularizationTab />
        </TabsContent>
      </Tabs>

      <MarkAttendanceDialog open={markOpen} onOpenChange={setMarkOpen} />
    </>
  );
}

function MarkAttendanceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const markAttendance = useMarkAttendance();
  const { data: shifts = [] } = useShifts();
  const [staffId, setStaffId] = useState("");
  const [status, setStatus] = useState<AttendanceStatus>("present");
  const [checkInTime, setCheckInTime] = useState("");
  const [shiftId, setShiftId] = useState<string>("");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  // The roster for the target store. Attendance must be attributed to a REAL
  // staff record: a typed-in name produced a throwaway id that no report or
  // payroll run could ever reconcile, so the picker is the only way in now.
  const { data: staff = [] } = useStaff(targetStoreId);

  function save() {
    if (!targetStoreId) {
      toast.error("Select a store first.");
      return;
    }
    const next: Record<string, string> = {};
    if (!staffId) next.staffId = "Choose the staff member.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }

    // Build an ISO datetime for today from the HH:mm time, or omit it.
    let checkInAt: string | undefined;
    if (checkInTime) {
      const [h, m] = checkInTime.split(":").map(Number);
      const dt = new Date();
      dt.setHours(h, m, 0, 0);
      checkInAt = dt.toISOString();
    }

    markAttendance.mutate(
      {
        staffId,
        status,
        storeId: targetStoreId,
        checkInAt,
        shiftId: shiftId || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Attendance marked", {
            description: `Logged at ${storeLabel}.`,
          });
          setStaffId("");
          setStatus("present");
          setCheckInTime("");
          setShiftId("");
          setErrors({});
          onOpenChange(false);
        },
        onError: (err: unknown) =>
          toast.error(apiErrorMessage(err, "Could not mark attendance.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark attendance</DialogTitle>
          <DialogDescription>
            Log a staff member&apos;s attendance against {storeLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          <div className="grid gap-1.5">
            <Label htmlFor="staff-pick">
              Staff member <span className="text-destructive">*</span>
            </Label>
            <Select
              value={staffId}
              onValueChange={(v) => {
                setStaffId(v);
                clearError("staffId");
              }}
            >
              <SelectTrigger id="staff-pick" aria-invalid={!!errors.staffId}>
                <SelectValue
                  placeholder={
                    staff.length ? "Select staff" : "No staff assigned to this store"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {staff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.staffId ? (
              <p className="mt-1 text-xs text-destructive">{errors.staffId}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Attendance is attributed to a real staff record, so it reconciles
              with reports and payroll.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="att-status">Status</Label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as AttendanceStatus)}
            >
              <SelectTrigger id="att-status">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {ATTENDANCE_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="att-checkin">Check-in time</Label>
            <Input
              id="att-checkin"
              type="time"
              value={checkInTime}
              onChange={(e) => setCheckInTime(e.target.value)}
            />
          </div>
          {shifts.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="att-shift">Shift / batch</Label>
              <Select value={shiftId} onValueChange={setShiftId}>
                <SelectTrigger id="att-shift">
                  <SelectValue placeholder="Store default shift" />
                </SelectTrigger>
                <SelectContent>
                  {shifts.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} · {s.startTime}–{s.endTime}
                      {s.isNightBatch ? " (night)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Second-batch staff aren&apos;t marked late — lateness is measured
                against their own shift.
              </p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={markAttendance.isPending}>
            {markAttendance.isPending ? "Saving…" : "Mark attendance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TabError({
  what,
  onRetry,
}: {
  what: string;
  onRetry: () => void;
}) {
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
