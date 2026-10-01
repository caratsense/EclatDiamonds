"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  attendanceGateStep,
  isAttendanceHandled,
  markAttendanceHandled,
} from "@/lib/attendance-gate";
import { homeForRole } from "@/lib/navigation";
import { useMyAttendance } from "@/lib/queries/hrms";
import { useEnabledNavigation } from "@/lib/queries/tenant-config";
import { useSession } from "@/store/use-session";

/**
 * AttendanceGate — routes a salesperson who reopens the app (token still valid,
 * no fresh login) to /check-in until they've handled today's attendance. Invisible
 * (renders null). Soft gate only:
 *
 *  - Acts only for role === "salesperson", off the /check-in page, and only when
 *    this session hasn't already handled attendance (sessionStorage flag).
 *  - Waits for useMyAttendance to load before deciding, so we never bounce during
 *    a loading state. today != null → set the flag (already done, no redirect);
 *    today == null → replace to /check-in.
 *  - Managers / area / HO are never redirected. "Skip for now" and a successful
 *    check-in both set the flag, so it won't bounce them back.
 *  - Someone whose home is /check-in (attendance only) has no "Skip for now":
 *    being on that screen sets the flag, so their link to leave and
 *    regularisation is not bounced straight back to it.
 *
 * The decision itself is attendanceGateStep (lib/attendance-gate), tested there.
 */
export function AttendanceGate() {
  const router = useRouter();
  const pathname = usePathname();
  const role = useSession((s) => s.role);
  const access = useSession((s) => s.access);
  const authenticated = useSession((s) => s.authenticated);
  const enabledNavigation = useEnabledNavigation();

  // Front-line staff punch in: salespeople and storepeople alike.
  // Everyone who punches: sales staff, and store managers and marketing too, who
  // otherwise had to find the punch under More → HRMS.
  const punches = authenticated && role !== "head_office";
  const onPunchScreen = pathname === "/check-in";
  // Asked the way the punch screen asks it, so the two cannot disagree.
  const punchScreenIsHome =
    homeForRole(role, enabledNavigation, access) === "/check-in";

  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data, isSuccess } = useMyAttendance(month);
  const today = isSuccess ? (data?.today ?? null) : undefined;

  useEffect(() => {
    const step = attendanceGateStep({
      punches,
      onPunchScreen,
      punchScreenIsHome,
      // Re-read the flag on EVERY run. It used to be memoized at mount, which made
      // "Skip for now" useless: skip set the flag and navigated away, but this
      // component never unmounts, so it still held the stale `false`, saw no punch
      // for today, and replaced the user straight back to /check-in. The salesperson
      // — the only role this gate applies to — could not get past the screen.
      handled: isAttendanceHandled(),
      today,
    });
    if (step === "mark-handled") markAttendanceHandled();
    else if (step === "to-punch-screen") router.replace("/check-in");
  }, [punches, onPunchScreen, punchScreenIsHome, today, router, pathname]);

  return null;
}
