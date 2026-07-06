import { AppShell } from "@/components/layout/app-shell";
import { SessionGate } from "@/components/auth/session-gate";

export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionGate>
      <AppShell>{children}</AppShell>
    </SessionGate>
  );
}
