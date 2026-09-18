"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  Loader2,
  LogIn,
  MapPin,
  Navigation,
} from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { homeForRole } from "@/lib/navigation";
import { useEnabledNavigation } from "@/lib/queries/tenant-config";
import { markAttendanceHandled } from "@/lib/attendance-gate";
import { useSession } from "@/store/use-session";
import type { SelfAttendance } from "@/lib/mock/hrms";
import { useCheckIn, useGeofence, useMyAttendance } from "@/lib/queries/hrms";
import { FaceScannerDialog } from "@/components/biometrics/face-scanner-dialog";
import { apiErrorMessage } from "@/lib/utils";
import { useHydrated } from "@/lib/use-reset-on";
import {
  evaluatePunchLocation,
  punchAction,
  type PunchLocationDecision,
  type PunchPosition,
} from "@/lib/attendance-punch-policy";

/** HH:mm from an ISO instant, or an em-dash. */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Time-of-day greeting for the current hour: "Good morning" before noon,
 * "Good afternoon" before 5 pm, otherwise "Good evening".
 */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** "Wednesday, 8 July" for today's header. */
function todayLabel(): string {
  return new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Human distance: nearest 5 m under 1 km, else km with one decimal. */
function formatDistance(m: number): string {
  if (m >= 1000) {
    return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  }
  return `${Math.round(m / 5) * 5} m`;
}

/**
 * Best-effort one-shot browser geolocation. Resolves the coords, or null when
 * the API is unsupported / permission is denied / the fix times out. The caller
 * is lenient: a null just means the punch records without geo-verification.
 * Used by the manual fallback (the automatic flow uses watchPosition).
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

/** The range chip for a landed check-in. */
function RangeChip({ record }: { record: SelfAttendance }) {
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
      Outside range
      {record.checkInDistanceM != null ? ` · ${record.checkInDistanceM} m` : ""}
    </Badge>
  );
}

/**
 * Attendance-first check-in — the salesperson's landing screen after sign-in.
 * Mobile-first (large tap targets, works at 375px).
 *
 * When the day isn't handled yet and the store has coordinates, it watches the
 * device location and AUTO checks the salesperson in the moment they come within
 * the store's geofence radius — a returning salesperson just has to be near the
 * store and the app welcomes them. Manual check-in and "Skip for now" remain
 * available. A confirmed outside check-in is blocked; an unavailable
 * or inconclusive fix can continue only with a written reason.
 */
