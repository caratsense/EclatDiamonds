import { AppShell } from "@/components/layout/app-shell";
import { SessionGate } from "@/components/auth/session-gate";
import { WelcomeTour } from "@/components/onboarding/welcome-tour";

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
      </AppShell>
    </SessionGate>
  );
}
