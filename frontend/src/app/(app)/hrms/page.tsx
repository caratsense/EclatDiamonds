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
import { ShiftsScheduleTab } from "@/components/hrms/shifts-schedule-tab";
import { LateFlagsTab } from "@/components/hrms/late-flags-tab";
import { GeoPunchCard } from "@/components/hrms/geo-punch-card";
import { LeaveBalances } from "@/components/hrms/leave-balances";
import { RegularizationTab } from "@/components/hrms/regularization-tab";
import { AttendanceReportsTab } from "@/components/hrms/attendance-reports-tab";
import { AnalyticsTab } from "@/components/hrms/analytics-tab";
import { TodayTab } from "@/components/hrms/today-tab";
import { EmployeesTab } from "@/components/hrms/employees-tab";
import { RegisterTab } from "@/components/hrms/register-tab";
import { ApprovalsTab } from "@/components/hrms/approvals-tab";
import {
  useHolidays,
  useLateFlags,
  useMarkAttendance,
  useShifts,
  type AttendanceStatus,
} from "@/lib/queries/hrms";
import { useApprovals } from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";

const ATTENDANCE_STATUSES: { value: AttendanceStatus; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "absent", label: "Absent" },
  { value: "on_leave", label: "On leave" },
];

export default function HrmsPage() {
  const { role } = useSession();
  const nav = getNavItem("hrms");
  const [markOpen, setMarkOpen] = useState(false);
  // Set when "Mark" is pressed on a Today row: that person, at that store.
  const [markPreset, setMarkPreset] = useState<{ userId: string; storeId: string } | null>(null);
  // Head office does not punch (no personal punch card) and does not mark
  // attendance for others from the dialog; it may CORRECT records (Register /
  // Today edit), which is audited.
  const isHeadOffice = role === "head_office";
  // Role split (rank-monotonic; area_manager collapses to the store_manager
  // tier). A salesperson gets an attendance-ONLY view — self punch + own
  // history + a leave request; every manager/observer tab is store_manager+.
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  // Only the store tier marks attendance FOR others (backend: @Roles
  // store_manager+; HO stays out of the mark dialog).
  const canMarkOthers = isManager && !isHeadOffice;

  const shiftsQuery = useShifts();
  const holidaysQuery = useHolidays();
  // Current month key (YYYY-MM) for the late-flag roll-up.
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  // The team lateness tab is a manager view; nobody else fetches it.
  const lateFlagsQuery = useLateFlags(month, { enabled: isManager });
  const pendingQuery = useApprovals("pending", { enabled: isManager });
  const { data: shifts = [] } = shiftsQuery;
  const { data: holidays = [] } = holidaysQuery;
  const { data: lateFlags = [], isLoading: flagsLoading } = lateFlagsQuery;
  const pendingCount = pendingQuery.data?.length ?? 0;

  const scheduleLoading = shiftsQuery.isLoading || holidaysQuery.isLoading;
  const scheduleError = shiftsQuery.isError || holidaysQuery.isError;

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

      <Tabs defaultValue={isManager ? "today" : "roster"} className="space-y-4">
        <TabsList className="flex h-auto flex-wrap">
          {/* Store-wide attendance, people, corrections, setup and roll-ups are
              manager/observer tools — hidden from a salesperson, whose view is
              self punch + own history + leave. */}
          {isManager ? (
            <>
              <TabsTrigger value="today">Today</TabsTrigger>
              <TabsTrigger value="employees">Employees</TabsTrigger>
              <TabsTrigger value="register">Register</TabsTrigger>
              <TabsTrigger value="approvals" className="gap-1.5">
                Approvals
                {pendingCount > 0 ? (
                  <span
                    className="num rounded-full bg-destructive px-1.5 text-[11px] leading-5 text-destructive-foreground"
                    aria-label={`${pendingCount} pending`}
                  >
                    {pendingCount}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="schedule">Shifts &amp; Schedule</TabsTrigger>
              <TabsTrigger value="reports">Reports</TabsTrigger>
            </>
          ) : null}
          <TabsTrigger value="roster">Leave</TabsTrigger>
          <TabsTrigger value="regularize">Fix attendance</TabsTrigger>
          {isManager ? <TabsTrigger value="flags">Late flags</TabsTrigger> : null}
        </TabsList>

        {isManager ? (
          <>
            <TabsContent value="today">
              <TodayTab
                canEdit={isManager}
                onMark={
                  canMarkOthers
                    ? (r) => {
                        setMarkPreset(r);
                        setMarkOpen(true);
                      }
                    : undefined
                }
              />
            </TabsContent>
            <TabsContent value="employees">
              <EmployeesTab canManage={isManager} isHeadOffice={isHeadOffice} />
            </TabsContent>
            <TabsContent value="register">
              <RegisterTab canEdit={isManager} isHeadOffice={isHeadOffice} />
            </TabsContent>
            <TabsContent value="approvals">
              <ApprovalsTab />
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
            <TabsContent value="reports">
              <div className="space-y-6">
                <AnalyticsTab />
                <AttendanceReportsTab />
              </div>
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
          {/* Self-service balances + "Apply for leave" — every role. Team
              decisions live in Approvals; head office also corrects balances. */}
          <LeaveBalances canEditTeam={isHeadOffice} />
        </TabsContent>
        <TabsContent value="regularize">
          <RegularizationTab />
        </TabsContent>
      </Tabs>

      <MarkAttendanceDialog
        key={markPreset ? `${markPreset.userId}-${markPreset.storeId}` : "blank"}
        open={markOpen}
        preset={markPreset}
        onOpenChange={(o) => {
          setMarkOpen(o);
          if (!o) setMarkPreset(null);
        }}
      />
    </>
  );
}

function MarkAttendanceDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: { userId: string; storeId: string } | null;
}) {
  const scope = useStoreScope();
  const { pickedStoreId, setPickedStoreId } = scope;
  const targetStoreId = preset?.storeId ?? scope.targetStoreId;
  const storeLabel = preset ? "their store" : scope.storeLabel;
  const markAttendance = useMarkAttendance();
  const { data: shifts = [] } = useShifts();
  const [staffId, setStaffId] = useState(preset?.userId ?? "");
  const [status, setStatus] = useState<AttendanceStatus>("present");
  const [checkInTime, setCheckInTime] = useState("");
  const [shiftId, setShiftId] = useState<string>("");
  const attended = status === "present" || status === "late" || status === "half_day";
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

    markAttendance.mutate(
      {
        staffId,
        status,
        storeId: targetStoreId,
        checkInLocal: attended ? checkInTime || undefined : undefined,
        shiftId: attended ? shiftId || undefined : undefined,
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
          {preset ? null : (
            <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />
          )}

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
              onValueChange={(v) => {
                const next = v as AttendanceStatus;
                setStatus(next);
                if (!(["present", "late", "half_day"] as AttendanceStatus[]).includes(next)) {
                  setCheckInTime("");
                  setShiftId("");
                }
              }}
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
              disabled={!attended}
              onChange={(e) => setCheckInTime(e.target.value)}
            />
            {!attended ? (
              <p className="text-xs text-muted-foreground">
                A non-working status does not carry a punch time.
              </p>
            ) : null}
          </div>
          {shifts.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="att-shift">Shift / batch</Label>
              <Select value={shiftId} onValueChange={setShiftId} disabled={!attended}>
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
