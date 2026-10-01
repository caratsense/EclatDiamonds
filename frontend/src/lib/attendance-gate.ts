"use client";

/**
 * Shared state for the salesperson "attendance-first" gate. A single
 * sessionStorage flag records whether the current session has already handled
 * today's attendance (checked in, explicitly skipped, or opened the punch
 * screen when it is the person's home). It is per-session by
 * design: a fresh login / reopen re-prompts, but we never nag within a session.
 */

const FLAG_KEY = "eclat.attendanceHandled";

export type GateStep = "nothing" | "mark-handled" | "to-punch-screen";

/**
 * The gate's whole decision, for the screen the person is on now.
 *
 * Off the punch screen it waits for today's attendance, then sends anyone who
 * has neither punched nor skipped to the punch screen.
 *
 * On the punch screen it does nothing for most people: punching or "Skip for
 * now" sets the flag. Someone whose home is that screen (attendance only) is
 * not offered Skip, so being on it is what counts. Without that their one
 * other screen, leave and fixing attendance, would send them straight back
 * until they had punched.
 */
export function attendanceGateStep(at: {
  /** Signed in, and not head office (who never punch). */
  punches: boolean;
  onPunchScreen: boolean;
  /** The punch screen is this person's home (homeForRole). */
  punchScreenIsHome: boolean;
  /** This session has already dealt with attendance (the flag below). */
  handled: boolean;
  /** Today's record once it has loaded, or undefined until then. */
  today: object | null | undefined;
}): GateStep {
  if (!at.punches || at.handled) return "nothing";
  if (at.onPunchScreen) return at.punchScreenIsHome ? "mark-handled" : "nothing";
  // Still loading: never send anyone anywhere on a guess.
  if (at.today === undefined) return "nothing";
  return at.today ? "mark-handled" : "to-punch-screen";
}

/** Mark today's attendance as handled for this session (check-in or skip). */
export function markAttendanceHandled(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(FLAG_KEY, "1");
  } catch {
    // Private-mode / storage-disabled: soft gate, safe to ignore.
  }
}

/** True once the salesperson has checked in or skipped this session. */
export function isAttendanceHandled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Clear the flag so the next session re-prompts (called on fresh login). */
export function clearAttendanceHandled(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(FLAG_KEY);
  } catch {
    // ignore
  }
}
