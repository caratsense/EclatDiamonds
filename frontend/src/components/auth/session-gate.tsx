"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { getStoredToken } from "@/lib/api";
import { fetchMe } from "@/lib/queries/auth";
import { useSession } from "@/store/use-session";

/**
 * SessionGate guards the (app) route group. On mount it checks for a stored
 * JWT and hydrates useSession from /auth/me. Unauthenticated users (no token,
 * or a rejected token) are redirected to /login. Children only render once a
 * real session is in place, so every screen is role/store-correct.
 */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const hydrate = useSession((s) => s.hydrate);
  const authenticated = useSession((s) => s.authenticated);
  const [checking, setChecking] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    const token = getStoredToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    fetchMe()
      .then((me) => {
        if (cancelled) return;
        hydrate(me);
        setChecking(false);
      })
      .catch(() => {
        if (cancelled) return;
        router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [hydrate, router]);

  if (checking || !authenticated) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
