"use client";

import { useSession } from "@/store/use-session";

/**
 * All list queries are scoped to the active store. Keying every query on the
 * current store id means switching the store in the topbar automatically
 * refetches (React Query treats it as a new key) without manual invalidation.
 */
export function useStoreKey(): string {
  return useSession((s) => s.currentStore.id);
}
