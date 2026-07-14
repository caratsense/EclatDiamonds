"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { setStoredStoreId, setStoredToken } from "@/lib/api";
import { useSession } from "@/store/use-session";

/**
 * PendingAssignmentGate — a friendly full-screen stop for an authenticated user
 * who has been created but not yet linked to a store. Without a store there is
 * no scope to render (every screen is store-scoped), so instead of showing an
 * empty, broken app we explain that a manager will finish the setup, and offer
 * a sign-out.
 *
 * Pass-through rules (render children untouched):
 *  - head_office (operates across all stores, no single store needed), or
 *  - the user holds at least one store — real branch or the "All Stores"
 *    aggregate (area/HO views).
 *
 * SSR/hydration: the session store seeds with mock values on the server, so we
 * only make the gating decision after mount. Until then we render children,
 * which keeps the server and first client render identical.
 */
export function PendingAssignmentGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const hasStore = stores.length > 0; // real branch or "All Stores" aggregate
  const blocked = mounted && role !== "head_office" && !hasStore;

  if (!blocked) return <>{children}</>;

  return <PendingCard />;
}

function PendingCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const clear = useSession((s) => s.clear);

  function signOut() {
    setStoredToken(null);
    setStoredStoreId(null);
    clear();
    queryClient.clear();
    router.replace("/login");
  }

  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Building2 className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold">Almost there</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account is set up but not yet assigned to a store. Your manager
          will complete this shortly — please check back soon.
        </p>
        <Button variant="outline" className="mt-6" onClick={signOut}>
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </div>
    </div>
  );
}
