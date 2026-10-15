"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CalendarPlus,
  CalendarRange,
  Fingerprint,
  Plane,
  Receipt,
  SlidersHorizontal,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { useQuickAction } from "@/store/use-quick-action";
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
import { useSession } from "@/store/use-session";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { getNavItem } from "@/lib/navigation";
import { ROLE_RANK } from "@/lib/types";
import { useStaff } from "@/lib/queries/users";
import { AttendanceRulesBanner } from "@/components/hrms/attendance-rules";
import { GeoPunchCard } from "@/components/hrms/geo-punch-card";
import { ApplyLeaveDialog } from "@/components/hrms/apply-leave-dialog";
import {
  useMarkAttendance,
  useShifts,
  type AttendanceStatus,
} from "@/lib/queries/hrms";
import { useApprovals } from "@/lib/queries/hrms-ops";
import { apiErrorMessage, cn } from "@/lib/utils";

const ATTENDANCE_STATUSES: { value: AttendanceStatus; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "absent", label: "Absent" },
  { value: "on_leave", label: "On leave" },
];

/** One card on the landing: a module, or a back-office screen under it. */
interface Destination {
  href: string;
  title: string;
  detail: string;
  icon: LucideIcon;
  /** Decisions waiting on this person, drawn as a badge. */
  waiting?: number;
}

/**
 * HR & Attendance — the landing, and nothing else.
 *
 * It used to be nine tabs on one route: Today, Employees, Register, Approvals,
 * Shifts & Schedule, Reports, Leave, Fix attendance and Late flags. Nine tabs
 * is not a screen, it is a filing cabinet — somebody looking for "apply for
 * leave" had to know it lived behind a tab called Leave, beside a tab called
 * Approvals where their manager decided it, and the shift configuration sat two
 * tabs from the punch card.
 *
 * So the four MODULES are four screens now, each on its own route with its own
 * audience split (My Data | Team): Attendance, Leave Tracker, Roster & Shifts
 * and HR Reports. This page is the hub that opens them, and it keeps only what
 * a hub should: what today looks like (the punch card) and the actions that are
 * on a clock — apply for leave, and, for a manager, mark somebody's attendance.
 *
 * Policy and configuration are deliberately NOT here. Shift definitions, the
 * attendance-rules confirmation and head office's balance corrections live on
 * their own screen (`/hrms/setup`), reached from the Setup band at the bottom,
 * so somebody punching in never lands beside a control that changes how the
 * whole branch is measured.
 */
