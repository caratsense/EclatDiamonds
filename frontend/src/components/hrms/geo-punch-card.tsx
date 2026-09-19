"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  LogIn,
  LogOut,
  MapPin,
  ShieldAlert,
  Timer,
} from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  evaluatePunchLocation,
  punchAction,
  type PunchLocationDecision,
  type PunchPosition,
} from "@/lib/attendance-punch-policy";
import { apiErrorMessage, cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";
import { FaceScannerDialog } from "@/components/biometrics/face-scanner-dialog";
import type { SelfAttendance } from "@/lib/mock/hrms";
import {
  useCheckIn,
  useCheckOut,
  useGeofence,
  useMyAttendance,
  useShifts,
} from "@/lib/queries/hrms";

/**
 * Punch time for display. Prefers the server's `checkInLocal`/`checkOutLocal`,
 * which are already rendered in the STORE's timezone — a device roaming on
 * another zone (or with a hand-set clock) would otherwise show the staffer a
 * time their store never ran on. Falls back to local formatting of the instant.
 */
function punchTime(local: string | null | undefined, iso: string | null): string {
  if (local) return local;
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Wed 8 Jul" from a YYYY-MM-DD (parsed as local — no tz drift). */
function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Minutes → "6h 20m" / "45m". */
function formatWorked(mins: number | null): string {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Best-effort browser geolocation. Resolves the coords, or null when the API is
 * unsupported / permission is denied / the fix times out. The caller is lenient:
 * a null just means the punch records without geo-verification (backend allows it).
 */
function getPosition(): Promise<PunchPosition | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

/** Haversine distance in metres — mirrors the server's geofence maths. */
/** The geo outcome of the last / today's check-in. */
function GeoResult({
  record,
  missed,
}: {
  record: SelfAttendance;
  missed: boolean;
}) {
  if (missed) {
    return (
      <Badge variant="warning" className="gap-1">
        <MapPin className="h-3 w-3" />
        Location not captured
      </Badge>
    );
  }
  if (record.withinFence) {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Within range
      </Badge>
    );
  }
  return (
    <Badge variant="warning" className="gap-1">
      <AlertTriangle className="h-3 w-3" />
      Outside store range
      {record.checkInDistanceM != null ? ` — ${record.checkInDistanceM} m` : ""}
    </Badge>
  );
}

/**
 * "My Attendance" — self-service phone geo punch (Module 6, Zoho-informed).
 * Any staffer punches in/out from their own device; geolocation is captured on
 * the button press and posted with the punch. Store-scoped via the api client's
 * X-Store-Id header (the active store).
 */
export function GeoPunchCard() {
  const { user } = useSession();
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data, isLoading, isError, refetch } = useMyAttendance(month);
  const { data: shifts = [] } = useShifts();
  const { data: fence } = useGeofence();
  const checkIn = useCheckIn();
  const checkOut = useCheckOut();

  const [shiftId, setShiftId] = useState<string>("");
  // Immediate result of the latest punch (before the refetch lands).
  const [lastPunch, setLastPunch] = useState<SelfAttendance | null>(null);
  // True when the latest check-in couldn't capture a location.
  const [geoMissed, setGeoMissed] = useState(false);
  /**
   * The out-of-fence prompt. The API refuses an off-site punch that carries no
   * reason (400), so rather than letting the user hit that wall we detect the
   * distance client-side, ask why, and re-send with the note attached.
   */
  const [reasonFor, setReasonFor] = useState<"in" | "out" | null>(null);
  const [reason, setReason] = useState("");
  const [pendingDecision, setPendingDecision] = useState<PunchLocationDecision | null>(null);
  const [pendingPos, setPendingPos] = useState<PunchPosition | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null);
  /**
   * The camera sheet, and which punch it is for.
   *
   * This card and the standalone /check-in screen are two ways to make the same
   * punch, and only the other one could take a photo — so whether a punch
   * carried evidence depended on which button the staffer happened to press,
   * and a manager reviewing a suspicious one would find half of them blank for
   * no reason. Optional on both, and neither punch is gated behind it.
   */
  const [cameraFor, setCameraFor] = useState<"in" | "out" | null>(null);

  // Delete the old local-only pseudo-enrolment for this account. Those values
  // were photos, not biometric templates, and must not survive as auth state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.removeItem(`eclat_face_photo_${user.id}`);
    if (user.email) localStorage.removeItem(`eclat_face_photo_${user.email}`);
  }, [user.email, user.id]);

  const today = lastPunch ?? data?.today ?? null;
  const records = data?.records ?? [];
  const punching = checkIn.isPending || checkOut.isPending;

  const checkedIn = !!today?.checkInAt;
  const checkedOut = !!today?.checkOutAt;

  function submitCheckIn(
    pos: PunchPosition | null,
    note?: string,
    photo?: string,
  ) {
    const captured = pos != null;
    checkIn.mutate(
      {
        // No fix → no coordinates. 0/0 is Null Island, 8,200 km from the store.
        ...(pos ? { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM } : {}),
        shiftId: shiftId || undefined,
        ...(note ? { note } : {}),
        ...(photo ? { photo } : {}),
      },
      {
        onSuccess: (row) => {
          setLastPunch(row);
          setReasonFor(null);
          setReason("");
          setPendingDecision(null);
          setPendingPos(null);
          setPendingPhoto(null);
          setCameraFor(null);
          toast.success("Checked in", {
            description: !captured
              ? "Location not verified."
              : row.withinFence
                ? "Within store range."
                : `Recorded off-site${
                    row.checkInDistanceM != null
                      ? ` — ${row.checkInDistanceM} m away`
                      : ""
                  }. Your manager will review it.`,
          });
        },
        onError: (err: unknown) =>
          toast.error(apiErrorMessage(err, "Could not check in. Please try again.")),
      },
    );
  }

  function submitCheckOut(
    pos: PunchPosition | null,
    note?: string,
    photo?: string,
  ) {
    checkOut.mutate(
      {
        ...(pos ? { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM } : {}),
        ...(note ? { note } : {}),
        ...(photo ? { photo } : {}),
      },
      {
        onSuccess: (row) => {
          setLastPunch(row);
          setReasonFor(null);
          setReason("");
          setPendingDecision(null);
          setPendingPos(null);
          setPendingPhoto(null);
          setCameraFor(null);
          toast.success("Checked out", {
            description: `Worked ${formatWorked(row.workedMins)}${
              row.overtimeMins ? ` · ${formatWorked(row.overtimeMins)} overtime` : ""
            }.`,
          });
        },
        onError: (err: unknown) =>
          toast.error(
            apiErrorMessage(err, "Could not check out. You may not be checked in."),
          ),
      },
    );
  }

  function preparePunch(
    which: "in" | "out",
    pos: PunchPosition | null,
    photo?: string,
  ) {
    const decision = evaluatePunchLocation(pos, fence);
    const action = punchAction(decision, which);
    if (which === "in") setGeoMissed(pos == null);

    if (action === "block") {
      setCameraFor(null);
      toast.error("Check-in blocked outside the store range", {
        description: `You are ${decision.distanceM ?? "outside"} m away (allowed: ${fence?.geofenceRadiusM ?? 0} m). Move within range or ask a manager to regularize attendance.`,
      });
      return;
    }

    if (action === "reason") {
      setCameraFor(null);
      setPendingPos(pos);
      setPendingPhoto(photo ?? null);
      setPendingDecision(decision);
      setReasonFor(which);
      return;
    }

    if (which === "in") submitCheckIn(pos, undefined, photo);
    else submitCheckOut(pos, undefined, photo);
  }

  async function handleCheckIn() {
    preparePunch("in", await getPosition());
  }

  async function handleCheckOut() {
    preparePunch("out", await getPosition());
  }

  /**
   * A photo was taken. From here it is the ordinary punch: get a fix, apply the
   * same geofence rules, and send the still along with it.
   *
   * The photo never changes whether the punch is ALLOWED. An off-site check-in
   * is still refused with a photo, and a punch with no photo is a completely
   * normal punch.
   */
  async function punchWithPhoto(photo: string) {
    const which = cameraFor;
    if (!which) return;
    preparePunch(which, await getPosition(), photo);
  }

  function submitReason() {
    const note = reason.trim();
    if (!note) return;
    if (reasonFor === "in") submitCheckIn(pendingPos, note, pendingPhoto ?? undefined);
    else submitCheckOut(pendingPos, note, pendingPhoto ?? undefined);
  }

  const staffName = user.name;
  const storeName = fence?.storeName ?? null;

  return (
    <>
    <Card className="facet-top overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            My attendance
          </CardTitle>
          <CardDescription>
            Punch in and out from your phone. Your location is captured to verify
            you&apos;re at the store.
          </CardDescription>
        </div>
        <Badge variant="outline" className="shrink-0">
          {formatDayLabel(new Date().toISOString().slice(0, 10))}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Logged-in employee identity — name + id/email, like the
            EzAttendancePro dashboard header. */}
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-3">
            <Avatar className="h-9 w-9 border border-border">
              <AvatarFallback className="text-xs font-semibold">{user.initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="num truncate text-xs text-muted-foreground">
                {user.email || `ID ${user.id.slice(0, 8)}`}
              </p>
            </div>
          </div>
          <Badge variant="outline" className="text-[10px]">
            Signed-in account
          </Badge>
        </div>

        {isLoading ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : isError ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load your attendance.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </div>
        ) : reasonFor ? (
          /* Collect the explanation the server requires before sending. */
          <div className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-4">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {pendingDecision?.state === "unavailable"
                    ? "Location is unavailable"
                    : pendingDecision?.state === "imprecise"
                      ? "GPS accuracy cannot confirm your location"
                      : `You are ${pendingDecision?.distanceM ?? "outside"} m from ${fence?.storeName ?? "the store"}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Add a reason for this {reasonFor === "in" ? "check-in" : "check-out"}.
                  It will be recorded for manager review.
                </p>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="punch-reason">Reason</Label>
              <Textarea
                id="punch-reason"
                rows={2}
                maxLength={300}
                value={reason}
                placeholder="e.g. Customer home visit at Jubilee Hills"
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="gold"
                disabled={punching || !reason.trim()}
                onClick={submitReason}
              >
                {punching
                  ? "Recording…"
                  : `Record ${reasonFor === "in" ? "check-in" : "check-out"}`}
              </Button>
              <Button
                variant="outline"
                disabled={punching}
                onClick={() => {
                  setReasonFor(null);
                  setReason("");
                  setPendingDecision(null);
                  setPendingPos(null);
                  setPendingPhoto(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border bg-card p-4">
            {/* --- Not checked in yet -------------------------------- */}
            {!checkedIn ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  You haven&apos;t checked in today.
                </p>
                {shifts.length > 0 ? (
                  <div className="grid gap-1.5 sm:max-w-xs">
                    <Label htmlFor="punch-shift">Shift / batch</Label>
                    <Select value={shiftId} onValueChange={setShiftId}>
                      <SelectTrigger id="punch-shift">
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
                  </div>
                ) : null}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="gold"
                    size="lg"
                    className="w-full sm:w-auto"
                    disabled={punching}
                    onClick={handleCheckIn}
                  >
                    <LogIn className="h-4 w-4" />
                    {checkIn.isPending ? "Checking in…" : "Check in"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full sm:w-auto"
                    disabled={punching}
                    onClick={() => setCameraFor("in")}
                  >
                    <Camera className="h-4 w-4" />
                    Add optional photo
                  </Button>
                </div>
              </div>
            ) : null}

            {/* --- Checked in, not out ------------------------------- */}
            {checkedIn && !checkedOut ? (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-muted-foreground">
                      Checked in at
                    </span>
                    <span className="num text-2xl font-semibold">
                      {punchTime(today!.checkInLocal, today!.checkInAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <GeoResult record={today!} missed={geoMissed} />
                    {today!.isLate ? (
                      <Badge variant="warning" className="gap-1">
                        <Clock className="h-3 w-3" />
                        {today!.lateMinutes
                          ? `Late ${today!.lateMinutes}m`
                          : "Late"}
                      </Badge>
                    ) : (
                      <Badge variant="success" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        On time
                      </Badge>
                    )}
                    {today!.isMockLocation ? (
                      <Badge variant="destructive" className="gap-1">
                        <ShieldAlert className="h-3 w-3" />
                        Mock location
                      </Badge>
                    ) : null}
                  </div>
                  {today!.checkInNote ? (
                    <p className="text-xs text-muted-foreground">
                      Reason: {today!.checkInNote}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    size="lg"
                    variant="outline"
                    className="w-full sm:w-auto"
                    disabled={punching}
                    onClick={handleCheckOut}
                  >
                    <LogOut className="h-4 w-4" />
                    {checkOut.isPending ? "Checking out…" : "Check out"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full sm:w-auto"
                    disabled={punching}
                    onClick={() => setCameraFor("out")}
                  >
                    <Camera className="h-4 w-4" />
                    Add optional photo
                  </Button>
                </div>
              </div>
            ) : null}

            {/* --- Checked out --------------------------------------- */}
            {checkedIn && checkedOut ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div>
                  <p className="text-xs text-muted-foreground">In</p>
                  <p className="num text-lg font-semibold">
                    {punchTime(today!.checkInLocal, today!.checkInAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Out</p>
                  <p className="num text-lg font-semibold">
                    {punchTime(today!.checkOutLocal, today!.checkOutAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Worked</p>
                  <p className="num text-lg font-semibold text-success">
                    {formatWorked(today!.workedMins)}
                  </p>
                </div>
                {today!.overtimeMins ? (
                  <div>
                    <p className="text-xs text-muted-foreground">Overtime</p>
                    <p className="num text-lg font-semibold text-warning">
                      {formatWorked(today!.overtimeMins)}
                    </p>
                  </div>
                ) : null}
                {today!.earlyOutMinutes ? (
                  <div>
                    <p className="text-xs text-muted-foreground">Left early</p>
                    <p className="num text-lg font-semibold text-warning">
                      {formatWorked(today!.earlyOutMinutes)}
                    </p>
                  </div>
                ) : null}
                {/* Payroll credit — a short day is worth half, and the staffer
                    should see that before payroll runs, not after. */}
                {today!.dayFraction != null && today!.dayFraction < 1 ? (
                  <Badge variant="warning" className="gap-1">
                    <Timer className="h-3 w-3" />
                    {today!.dayFraction === 0.5 ? "Half day" : "Short day"}
                  </Badge>
                ) : (
                  <Badge variant="success" className="gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Day complete
                  </Badge>
                )}
                {today!.autoClosed ? (
                  <Badge variant="warning" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Auto-closed — regularize if wrong
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {/* --- This month's punch list ------------------------------ */}
        {!isLoading && !isError ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">This month</p>
            {records.length === 0 ? (
              <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                No attendance recorded this month yet.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-left font-medium">In</th>
                      <th className="px-3 py-2 text-left font-medium">Out</th>
                      <th className="px-3 py-2 text-right font-medium">Worked</th>
                      <th className="px-3 py-2 text-right font-medium">Geo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="px-3 py-2">{formatDayLabel(r.date)}</td>
                        <td className="num px-3 py-2">
                          <span
                            className={cn(
                              r.isLate && "text-warning",
                            )}
                          >
                            {punchTime(r.checkInLocal, r.checkInAt)}
                          </span>
                          {r.isLate ? (
                            <span className="ml-1 text-xs text-warning">late</span>
                          ) : null}
                        </td>
                        <td className="num px-3 py-2">
                          {punchTime(r.checkOutLocal, r.checkOutAt)}
                        </td>
                        <td className="num px-3 py-2 text-right">
                          {formatWorked(r.workedMins)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.checkInAt ? (
                            r.withinFence ? (
                              <span className="text-success">within</span>
                            ) : (
                              <span className="text-warning">
                                {r.checkInDistanceM != null
                                  ? `${r.checkInDistanceM} m`
                                  : "outside"}
                              </span>
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>

      {/*
        Optional evidence, on the same terms as the standalone check-in screen:
        started by a tap, never a gate, and it makes no claim about WHO the
        photo shows. See FaceScannerDialog.
      */}
      <FaceScannerDialog
        open={cameraFor !== null}
        onOpenChange={(next) => {
          if (!next) setCameraFor(null);
        }}
        onCapture={(photo) => void punchWithPhoto(photo)}
        busy={punching}
        title={cameraFor === "out" ? "Check-out photo" : "Attendance photo"}
        confirmLabel={cameraFor === "out" ? "Check out" : "Check in"}
        context={{
          staffName,
          storeName,
          action: cameraFor === "out" ? "Check out" : "Check in",
        }}
      />

    </>
  );
}
