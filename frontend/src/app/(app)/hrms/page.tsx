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
import { getNavItem } from "@/lib/navigation";
import {
  ROSTER,
  STORE_GEOFENCES,
  type LeaveRequest,
  type LeaveStatus,
} from "@/lib/mock/hrms";
import { AttendanceTab } from "@/components/hrms/attendance-tab";
import { RosterTab } from "@/components/hrms/roster-tab";
import { ShiftsScheduleTab } from "@/components/hrms/shifts-schedule-tab";
import { LateFlagsTab } from "@/components/hrms/late-flags-tab";
import { GeoPunchCard } from "@/components/hrms/geo-punch-card";
import { LeaveBalances } from "@/components/hrms/leave-balances";
import { RegularizationTab } from "@/components/hrms/regularization-tab";
import {
  useAttendance,
  useDecideLeave,
  useHolidays,
  useLateFlags,
  useLeaveRequests,
  useMarkAttendance,
  useShifts,
  type AttendanceStatus,
} from "@/lib/queries/hrms";

const ATTENDANCE_STATUSES: { value: AttendanceStatus; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "absent", label: "Absent" },
  { value: "on_leave", label: "On leave" },
];

export default function HrmsPage() {
  const { currentStore } = useSession();
  const nav = getNavItem("hrms");
  const isAggregate = currentStore.isAggregate;
  const [markOpen, setMarkOpen] = useState(false);

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

  // Roster (weekly shift grid) has no backend endpoint yet — keep the mock
  // roster, scoped to the active store so the grid stays consistent.
  const roster = useMemo(
    () => (isAggregate ? ROSTER : ROSTER.filter((r) => r.storeId === currentStore.id)),
    [currentStore.id, isAggregate],
  );

  // Store geofence comes from the local geofence registry (single store only).
  const fence = isAggregate ? undefined : STORE_GEOFENCES[currentStore.id];

  function handleDecide(req: LeaveRequest, status: LeaveStatus) {
    decideLeave.mutate(
      { id: req.id, status },
      {
        onSuccess: () =>
          toast.success(
            `${status === "approved" ? "Approved" : "Rejected"} ${req.type.toLowerCase()} leave for ${req.name}`,
          ),
        onError: () => toast.error("Could not update the leave request."),
      },
    );
  }

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "HRMS & Attendance"}
        purpose={nav?.purpose ?? ""}
        primaryAction={nav?.primaryAction}
        onPrimaryAction={() => setMarkOpen(true)}
      />

      <div className="mb-4">
        <GeoPunchCard />
      </div>

      <Tabs defaultValue="attendance" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="attendance">Attendance</TabsTrigger>
          <TabsTrigger value="schedule">Shifts &amp; Schedule</TabsTrigger>
          <TabsTrigger value="flags">Late Flags</TabsTrigger>
          <TabsTrigger value="roster">Roster &amp; Leave</TabsTrigger>
          <TabsTrigger value="regularize">Regularization</TabsTrigger>
        </TabsList>

        <TabsContent value="attendance">
          {attLoading ? (
            <TabSkeleton />
          ) : attendanceQuery.isError ? (
            <TabError what="today's attendance" onRetry={() => attendanceQuery.refetch()} />
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
        <TabsContent value="roster">
          <div className="space-y-4">
            <LeaveBalances />
            {leaveLoading ? (
              <TabSkeleton />
            ) : leaveQuery.isError ? (
              <TabError
                what="leave requests"
                onRetry={() => leaveQuery.refetch()}
              />
            ) : (
              <RosterTab
                roster={roster}
                leave={leave}
                onDecide={handleDecide}
                deciding={decideLeave.isPending}
              />
            )}
          </div>
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
  const { currentStore } = useSession();
  const markAttendance = useMarkAttendance();
  const { data: shifts = [] } = useShifts();
  const [staffName, setStaffName] = useState("");
  const [status, setStatus] = useState<AttendanceStatus>("present");
  const [checkInTime, setCheckInTime] = useState("");
  const [shiftId, setShiftId] = useState<string>("");

  // Aggregate ("all") scope has no concrete store to write to — fall back
  // to the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

  function save() {
    if (!staffName.trim()) {
      toast.error("Staff name is required.");
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
        staffName: staffName.trim(),
        status,
        storeId: targetStoreId,
        checkInAt,
        shiftId: shiftId || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Attendance marked", {
            description: `Logged at ${
              currentStore.isAggregate ? "Surat — Main" : currentStore.name
            }.`,
          });
          setStaffName("");
          setStatus("present");
          setCheckInTime("");
          setShiftId("");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not mark attendance."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark attendance</DialogTitle>
          <DialogDescription>
            Log a staff member&apos;s attendance against{" "}
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="staff-name">Staff name</Label>
            <Input
              id="staff-name"
              placeholder="e.g. Anita Desai"
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
            />
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
