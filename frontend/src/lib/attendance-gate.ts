"use client";

/**
 * Shared state for the salesperson "attendance-first" gate. A single
 * sessionStorage flag records whether the current session has already handled
 * today's attendance (checked in, or explicitly skipped). It is per-session by
 * design: a fresh login / reopen re-prompts, but we never nag within a session.
 */

const FLAG_KEY = "eclat.attendanceHandled";

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
