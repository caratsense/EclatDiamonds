"use client";

import { create } from "zustand";

import type { AccessMap, Role, Session, Store, User } from "@/lib/types";
import { setStoredStoreId } from "@/lib/api";
import { MOCK_STORES, MOCK_USER } from "@/lib/mock";

interface SessionState extends Session {
  /** True once /auth/me has hydrated this store from the API. */
  authenticated: boolean;
  /**
   * The role the person actually holds. `role` is the role the CURRENT PAGE is
   * served at: ModuleGate sets it from their access level for that screen (a
   * salesperson head office gave Inventory to works it as a store manager).
   * Anything that describes the person — the header, the account page — reads
   * `baseRole`.
   */
  baseRole: Role;
  /** Hydrate the session from the auth/me response. */
  hydrate: (payload: {
    user: User;
    role: Role;
    stores: Store[];
    currentStore: Store;
    access?: AccessMap;
  }) => void;
  /** Reset to logged-out defaults (used on sign out / 401). */
  clear: () => void;
  /** Switch the active store for multi-store roles. */
  setCurrentStore: (store: Store) => void;
  setCurrentStoreById: (id: string) => void;
  /** Switch role to demo role-based views (read-only once auth-driven). */
  setRole: (role: Role) => void;
}

/**
 * useSession — single source of truth for who is acting, in what role,
 * and against which store. Seeded with mock values for first paint, then
 * hydrated from /auth/me once the user logs in. `setCurrentStoreById`
 * also persists the active store so the api interceptor sends X-Store-Id.
 */
export const useSession = create<SessionState>((set, get) => ({
  user: MOCK_USER,
  role: "store_manager",
  baseRole: "store_manager",
  access: undefined,
  currentStore: MOCK_STORES[0],
  stores: MOCK_STORES,
  authenticated: false,

  hydrate: ({ user, role, stores, currentStore, access }) => {
    setStoredStoreId(currentStore.id);
    set({ user, role, baseRole: role, access, stores, currentStore, authenticated: true });
  },

  clear: () =>
    set({
      user: MOCK_USER,
      role: "store_manager",
      baseRole: "store_manager",
      access: undefined,
      currentStore: MOCK_STORES[0],
      stores: MOCK_STORES,
      authenticated: false,
    }),

  setCurrentStore: (store) => {
    setStoredStoreId(store.id);
    set({ currentStore: store });
  },
  setCurrentStoreById: (id) => {
    const store = get().stores.find((s) => s.id === id);
    if (store) {
      setStoredStoreId(store.id);
      set({ currentStore: store });
    }
  },
  setRole: (role) => set({ role }),
}));
