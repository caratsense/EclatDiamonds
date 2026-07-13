"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { clearAttendanceHandled } from "@/lib/attendance-gate";
import { useCheckOut } from "@/lib/queries/hrms";
import { useSession } from "@/store/use-session";

/**
 * Inactivity threshold before we warn about signing the salesperson out for the
 * day. 30 minutes — change this single constant to tune the idle window.
 */
const IDLE_MS = 30 * 60 * 1000;

/** Seconds the "you'll be signed out" dialog counts down before it acts. */
const WARN_SECONDS = 60;

/** Reset the idle timer at most this often, so hot events (scroll/mousemove) stay cheap. */
const RESET_THROTTLE_MS = 5000;

/** Interactions that count as the salesperson still being active. */
const ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "click",
  "scroll",
  "touchstart",
] as const;

/**
 * Best-effort one-shot position with a tight (~5s) budget, mirroring the lenient
 * check-in flow: a null just means the check-out records without geo verification.
 */
function getPositionQuick(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 },
    );
  });
}

/** HH:mm for the current instant. */
function nowTime(): string {
  return new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * AutoSignOut — invisible client component that ends a salesperson's ATTENDANCE
 * session for the day after a long stretch of inactivity. Mounted once in the
 * app layout alongside AttendanceGate.
 *
 *  - Acts ONLY for role === "salesperson". Managers / area / HO render null and
 *    attach no timers or listeners.
 *  - A single idle timer (IDLE_MS) is reset — throttled to once per
 *    RESET_THROTTLE_MS — on any user interaction. When it lapses we open a
 *    dialog with a 60-second countdown the salesperson can cancel.
 *  - "Stay signed in" (or dismissing) resets the timer. "Sign out now" or the
 *    countdown reaching 0 punches the attendance check-out (best-effort geo,
 *    ~5s budget, lenient 0/0 on failure), clears the attendance-handled flag,
 *    notifies, and returns to /check-in.
 *  - The AUTH TOKEN is never touched — this is an attendance sign-out, not an
 *    account logout. Re-entry just re-marks attendance via the geofence gate.
 */
export function AutoSignOut() {
  const router = useRouter();
  const role = useSession((s) => s.role);
  const checkOut = useCheckOut();

  const isSalesperson = role === "salesperson";

  const [warnOpen, setWarnOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(WARN_SECONDS);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResetRef = useRef(0);
  // Fires the check-out exactly once, guarding the "0s" + "Sign out now" paths.
  const signedOutRef = useRef(false);
  // Freshest values for callbacks fired from timers (avoids stale closures).
  const checkOutRef = useRef(checkOut);
  const warnOpenRef = useRef(false);
  checkOutRef.current = checkOut;
  warnOpenRef.current = warnOpen;

  function clearIdleTimer() {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  function clearCountdown() {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }

  /** (Re)arm the idle timer; when it lapses, open the warning countdown. */
  function scheduleIdle() {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      warnOpenRef.current = true;
      setWarnOpen(true);
    }, IDLE_MS);
  }

  /** Throttled activity handler — resets the idle timer unless the warning is up. */
  function handleActivity() {
    if (warnOpenRef.current) return; // the countdown owns the screen; don't reset
    const now = Date.now();
    if (now - lastResetRef.current < RESET_THROTTLE_MS) return;
    lastResetRef.current = now;
    scheduleIdle();
  }

  /** Punch the attendance check-out and return to the geofence gate. */
  async function doSignOut() {
    if (signedOutRef.current) return;
    signedOutRef.current = true;
    clearCountdown();
    clearIdleTimer();

    const pos = await getPositionQuick();
    checkOutRef.current.mutate(
      { lat: pos?.lat ?? 0, lng: pos?.lng ?? 0 },
      {
        // Whether or not the punch API succeeds, end the local attendance
        // session and go back to /check-in. The AUTH TOKEN is left intact.
        onSettled: () => {
          clearAttendanceHandled();
          toast.info(`You've been signed out for the day at ${nowTime()}`);
          warnOpenRef.current = false;
          setWarnOpen(false);
          router.replace("/check-in");
        },
      },
    );
  }

  /** Dismiss the warning and re-arm the idle timer. */
  function staySignedIn() {
    clearCountdown();
    warnOpenRef.current = false;
    setWarnOpen(false);
    setSecondsLeft(WARN_SECONDS);
    scheduleIdle();
  }

  // --- Idle timer + activity listeners (salesperson only). ---
  useEffect(() => {
    if (!isSalesperson) return;
    scheduleIdle();
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, handleActivity, { passive: true });
    }
    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, handleActivity);
      }
      clearIdleTimer();
      clearCountdown();
    };
    // Handlers are stable enough for this setup effect (refs guard the closures).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSalesperson]);

  // --- Warning countdown: runs while the dialog is open; 0 → sign out. ---
  useEffect(() => {
    if (!warnOpen) return;
    setSecondsLeft(WARN_SECONDS);
    countdownRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearCountdown();
          void doSignOut();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearCountdown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warnOpen]);

  if (!isSalesperson) return null;

  return (
    <Dialog
      open={warnOpen}
      onOpenChange={(open) => {
        // Escape / outside-click / X all count as "stay signed in".
        if (!open) staySignedIn();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>You&apos;ll be signed out for the day</DialogTitle>
          <DialogDescription>
            You&apos;ve been inactive for a while. For security, we&apos;ll sign
            you out of today&apos;s attendance shortly.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center py-2">
          <span className="num text-5xl font-semibold">{secondsLeft}</span>
          <span className="mt-1 text-sm text-muted-foreground">
            second{secondsLeft === 1 ? "" : "s"} remaining
          </span>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            size="lg"
            className="h-12 w-full text-base sm:w-auto"
            onClick={() => void doSignOut()}
          >
            <LogOut className="h-5 w-5" />
            Sign out now
          </Button>
          <Button
            variant="gold"
            size="lg"
            className="h-12 w-full text-base sm:w-auto"
            onClick={staySignedIn}
          >
            Stay signed in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