export default function HrmsPage() {
  const { role } = useSession();
  const userId = useSession((s) => s.user.id);
  const nav = getNavItem("hrms");
  const [markOpen, setMarkOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  // The sidebar's "Mark attendance" quick action, read as derived state like
  // the walk-in and lead dialogs do on their own pages.
  const quickAttendance = useQuickAction((s) => s.pending) === "attendance";
  const clearQuickAction = useQuickAction((s) => s.clear);
  // Head office does not punch (no personal punch card) and does not mark
  // attendance for others from the dialog; it may CORRECT records (the
  // Attendance module's register and Today), which is audited.
  const isHeadOffice = role === "head_office";
  // Role split (rank-monotonic; area_manager collapses to the store_manager
  // tier). Everybody gets the self-service half — their punch card, their own
  // attendance, leave and schedule; the team halves are store_manager+.
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  // Only the store tier marks attendance FOR others (backend: @Roles
  // store_manager+; HO stays out of the mark dialog).
  const canMarkOthers = isManager && !isHeadOffice;

  /*
   * What is waiting on a decision, split by module so each card carries its own
   * count. Somebody's own request is left out: it waits on the rank above them,
   * not on them — the server refuses a self-decision, and
   * `assertRankAboveRequester` refuses a peer's.
   */
  const pendingQuery = useApprovals("pending", { enabled: isManager });
  const pending = pendingQuery.data ?? [];
  const waitingLeave = pending.filter(
    (p) => p.kind === "leave" && p.staffId !== userId,
  ).length;
  const waitingFixes = pending.filter(
    (p) => p.kind === "regularization" && p.staffId !== userId,
  ).length;

  const modules: Destination[] = [
    {
      href: "/hrms/attendance",
      title: "Attendance",
      detail: isManager
        ? "Your punches and your month, the store's register, and the corrections waiting on you."
        : "Your punches, your month, and a correction when a punch is wrong.",
      icon: Fingerprint,
      waiting: waitingFixes,
    },
    {
      href: "/hrms/leave",
      title: "Leave Tracker",
      detail: isManager
        ? "Your balances and requests, and the team's — decided one rank above the person who asked."
        : "Your balances, your requests, and the branch's holidays.",
      icon: Plane,
      waiting: waitingLeave,
    },
    {
      href: "/hrms/roster",
      title: "Roster & Shifts",
      detail: isManager
        ? "Plan the week by date — who is on which shift, and whose off falls where."
        : "The shifts, offs and holidays ahead of you.",
      icon: CalendarRange,
    },
  ];
  if (isManager) {
    modules.push({
      href: "/hrms/reports",
      title: "HR Reports",
      detail:
        "The month in figures — presence, lateness, overtime, late flags, and the register as an export.",
      icon: BarChart3,
    });
  }

  /** Employee records and pay: real work, but not the day's work. */
  const backOffice: Destination[] = isManager
    ? [
        {
          href: "/hrms/employees",
          title: "Employees",
          detail:
            "The employee master — profiles, departments and designations, joining and separation.",
          icon: UsersRound,
        },
        {
          href: "/hrms/payroll",
          title: "Payroll & Payslips",
          detail:
            "Payslips counted from the attendance register, and the month's payroll runs.",
          icon: Receipt,
        },
      ]
    : [];

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "HR & Attendance"}
        purpose={nav?.purpose ?? ""}
        primaryAction={canMarkOthers ? nav?.primaryAction : undefined}
        onPrimaryAction={canMarkOthers ? () => setMarkOpen(true) : undefined}
      />

      {isHeadOffice ? null : (
        <div className="mb-4">
          <GeoPunchCard />
        </div>
      )}

      {isManager ? <AttendanceRulesBanner /> : null}

      {/*
        The routine actions, above the modules.

        "Apply for leave" is here and not only on the Leave Tracker so that it is
        TWO taps from a phone's bottom bar — HR, then Apply — because somebody
        asking for Thursday off is not navigating a product, they are asking for
        Thursday off. It opens the same dialog the tracker opens: one form, one
        set of rules.
      */}
      <div className="mb-6 flex flex-wrap gap-2">
        <Button onClick={() => setApplyOpen(true)}>
          <CalendarPlus className="h-4 w-4" />
          Apply for leave
        </Button>
        <Button asChild variant="outline">
          <Link href="/hrms/schedule">
            <CalendarRange className="h-4 w-4" />
            My schedule
          </Link>
        </Button>
      </div>

      <Band title="The four HR modules">
        {modules.map((d) => (
          <DestinationCard key={d.href} destination={d} />
        ))}
      </Band>

      {backOffice.length ? (
        <Band title="People & pay">
          {backOffice.map((d) => (
            <DestinationCard key={d.href} destination={d} />
          ))}
        </Band>
      ) : null}

      {isManager ? (
        <Band title="Setup">
          {/* Away from the routine actions on purpose: these settings decide how
              the whole branch is measured, and head office's confirmation is
              what switches automatic absence on. */}
          <DestinationCard
            destination={{
              href: "/hrms/setup",
              title: "Shifts & Schedule",
              detail: isHeadOffice
                ? "Shifts, weekly offs, holidays, the attendance-rules confirmation, and leave-balance corrections."
                : "Shifts, weekly offs and holidays for your branch, and what the attendance rules are set to.",
              icon: SlidersHorizontal,
            }}
          />
        </Band>
      ) : null}

      <MarkAttendanceDialog
        open={markOpen || (quickAttendance && canMarkOthers)}
        onOpenChange={(o) => {
          setMarkOpen(o);
          if (!o) clearQuickAction();
        }}
      />
      <ApplyLeaveDialog open={applyOpen} onOpenChange={setApplyOpen} />
    </>
  );
}

/** A labelled band of destination cards. */
function Band({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * The whole card is the link rather than a button inside it: these are opened
 * from a phone and from an in-store terminal, where the target should be the
 * size of the thing it describes.
 */
function DestinationCard({ destination }: { destination: Destination }) {
  const { href, title, detail, icon: Icon, waiting } = destination;
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-start gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-sm transition-colors",
        "hover:border-[color-mix(in_srgb,var(--gold)_40%,transparent)] hover:bg-accent",
      )}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {waiting ? (
            <span
              className="num rounded-full bg-destructive px-1.5 text-[11px] leading-5 text-destructive-foreground"
              aria-label={`${waiting} waiting on a decision`}
            >
              {waiting}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
      <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/**
 * Marking somebody else's attendance — the landing's primary action, and the
 * sidebar's "Mark attendance" quick action.
 *
 * It stays on the hub rather than moving to the Attendance module with the rest
 * of the team views: two front doors to the same write is two different answers
 * to "who marked this?", and the register already carries the audited edit for
 * fixing a row that exists.
 */
function MarkAttendanceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const scope = useStoreScope();
  const { pickedStoreId, setPickedStoreId, targetStoreId, storeLabel } = scope;
  const markAttendance = useMarkAttendance();
  const { data: shifts = [] } = useShifts();
  const [staffId, setStaffId] = useState("");
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
