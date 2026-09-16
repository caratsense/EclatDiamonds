"use client";

import { useMemo, useState } from "react";
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
function getPosition(): Promise<{ lat: number; lng: number; accuracyM?: number } | null> {
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
function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

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
  const [pendingDistance, setPendingDistance] = useState<number | null>(null);
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

  const [enrolledPhoto, setEnrolledPhoto] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return (
      localStorage.getItem(`eclat_face_photo_${user.id}`) ||
      (user.email ? localStorage.getItem(`eclat_face_photo_${user.email}`) : null)
    );
  });
  const [enrollCameraOpen, setEnrollCameraOpen] = useState(false);

  const today = lastPunch ?? data?.today ?? null;
  const records = data?.records ?? [];
  const punching = checkIn.isPending || checkOut.isPending;

  const checkedIn = !!today?.checkInAt;
  const checkedOut = !!today?.checkOutAt;

  /**
   * Distance from the store, computed on-device so we can prompt for a reason
   * BEFORE the request. Null when either the fix or the store's coordinates are
   * missing, in which case there is nothing to be outside of.
   */
  function offsiteDistance(pos: { lat: number; lng: number } | null): number | null {
    if (!pos || !fence?.hasCoords || fence.latitude == null || fence.longitude == null) {
      return null;
    }
    const d = distanceM(pos, { lat: fence.latitude, lng: fence.longitude });
    return d > fence.geofenceRadiusM ? d : null;
  }

  function submitCheckIn(
    pos: { lat: number; lng: number; accuracyM?: number } | null,
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
    pos: { lat: number; lng: number; accuracyM?: number } | null,
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

  /** Coordinates captured for the punch currently waiting on a reason. */
  const [pendingPos, setPendingPos] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  async function handleCheckIn() {
    const pos = await getPosition();
    const captured = pos != null;
    setGeoMissed(!captured);
    if (!captured) {
      toast.error("Couldn't capture your location", {
        description:
          "Recording the check-in without geo-verification — a manager can regularize it.",
      });
    }
    const away = offsiteDistance(pos);
    if (away != null) {
      // A check-in from outside the store geofence is not allowed (the backend
      // rejects it too) — block it here with a clear message rather than
      // prompting for a reason. Check-OUT stays lenient (see handleCheckOut).
      toast.error("You're outside the store's range", {
        description: `You're ${away} m away (allowed: ${fence?.geofenceRadiusM ?? 0} m). You must be at the store to check in.`,
      });
      return;
    }
    submitCheckIn(pos);
  }

  async function handleCheckOut() {
    const pos = await getPosition();
    if (!pos) {
      toast.error("Couldn't capture your location", {
        description: "Recording the check-out without geo-verification.",
      });
    }
    const away = offsiteDistance(pos);
    if (away != null) {
      setPendingPos(pos);
      setPendingDistance(away);
      setReasonFor("out");
      return;
    }
    submitCheckOut(pos);
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
    const pos = await getPosition();

    if (which === "in") {
      setGeoMissed(pos == null);
      const away = offsiteDistance(pos);
      if (away != null) {
        setCameraFor(null);
        toast.error("Outside the store range", {
          description: `You are ${away} m away (allowed: ${fence?.geofenceRadiusM ?? 0} m). You must be at the store to check in.`,
        });
        return;
      }
      submitCheckIn(pos, undefined, photo);
      return;
    }

    const away = offsiteDistance(pos);
    if (away != null) {
      // Same lenient path as an ordinary check-out: ask why, then send. The
      // photo is dropped here rather than held across the prompt — a reason box
      // is a detour, and a stale frame filed minutes later is worse evidence
      // than none.
      setCameraFor(null);
      setPendingPos(pos);
      setPendingDistance(away);
      setReasonFor("out");
      return;
    }
    submitCheckOut(pos, undefined, photo);
  }

  function submitReason() {
    const note = reason.trim();
    if (!note) return;
    if (reasonFor === "in") submitCheckIn(pendingPos, note);
    else submitCheckOut(pendingPos, note);
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
              {enrolledPhoto ? (
                <img
                  src={enrolledPhoto}
                  alt={user.name}
                  className="h-full w-full object-cover rounded-full"
                />
              ) : (
                <AvatarFallback className="text-xs font-semibold">{user.initials}</AvatarFallback>
              )}
            </Avatar>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="num truncate text-xs text-muted-foreground">
                {user.email || `ID ${user.id.slice(0, 8)}`}
              </p>
            </div>
          </div>
          {enrolledPhoto ? (
            <Badge variant="outline" className="text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1">
              <CheckCircle2 className="h-3 w-3" /> Face Enrolled
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-500/40 gap-1">
              <AlertTriangle className="h-3 w-3" /> Face Pending
            </Badge>
          )}
        </div>

        {/* Profile Incomplete / Face Enrollment Banner */}
        {!enrolledPhoto ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-200 shadow-xs">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-md bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                      Profile Incomplete
                    </span>
                    <span className="text-sm font-semibold text-amber-950 dark:text-amber-100">
                      Face Reference Photo Required
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80 leading-relaxed">
                    Capture your face reference photo once so managers can verify your daily punch-in and punch-out (login / logout) records.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => setEnrollCameraOpen(true)}
                className="self-start sm:self-center shrink-0 bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs rounded-lg px-3.5 py-2 gap-1.5 shadow-xs"
              >
                <Camera className="h-3.5 w-3.5" />
                Enrol Face Photo
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-800 dark:text-emerald-200">
            <div className="flex items-center gap-2.5">
              <img
                src={enrolledPhoto}
                alt="Enrolled Face"
                className="h-7 w-7 rounded-full object-cover border border-emerald-500/40"
              />
              <div>
                <span className="font-semibold text-emerald-950 dark:text-emerald-100">
                  Profile Complete
                </span>
                <span className="ml-2 text-emerald-700 dark:text-emerald-300/80 text-[11px]">
                  Face reference photo enrolled for login/logout verification
                </span>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEnrollCameraOpen(true)}
              className="h-7 text-[11px] text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
            >
              Update photo
            </Button>
          </div>
        )}

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
          /* --- Off-site punch: collect a reason before sending ------
             The API refuses an out-of-fence punch without one, so we ask
             here instead of letting the request fail. The punch itself is
             never blocked — it just has to be explained, and it lands in
             the manager's review queue. */
          <div className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-4">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  You&apos;re{" "}
                  {pendingDistance != null ? `${pendingDistance} m ` : ""}
                  away from {fence?.storeName ?? "the store"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Tell your manager why you&apos;re punching {reasonFor === "in" ? "in" : "out"}{" "}
                  from here. The punch is recorded either way.
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
                  {/* An addition to the punch, never a gate in front of it. */}
                  <Button
                    variant="outline"
                    size="lg"
                    className="w-full sm:w-auto"
                    disabled={punching}
                    onClick={() => setCameraFor("in")}
                  >
                    <Camera className="h-4 w-4" />
                    With a photo
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
                    size="lg"
                    variant="ghost"
                    className="w-full sm:w-auto"
                    disabled={punching}
                    onClick={() => setCameraFor("out")}
                  >
                    <Camera className="h-4 w-4" />
                    With a photo
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

      {/* Profile Face Enrollment Dialog */}
      <FaceScannerDialog
        open={enrollCameraOpen}
        onOpenChange={setEnrollCameraOpen}
        title="Enrol Face Photo"
        confirmLabel="Save Profile Photo"
        context={{
          staffName: user.name,
          storeName,
          action: "Profile Face Enrollment",
        }}
        onCapture={(photo) => {
          if (typeof window !== "undefined") {
            localStorage.setItem(`eclat_face_photo_${user.id}`, photo);
            if (user.email) {
              localStorage.setItem(`eclat_face_photo_${user.email}`, photo);
            }
          }
          setEnrolledPhoto(photo);
          setEnrollCameraOpen(false);
          toast.success("Profile photo enrolled!", {
            description: "Your reference face photo is saved for attendance verification.",
          });
        }}
      />
    </>
  );
}