export default function CheckInPage() {
  const router = useRouter();
  const { user, role, currentStore } = useSession();
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data, isLoading, isError, refetch } = useMyAttendance(month);
  const { data: geofence, isLoading: geoLoading } = useGeofence();
  const checkIn = useCheckIn();

  // Immediate result of a fresh punch (before the refetch lands).
  const [lastPunch, setLastPunch] = useState<SelfAttendance | null>(null);
  // True when the fresh check-in couldn't capture a location.
  const [geoMissed, setGeoMissed] = useState(false);
  // Latest watched position (drives the live distance card). Null until first fix.
  const [watchPos, setWatchPos] = useState<PunchPosition | null>(null);
  // True once the browser denies permission / geolocation is unsupported.
  // Permission refusals arrive from the browser and are state; "this device has
  // no geolocation API at all" is a fact about the device, read below rather
  // than copied into state by an effect.
  const [permissionDenied, setGeoDenied] = useState(false);
  const hydrated = useHydrated();
  // Missing or inconclusive GPS needs a written reason before the API records it.
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pendingPos, setPendingPos] = useState<PunchPosition | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PunchLocationDecision | null>(null);
  // The camera sheet, and the still it produced. The photo survives a detour
  // through the off-site reason box, so someone who took a photo and then had
  // to explain their location does not have to take it again.
  const [scannerOpen, setScannerOpen] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null);

  // watchPosition handle, so we can clearWatch on unmount / after a punch.
  const watchIdRef = useRef<number | null>(null);
  // Freshest coords for the auto-punch, without waiting on a state flush.
  const latestPosRef = useRef<PunchPosition | null>(null);
  // Fires the auto check-in exactly once; also set by the manual button so the
  // watcher never double-punches.
  const punchedRef = useRef(false);
  // Pending redirect after a successful punch (cleared on unmount).
  const redirectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enabledNavigation = useEnabledNavigation();
  const firstName = user.name.split(" ")[0] || user.name;
  // With the tenant's navigation, so a manager whose industry has no Dashboards
  // is not bounced from the attendance gate onto a screen their product omits.
  const home = homeForRole(role, enabledNavigation);
  const storeName = geofence?.storeName ?? currentStore.name;
  const radius = geofence?.geofenceRadiusM ?? 0;

  const today = lastPunch ?? data?.today ?? null;
  const alreadyIn = !lastPunch && !!data?.today?.checkInAt;

  const liveDecision = useMemo(
    () => evaluatePunchLocation(watchPos, geofence),
    [watchPos, geofence],
  );
  const distanceM = liveDecision.distanceM;
  const inRange = liveDecision.state === "inside";

  /** Stop the geofence watcher if one is running. */
  function clearWatcher() {
    if (
      watchIdRef.current != null &&
      typeof navigator !== "undefined" &&
      navigator.geolocation
    ) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
  }

  /** Toast description for a landed punch. */
  function describePunch(row: SelfAttendance, captured: boolean): string {
    if (!captured) return "Location unavailable — recorded without GPS.";
    if (row.withinFence) return "Within store range.";
    return `Outside store range${
      row.checkInDistanceM != null ? ` · ${row.checkInDistanceM} m` : ""
    }.`;
  }

  /**
   * The single check-in path — shared by the auto-punch and the manual button.
   *
   * `note` explains a punch the server cannot verify (outside the fence, or no
   * GPS fix at all). The API rejects those without one, so the UI collects it
   * first; see {@link startManual}.
   */
  function runCheckIn(
    pos: PunchPosition | null,
    note?: string,
    photo?: string | null,
  ) {
    const captured = pos != null;
    setGeoMissed(!captured);
    checkIn.mutate(
      // Omit the coordinates entirely when there is no fix. Sending 0/0 put the
      // punch at Null Island, 8,200 km away, and the server rightly refused it.
      {
        ...(pos ? { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM } : {}),
        ...(note ? { note } : {}),
        ...(photo ? { photo } : {}),
      },
      {
        onSuccess: (row) => {
          clearWatcher(); // clear the watch immediately after a successful punch
          setLastPunch(row);
          setReasonOpen(false);
          setReason("");
          setPendingDecision(null);
          setPendingPos(null);
          setScannerOpen(false);
          setPendingPhoto(null);
          markAttendanceHandled();
          toast.success("Attendance marked", {
            description: describePunch(row, captured),
          });
          // Auto-advance to the salesperson's home shortly after the welcome shows.
          redirectRef.current = setTimeout(() => router.replace(home), 1800);
        },
        onError: (err) => {
          // Allow the watcher (still running) to retry on a later fix.
          punchedRef.current = false;
          // Show what the server actually said. "Please try again" was both
          // wrong and unhelpful here: retrying an unexplained off-site punch
          // fails identically every time, and the real message says why.
          toast.error(
            apiErrorMessage(err, "Could not mark attendance. Please try again."),
          );
        },
      },
    );
  }

  // --- Geofence watcher: only while unhandled + the store has coordinates. ---
  useEffect(() => {
    if (alreadyIn || lastPunch) return;
    if (!geofence?.hasCoords) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy };
        latestPosRef.current = next;
        setWatchPos(next);
        setGeoDenied(false);
      },
      (err) => {
        // Permission denied / unsupported → fall back to the manual button.
        // Transient errors (timeout, position unavailable) keep the watch alive.
        if (err.code === err.PERMISSION_DENIED) setGeoDenied(true);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
    watchIdRef.current = id;
    return () => {
      if (
        watchIdRef.current === id &&
        typeof navigator !== "undefined" &&
        navigator.geolocation
      ) {
        navigator.geolocation.clearWatch(id);
        watchIdRef.current = null;
      }
    };
  }, [alreadyIn, lastPunch, geofence?.hasCoords]);

  // Either reason puts the screen on the manual-check-in fallback.
  const geoUnsupported = hydrated && !navigator.geolocation;
  const geoDenied = permissionDenied || geoUnsupported;

  // --- Auto-fire the check-in once, the moment we land inside the fence. ---
  useEffect(() => {
    if (punchedRef.current || checkIn.isPending) return;
    if (alreadyIn || lastPunch) return;
    if (!inRange) return;
    punchedRef.current = true;
    runCheckIn(latestPosRef.current);
    // runCheckIn is stable enough for this fire-once effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRange, alreadyIn, lastPunch, checkIn.isPending]);

  // --- Cleanup on unmount: stop the watcher + cancel any pending redirect. ---
  useEffect(() => {
    return () => {
      clearWatcher();
      if (redirectRef.current) clearTimeout(redirectRef.current);
    };
  }, []);

  // Already checked in when the page loaded (not a fresh punch): mark handled
  // and gently auto-advance. Fresh punches schedule their own redirect.
  useEffect(() => {
    if (lastPunch || !data?.today?.checkInAt) return;
    markAttendanceHandled();
    const t = setTimeout(() => router.replace(home), 1000);
    return () => clearTimeout(t);
  }, [lastPunch, data, home, router]);

  /** Mark the day handled + leave to the salesperson's home. */
  function goHome() {
    markAttendanceHandled();
    router.replace(home);
  }

  function skip() {
    clearWatcher();
    markAttendanceHandled();
    router.replace(home);
  }

  function prepareCheckIn(pos: PunchPosition | null, photo?: string) {
    const decision = evaluatePunchLocation(pos, geofence);
    const action = punchAction(decision, "in");
    if (action === "block") {
      punchedRef.current = false;
      setScannerOpen(false);
      toast.error("Check-in blocked outside the store range", {
        description: `You are ${formatDistance(decision.distanceM ?? 0)} away. Move within ${radius} m or ask a manager to regularize attendance.`,
      });
      return;
    }
    if (action === "reason") {
      setPendingPos(pos);
      setPendingPhoto(photo ?? null);
      setPendingDecision(decision);
      setScannerOpen(false);
      setReasonOpen(true);
      return;
    }
    runCheckIn(pos, undefined, photo);
  }

  /** Manual check-in follows the same policy as the automatic path. */
  async function startManual() {
    if (checkIn.isPending) return;
    punchedRef.current = true; // stop the watcher from also firing
    prepareCheckIn(await getPosition());
  }

  /** Send the off-site punch once the reason has been written. */
  function submitWithReason() {
    const note = reason.trim();
    if (!note) return;
    runCheckIn(pendingPos, note, pendingPhoto);
  }

  /**
   * A photo was taken. From here it is the ordinary punch: get a fix, and if it
   * is outside the fence ask for the reason the server already requires.
   *
   * The photo never changes whether the punch is allowed. It is recorded beside
   * it, and a punch with no photo remains a completely normal punch.
   */
  async function punchWithPhoto(photo: string) {
    punchedRef.current = true; // stop the watcher from also firing
    prepareCheckIn(await getPosition(), photo);
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-8">
      <Card className="facet-top overflow-hidden">
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl">Good day, {firstName}</CardTitle>
          <CardDescription>
            {todayLabel()}
            <span className="mt-1 flex items-center justify-center gap-1.5 text-sm font-medium text-foreground">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              {storeName}
            </span>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {reasonOpen ? (
            /* Missing or inconclusive GPS: collect the reason required by the API. */
            <div className="space-y-4">
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
                <p className="text-sm font-medium">
                  {pendingDecision?.state === "imprecise"
                    ? "GPS accuracy cannot confirm your location"
                    : "We couldn't read your location"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add a reason to continue. The check-in and your note will be
                  recorded for manager review.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="checkin-reason">Reason</Label>
                <Textarea
                  id="checkin-reason"
                  rows={3}
                  maxLength={300}
                  autoFocus
                  placeholder="e.g. Visiting a client before the shop opens"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <Button
                variant="gold"
                size="lg"
                className="h-12 w-full text-base"
                disabled={checkIn.isPending || !reason.trim()}
                onClick={submitWithReason}
              >
                {checkIn.isPending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Marking…
                  </>
                ) : (
                  <>
                    <LogIn className="h-5 w-5" />
                    Record check-in
                  </>
                )}
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => {
                    setReasonOpen(false);
                    setReason("");
                    setPendingDecision(null);
                    setPendingPos(null);
                    setPendingPhoto(null);
                    punchedRef.current = false; // let the watcher try again
                  }}
                  className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Back
                </button>
              </div>
            </div>
          ) : isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-14 rounded-xl" />
            </div>
          ) : isError ? (
            <div className="rounded-xl border bg-muted/30 p-5 text-center">
              <p className="text-sm font-medium">
                Couldn&apos;t load your attendance.
              </p>
              <Button
                variant="outline"
                size="lg"
                className="mt-4 w-full"
                onClick={() => refetch()}
              >
                Retry
              </Button>
              <button
                type="button"
                onClick={skip}
                className="mt-3 text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Skip for now
              </button>
            </div>
          ) : lastPunch ? (
            /* ── Welcome — a fresh punch just landed ───────────────── */
            <div className="space-y-5">
              <div className="rounded-xl border bg-card p-6 text-center">
                <CheckCircle2 className="mx-auto h-14 w-14 text-success animate-in zoom-in duration-500" />
                <p className="mt-4 text-xl font-semibold">
                  {greeting()}, {firstName}
                </p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  You&apos;re signed in
                </p>
                <p className="text-sm text-muted-foreground">
                  Welcome to {storeName}
                </p>
                <p className="num mt-3 text-2xl font-semibold">
                  Signed in at {formatTime(lastPunch.checkInAt)}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {geoMissed ? (
                    <Badge variant="warning" className="gap-1">
                      <MapPin className="h-3 w-3" />
                      Location not captured
                    </Badge>
                  ) : (
                    <RangeChip record={lastPunch} />
                  )}
                  {lastPunch.isLate ? (
                    <Badge variant="warning" className="gap-1">
                      <Clock className="h-3 w-3" />
                      {lastPunch.lateMinutes
                        ? `Late ${lastPunch.lateMinutes}m`
                        : "Late"}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <Button
                variant="gold"
                size="lg"
                className="h-14 w-full text-base"
                onClick={goHome}
              >
                Continue to app
              </Button>
            </div>
          ) : alreadyIn ? (
            /* ── Already checked in when the page loaded ───────────── */
            <div className="space-y-5">
              <div className="rounded-xl border bg-card p-5 text-center">
                <CheckCircle2 className="mx-auto h-9 w-9 text-success" />
                <p className="mt-3 text-lg font-semibold">
                  {greeting()}, {firstName}
                </p>
                <p className="num mt-1 text-sm text-muted-foreground">
                  You&apos;re signed in for today ·{" "}
                  {formatTime(today!.checkInAt)}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <RangeChip record={today!} />
                  {today!.isLate ? (
                    <Badge variant="warning" className="gap-1">
                      <Clock className="h-3 w-3" />
                      {today!.lateMinutes
                        ? `Late ${today!.lateMinutes}m`
                        : "Late"}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <Button
                variant="gold"
                size="lg"
                className="h-14 w-full text-base"
                onClick={goHome}
              >
                Continue to app
              </Button>
            </div>
          ) : geoLoading ? (
            /* ── Waiting for the store geofence to load ────────────── */
            <div className="rounded-xl border bg-card p-6 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                Preparing your check-in…
              </p>
            </div>
          ) : !geofence?.hasCoords ? (
            /* ── No store coordinates → manual lenient punch only ──── */
            <div className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                You haven&apos;t marked attendance today. This store has no
                geofence configured, so attendance will be recorded without a
                range check.
              </p>
              <Button
                variant="gold"
                size="lg"
                className="h-14 w-full text-base"
                disabled={checkIn.isPending}
                onClick={startManual}
              >
                {checkIn.isPending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Marking…
                  </>
                ) : (
                  <>
                    <LogIn className="h-5 w-5" />
                    Mark attendance
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="mt-2 h-12 w-full text-base"
                disabled={checkIn.isPending}
                onClick={() => setScannerOpen(true)}
              >
                <Camera className="h-5 w-5" />
                Add optional photo
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Automatic detection unavailable for this store.
              </p>
              <div className="text-center">
                <button
                  type="button"
                  onClick={skip}
                  className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Skip for now
                </button>
              </div>
            </div>
          ) : geoDenied ? (
            /* ── Permission denied / unsupported → manual fallback ─── */
            <div className="space-y-4">
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-5 text-center">
                <MapPin className="mx-auto h-8 w-8 text-warning" />
                <p className="mt-3 text-sm font-medium">
                  Allow location to check in automatically
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  We couldn&apos;t read your position. Enable location access, or
                  check in manually below.
                </p>
              </div>
              <Button
                variant="gold"
                size="lg"
                className="h-14 w-full text-base"
                disabled={checkIn.isPending}
                onClick={startManual}
              >
                {checkIn.isPending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Marking…
                  </>
                ) : (
                  <>
                    <LogIn className="h-5 w-5" />
                    Continue with reason
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="mt-2 h-12 w-full text-base"
                disabled={checkIn.isPending}
                onClick={() => setScannerOpen(true)}
              >
                <Camera className="h-5 w-5" />
                Add optional photo
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  onClick={skip}
                  className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Skip for now
                </button>
              </div>
            </div>
          ) : inRange ? (
            /* ── In range → auto check-in firing ───────────────────── */
            <div className="rounded-xl border border-success/40 bg-success/10 p-6 text-center">
              <span className="relative mx-auto flex h-14 w-14 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/40" />
                <span className="relative inline-flex h-14 w-14 items-center justify-center rounded-full bg-success/15">
                  <Navigation className="h-7 w-7 text-success" />
                </span>
              </span>
              <p className="mt-4 text-base font-semibold">You&apos;re in range</p>
              <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking you in…
              </p>
            </div>
          ) : distanceM == null ? (
            /* ── Locating: watcher on, no fix yet ──────────────────── */
            <div className="rounded-xl border bg-card p-6 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">Locating you…</p>
              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={skip}
                  className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Skip for now
                </button>
              </div>
            </div>
          ) : (
            /* ── Outside range → live distance, closing the gap ────── */
            <div className="space-y-4">
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-5 text-center">
                <MapPin className="mx-auto h-8 w-8 text-warning" />
                <p className="mt-3 text-sm font-medium">
                  {liveDecision.state === "imprecise" ? (
                    "GPS accuracy cannot confirm your location"
                  ) : (
                    <>
                      You&apos;re <span className="num">{formatDistance(distanceM)}</span> from {storeName}
                    </>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {liveDecision.state === "imprecise" ? (
                    "You may continue with a reason, or wait for a more accurate GPS reading."
                  ) : (
                    <>Move closer — check-in is blocked until you are within <span className="num">{radius}</span> m.</>
                  )}
                </p>
              </div>
              {liveDecision.state === "imprecise" ? (
              <>
              <Button
                variant="secondary"
                size="lg"
                className="h-12 w-full text-base"
                disabled={checkIn.isPending}
                onClick={startManual}
              >
                {checkIn.isPending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Marking…
                  </>
                ) : (
                  <>
                    <LogIn className="h-5 w-5" />
                    Continue with reason
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="mt-2 h-12 w-full text-base"
                disabled={checkIn.isPending}
                onClick={() => setScannerOpen(true)}
              >
                <Camera className="h-5 w-5" />
                Add optional photo
              </Button>
              </>
              ) : null}
              <div className="text-center">
                <button
                  type="button"
                  onClick={skip}
                  className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Skip for now
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Optional evidence inside the punch flow; never an authentication step. */}
      <FaceScannerDialog
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onCapture={(photo) => void punchWithPhoto(photo)}
        busy={checkIn.isPending}
        title="Attendance photo"
        confirmLabel="Check in"
        // Who and where come from the session and the resolved geofence, never
        // from the picture — so the screen shows what the record WILL say, and
        // someone on the wrong branch notices before they file it.
        context={{ staffName: user.name, storeName, action: "Check in" }}
      />
    </div>
  );
}
