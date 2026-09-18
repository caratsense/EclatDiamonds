"use client";

import { useEffect, useRef, useState } from "react";
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
import { useSignOut } from "@/components/layout/logout-dialog";
import { useSession } from "@/store/use-session";
import { useResetOn } from "@/lib/use-reset-on";

/**
 * Inactivity threshold before we warn about signing the salesperson out of the
 * app. 30 minutes — change this single constant to tune the idle window.
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
 * AutoSignOut — invisible client component that ends a salesperson's APP
 * session after a long stretch of inactivity, so an unattended terminal does
 * not stay signed in. Mounted once in the app layout alongside AttendanceGate.
 *
 *  - Acts ONLY for role === "salesperson". Managers / area / HO render null and
 *    attach no timers or listeners.
 *  - A single idle timer (IDLE_MS) is reset — throttled to once per
 *    RESET_THROTTLE_MS — on any user interaction. When it lapses we open a
 *    dialog with a 60-second countdown the salesperson can cancel.
 *  - "Stay signed in" (or dismissing) resets the timer. "Sign out now" or the
 *    countdown reaching 0 signs out of the app (token cleared, back to /login).
 *  - Attendance is NEVER changed here: no check-out, no punch. Being idle is not
 *    leaving the shop; the person stays checked in and checks out themselves.
 */
export function AutoSignOut() {
  const role = useSession((s) => s.role);
  const signOut = useSignOut();

  // Front-line staff only: salespeople and storepeople.
  const isSalesperson = role === "salesperson" || role === "storeperson";

  const [warnOpen, setWarnOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(WARN_SECONDS);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResetRef = useRef(0);
  // Signs out exactly once, guarding the "0s" + "Sign out now" paths.
  const signedOutRef = useRef(false);
  // Freshest values for callbacks fired from timers (avoids stale closures).
  //
  // Written after commit rather than during render. A render that React throws
  // away — a Strict-Mode double pass, an interrupted concurrent render — would
  // otherwise have already published its values into the refs, and the timer
  // that fires next would act on a render the user never saw. No dependency
  // array on purpose: every committed render republishes.
  const signOutRef = useRef(signOut);
  const warnOpenRef = useRef(false);
  useEffect(() => {
    signOutRef.current = signOut;
    warnOpenRef.current = warnOpen;
  });

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

  /** End the app session. Attendance is left exactly as it is. */
  function doSignOut() {
    if (signedOutRef.current) return;
    signedOutRef.current = true;
    clearCountdown();
    clearIdleTimer();
    warnOpenRef.current = false;
    setWarnOpen(false);
    toast.info("Signed out after inactivity", {
      description: "Your attendance was not changed.",
    });
    signOutRef.current();
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

  // The countdown restarts from the top each time the dialog opens. Set during
  // render, so the dialog never flashes the previous countdown's last value.
  useResetOn(warnOpen, () => {
    if (warnOpen) setSecondsLeft(WARN_SECONDS);
  });

  // --- Warning countdown: runs while the dialog is open; 0 → sign out. ---
  useEffect(() => {
    if (!warnOpen) return;
    // Wall-clock deadline (a throttled background tab still signs out on time),
    // and the sign-out runs outside any state updater.
    const deadline = Date.now() + WARN_SECONDS * 1000;
    countdownRef.current = setInterval(() => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left <= 0) doSignOut();
      else setSecondsLeft(left);
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
          <DialogTitle>You&apos;ll be signed out</DialogTitle>
          <DialogDescription>
            You&apos;ve been inactive for a while, so we&apos;ll sign you out of
            the app shortly. Your attendance stays as it is: you are not
            checked out.
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
            onClick={doSignOut}
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
