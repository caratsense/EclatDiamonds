import { AppShell } from "@/components/layout/app-shell";
import { SessionGate } from "@/components/auth/session-gate";
import { WelcomeTour } from "@/components/onboarding/welcome-tour";
import { AttendanceGate } from "@/components/attendance/attendance-gate";
import { AutoSignOut } from "@/components/attendance/auto-signout";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { ASSISTANT_ENABLED } from "@/lib/features";

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
        {/* Floating assistant: answers "what's waiting on me", "which branches
            raised diamond-rate requests", etc. Deterministic server-side — every
            answer is a store-scoped, role-filtered query, never a model call.
            Hidden for now; flip NEXT_PUBLIC_ENABLE_ASSISTANT to bring it back. */}
        {ASSISTANT_ENABLED ? <AssistantPanel /> : null}
      </AppShell>
    </SessionGate>
  );
}
