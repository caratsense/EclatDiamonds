import { AppShell } from "@/components/layout/app-shell";
import { SessionGate } from "@/components/auth/session-gate";
import { WelcomeTour } from "@/components/onboarding/welcome-tour";
import { AttendanceGate } from "@/components/attendance/attendance-gate";
import { AutoSignOut } from "@/components/attendance/auto-signout";

export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionGate>
      <AppShell>
        {children}
        {/* First-run, role-aware orientation. Renders via a portal; only
            mounts once the session is authenticated (inside SessionGate). */}
        <WelcomeTour />
        {/* Attendance-first soft gate: sends a salesperson who reopens the app
            to /check-in until they've handled today's attendance. Invisible;
            never acts for managers/area/HO. */}
        <AttendanceGate />
        {/* Idle auto sign-out for the day (attendance only). Salesperson-only;
            managers/area/HO attach no timers. Ends the attendance session and
            returns to /check-in — the auth token is left intact. */}
        <AutoSignOut />
      </AppShell>
    </SessionGate>
  );
}
