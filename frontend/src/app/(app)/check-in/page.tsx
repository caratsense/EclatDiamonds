"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  Loader2,
  LogIn,
  LogOut,
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
import { useCheckIn, useCheckOut, useGeofence, useMyAttendance } from "@/lib/queries/hrms";
import { FaceScannerDialog } from "@/components/biometrics/face-scanner-dialog";
import { apiErrorMessage } from "@/lib/utils";
import { useHydrated } from "@/lib/use-reset-on";
import {
  evaluatePunchLocation,
  formatDistance,
  isEarlierDay,
  keptShift,
  punchAction,
  punchScreen,
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

export default function CheckInPage() {
  // A new day starts the screen from scratch, so no punch, position or
  // half-written reason is carried over from the day before (startNewDay).
  const [day, setDay] = useState(0);
  return <CheckInScreen key={day} onNewDay={() => setDay((d) => d + 1)} />;
}

/**
 * Attendance-first check-in — the salesperson's landing screen after sign-in.
 * Mobile-first (large tap targets, works at 375px).
 *
 * When the day isn't handled yet and the store has coordinates, it watches the
 * device location and AUTO checks the salesperson in the moment they come within
 * the store's geofence radius — a returning salesperson just has to be near the
 * store and the app welcomes them. Manual check-in and "Skip for now" remain
 * available. Nothing is refused: a punch the fence cannot confirm — outside
 * it, no fix, or a fix too vague to tell — is recorded with a written reason
 * and reported to the branch manager and head office for regularisation.
 *
 * For someone whose home is this screen (attendance only, see homeForRole) it
 * is the whole app: Check in, then one big Check out, then "Done for today".
 * They are never sent on, so they are not offered "Skip for now" either. Left
 * open overnight it offers "Check in for today", and waits for that tap.
 */
function CheckInScreen({ onNewDay }: { onNewDay: () => void }) {
  const router = useRouter();
  const { user, role, currentStore, access } = useSession();
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data, isLoading, isError, isFetching, refetch } = useMyAttendance(month);
  const {
    data: geofence,
    isLoading: geoLoading,
    refetch: refetchFence,
  } = useGeofence();
  const checkIn = useCheckIn();
  const checkOut = useCheckOut();

  // Immediate result of a fresh punch (before the refetch lands). For someone
  // who lives on this screen, also the shift it goes on showing (keptShift).
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
  // Missing or inconclusive GPS needs a written reason before the API records
  // it. Which punch the reason box is open for, or null when it is closed.
  const [reasonFor, setReasonFor] = useState<"in" | "out" | null>(null);
  const [reason, setReason] = useState("");
  const [pendingPos, setPendingPos] = useState<PunchPosition | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PunchLocationDecision | null>(null);
  // The camera sheet, and the still it produced. The photo survives a detour
  // through the off-site reason box, so someone who took a photo and then had
  // to explain their location does not have to take it again.
  const [scannerOpen, setScannerOpen] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null);
  // True from the tap on Check out until the position has been read. The one
  // button on the screen has to answer at once: a GPS fix can take ten seconds,
  // and a second tap in that silence would send a second check-out.
  const [locatingOut, setLocatingOut] = useState(false);
  // When this screen was last brought into view. Someone who lives on it leaves
  // it open overnight, so this is how the shift on screen is seen to be an
  // earlier day's (isEarlierDay).
  const [seenAt, setSeenAt] = useState(() => new Date());

  // watchPosition handle, so we can clearWatch on unmount / after a punch.
  const watchIdRef = useRef<number | null>(null);
  // Freshest coords for the auto-punch, without waiting on a state flush.
  const latestPosRef = useRef<PunchPosition | null>(null);
  // Fires the auto check-in exactly once; also set by the manual button so the
  // watcher never double-punches.
  const punchedRef = useRef(false);
  // When a check-out last landed here (see startNewDay).
  const checkedOutAtRef = useRef(0);

  const enabledNavigation = useEnabledNavigation();
  const firstName = user.name.split(" ")[0] || user.name;
  // With the tenant's navigation, so a manager whose industry has no Dashboards
  // is not bounced from the attendance gate onto a screen their product omits.
  const home = homeForRole(role, enabledNavigation, access);
  // Attendance-only staff: this screen is their home, so it sends them nowhere.
  const isHome = home === "/check-in";
  const storeName = geofence?.storeName ?? currentStore.name;
  const radius = geofence?.geofenceRadiusM ?? 0;

  // Someone who lives on this screen keeps the shift it is showing, whatever a
  // later read of today's attendance says (keptShift has the reason).
  const kept = keptShift(lastPunch, data?.today, isHome);
  if (kept !== lastPunch) setLastPunch(kept);

  const today = lastPunch ?? data?.today ?? null;
  const alreadyIn = !lastPunch && !!data?.today?.checkInAt;
  const screen = punchScreen(today, isHome);
  // The shift on screen is an earlier day's, so today's can be started.
  const earlierDay = isHome && !!today && isEarlierDay(today, seenAt);
  const checkingOut = locatingOut || checkOut.isPending;

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
          setReasonFor(null);
          setReason("");
          setPendingDecision(null);
          setPendingPos(null);
          setScannerOpen(false);
          setPendingPhoto(null);
          markAttendanceHandled();
          toast.success("Attendance marked", {
            description: describePunch(row, captured),
          });
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

  // --- Cleanup on unmount: stop the watcher. ---
  useEffect(() => {
    return () => {
      clearWatcher();
    };
  }, []);

  // Everyone whose home is elsewhere moves on once they are in: shortly after
  // the welcome shows for a fresh punch, sooner when they were already in.
  // Someone who lives on this screen is never "move-on" (punchScreen): they
  // stay, and the screen turns to Check out.
  useEffect(() => {
    if (screen !== "move-on") return;
    markAttendanceHandled();
    const t = setTimeout(() => router.replace(home), lastPunch ? 1800 : 1000);
    return () => clearTimeout(t);
  }, [screen, lastPunch, home, router]);

  // Note the time whenever the screen comes back into view, so a shift left on
  // it overnight is seen to be yesterday's. Noting it is all this does: the
  // screen then offers to start today and waits for the tap. Reading today's
  // attendance here instead would set off the automatic check-in the moment a
  // tablet left signed in at the shop woke up, with nobody touching it.
  // ponytail: noted only when the screen comes back into view; add a timer if
  // this ever runs on a wall tablet nobody switches away from.
  useEffect(() => {
    if (!isHome) return;
    const onVisible = () => {
      if (!document.hidden) setSeenAt(new Date());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isHome]);

  /** Mark the day handled + leave to the salesperson's home. */
  function goHome() {
    markAttendanceHandled();
    router.replace(home);
  }

  function prepareCheckIn(pos: PunchPosition | null, photo?: string) {
    const decision = evaluatePunchLocation(pos, geofence);
    /*
     * No branch for "block" any more: the fence decides whether a punch is
     * VERIFIED, not whether it may happen. A phone indoors in a concrete
     * showroom reports 50-150 m of drift, so refusing the punch locked staff
     * out of their own shift rather than catching anybody. Anything the fence
     * cannot confirm asks for a reason and goes to the manager's queue.
     */
    const action = punchAction(decision, "in");
    if (action === "reason") {
      setPendingPos(pos);
      setPendingPhoto(photo ?? null);
      setPendingDecision(decision);
      setScannerOpen(false);
      setReasonFor("in");
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
    if (reasonFor === "out") runCheckOut(pendingPos, note);
    else runCheckIn(pendingPos, note, pendingPhoto);
  }

  /** The check-out call the "My attendance" card makes, from this screen. */
  function runCheckOut(pos: PunchPosition | null, note?: string) {
    // The shift being closed, as the screen shows it now.
    const shown = today;
    checkOut.mutate(
      {
        ...(pos ? { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM } : {}),
        ...(note ? { note } : {}),
      },
      {
        onSuccess: (row) => {
          checkedOutAtRef.current = Date.now();
          setLastPunch(row);
          setReasonFor(null);
          setReason("");
          setPendingDecision(null);
          setPendingPos(null);
          toast.success("Checked out");
        },
        onError: (err) => {
          toast.error(apiErrorMessage(err, "Could not check out. Please try again."));
          // The server may already have this check-out: its reply was lost, or
          // a manager closed the day. Nobody leaves this screen, so read the
          // record again and show the server's copy of it, rather than leave a
          // button that fails on every tap. Only its copy of THIS shift: after
          // midnight "today" is a new day with no record, and the shift on
          // screen still needs its Check out. A refusal is also a moment to
          // look at the clock again (seenAt), for a screen that never left view.
          setSeenAt(new Date());
          void refetch().then((fresh) => {
            const server = fresh.isSuccess ? fresh.data.today : null;
            if (!server || server.id !== shown?.id) return;
            setLastPunch(server);
            // Checked out there already: nothing is left to give a reason for.
            if (server.checkOutAt) setReasonFor(null);
          });
        },
      },
    );
  }

  /**
   * Check-out for someone who stays on this screen, under the same location
   * rules as the "My attendance" card: leaving is never blocked, but a fix that
   * is off-site, vague or missing needs a written reason first.
   */
  async function startCheckOut() {
    if (checkingOut) return;
    setLocatingOut(true);
    const pos = await getPosition();
    // A fence that failed to load is not "no fence". Ask for it once more, and
    // if it still cannot be read take a reason, so that whatever the server
    // says about the distance has already been answered.
    const fence = geofence ?? (await refetchFence()).data;
    setLocatingOut(false);
    const decision = evaluatePunchLocation(pos, fence);
    if (!fence || punchAction(decision, "out") === "reason") {
      setPendingPos(pos);
      setPendingDecision(decision);
      setReasonFor("out");
      return;
    }
    runCheckOut(pos);
  }

  /**
   * Start today on a screen still showing an earlier day's shift: read today's
   * attendance again, then begin from scratch (CheckInPage). The automatic
   * check-in may follow, which is why this waits for a tap.
   */
  async function startNewDay() {
    // The Check out button was in this place a moment ago: a second tap meant
    // for it must not start a new day.
    if (Date.now() - checkedOutAtRef.current < 2000) return;
    const fresh = await refetch();
    // A failed read shows "Couldn't load your attendance" and its Retry.
    if (fresh.isSuccess) onNewDay();
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

  /*
   * "Skip for now" is gone (client, 7 Oct): attendance is recorded every day,
   * and a bypass next to the punch button made skipping cheaper than punching.
   * Nothing dead-ends without it — inside the fence the check-in is automatic,
   * and every face the fence cannot confirm carries "Continue with reason".
   */

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
          {reasonFor ? (
            /* Missing or inconclusive GPS: collect the reason required by the API.
               A check-out from outside the range is recorded the same way. */
            <div className="space-y-4">
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
                <p className="text-sm font-medium">
                  {pendingDecision?.state === "imprecise"
                    ? "GPS accuracy cannot confirm your location"
                    : pendingDecision?.state === "outside"
                      ? `You are ${formatDistance(pendingDecision.distanceM)} from ${storeName}`
                      : pendingDecision?.state === "unfenced"
                        ? `We couldn't check your distance from ${storeName}`
                        : "We couldn't read your location"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add a reason to continue. The{" "}
                  {reasonFor === "out" ? "check-out" : "check-in"} and your note
                  will be recorded for manager review.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="checkin-reason">Reason</Label>
                <Textarea
                  id="checkin-reason"
                  rows={3}
                  maxLength={300}
                  autoFocus
                  placeholder={
                    reasonFor === "out"
                      ? "e.g. Left to deliver an order to a customer"
                      : "e.g. Visiting a client before the shop opens"
                  }
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <Button
                variant="gold"
                size="lg"
                className="h-12 w-full text-base"
                disabled={checkIn.isPending || checkOut.isPending || !reason.trim()}
                onClick={submitWithReason}
              >
                {checkIn.isPending || checkOut.isPending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Marking…
                  </>
                ) : reasonFor === "out" ? (
                  <>
                    <LogOut className="h-5 w-5" />
                    Record check-out
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
                    setReasonFor(null);
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
            </div>
          ) : screen === "check-out" ? (
            /* ── Home screen, checked in: the rest of the day is one button ── */
            <div className="space-y-5">
              <div className="rounded-xl border bg-card p-6 text-center">
                <CheckCircle2 className="mx-auto h-14 w-14 text-success" />
                <p className="num mt-4 text-2xl font-semibold">
                  Checked in at {today!.checkInLocal ?? formatTime(today!.checkInAt)}
                </p>
              </div>
              <Button
                variant="gold"
                size="lg"
                className="h-14 w-full text-base"
                // Until the fence has loaded there is nothing to measure against.
                disabled={geoLoading || checkingOut}
                onClick={startCheckOut}
              >
                {checkingOut ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Checking out…
                  </>
                ) : (
                  <>
                    <LogOut className="h-5 w-5" />
                    Check out
                  </>
                )}
              </Button>
              {/* Still open from an earlier day. Just after midnight Check out
                  is what is wanted, and it closes that shift. If the check-out
                  was simply forgotten, today's can be started without it. */}
              {earlierDay ? (
                <div className="text-center">
                  <button
                    type="button"
                    disabled={isFetching}
                    onClick={startNewDay}
                    className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    Check in for today
                  </button>
                </div>
              ) : null}
            </div>
          ) : screen === "done" ? (
            /* ── Home screen, checked out: nothing left to do today. Once the
               day is over the same shift is the last one, and today's starts
               with a tap. ── */
            <div className="space-y-5">
              <div className="rounded-xl border bg-card p-6 text-center">
                <CheckCircle2 className="mx-auto h-14 w-14 text-success" />
                <p className="mt-4 text-xl font-semibold">
                  {earlierDay ? "Last shift" : "Done for today"}
                </p>
                <p className="num mt-1 text-sm text-muted-foreground">
                  In {today!.checkInLocal ?? formatTime(today!.checkInAt)} · Out{" "}
                  {today!.checkOutLocal ?? formatTime(today!.checkOutAt)}
                </p>
              </div>
              {earlierDay ? (
                <Button
                  variant="gold"
                  size="lg"
                  className="h-14 w-full text-base"
                  disabled={isFetching}
                  onClick={startNewDay}
                >
                  {isFetching ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Loading…
                    </>
                  ) : (
                    <>
                      <LogIn className="h-5 w-5" />
                      Check in for today
                    </>
                  )}
                </Button>
              ) : null}
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
              {/* A phone that is allowed to read the location but never gets a
                  fix stays here for good. Skip is gone (attendance is recorded
                  every day), so EVERYONE needs the way in on this face — with a
                  reason, which is what an unverifiable punch costs. */}
              <Button
                variant="secondary"
                size="lg"
                className="mt-4 h-12 w-full text-base"
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
                    <>
                      Within <span className="num">{radius}</span> m you&apos;re checked in
                      automatically. Working off-site today? Continue with a reason —
                      it&apos;s recorded for your manager to review.
                    </>
                  )}
                </p>
              </div>
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
            </div>
          )}
        </CardContent>
      </Card>

      {/* The one other thing someone who lives on this screen can open. */}
      {isHome ? (
        <p className="mt-4 text-center">
          <Link
            href="/hrms"
            className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Apply for leave or fix attendance
          </Link>
        </p>
      ) : null}

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
