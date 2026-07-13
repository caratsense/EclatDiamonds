"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  isAttendanceHandled,
  markAttendanceHandled,
} from "@/lib/attendance-gate";
import { useMyAttendance } from "@/lib/queries/hrms";
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
 */
export function AttendanceGate() {
  const router = useRouter();
  const pathname = usePathname();
  const role = useSession((s) => s.role);
  const authenticated = useSession((s) => s.authenticated);

  const isSalesperson = role === "salesperson";
  const onCheckIn = pathname === "/check-in";
  // Read once per mount; the flag only ever flips to "handled" within a session.
  const alreadyHandled = useMemo(() => isAttendanceHandled(), []);

  // Only fetch when the gate could actually act — avoids extra load for managers.
  const active =
    authenticated && isSalesperson && !onCheckIn && !alreadyHandled;
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data, isSuccess } = useMyAttendance(month);

  useEffect(() => {
    if (!active || !isSuccess) return;
    if (data?.today) {
      // Already checked in today — mark handled so we stop checking.
      markAttendanceHandled();
      return;
    }
    // Not checked in yet — send them to the attendance-first screen.
    router.replace("/check-in");
  }, [active, isSuccess, data, router]);

  return null;
}
