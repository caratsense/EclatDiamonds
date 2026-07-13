import { AppShell } from "@/components/layout/app-shell";
import { SessionGate } from "@/components/auth/session-gate";
import { WelcomeTour } from "@/components/onboarding/welcome-tour";
import { AttendanceGate } from "@/components/attendance/attendance-gate";

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
      </AppShell>
    </SessionGate>
  );
}
