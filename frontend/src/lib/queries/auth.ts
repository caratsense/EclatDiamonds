"use client";

import { useMutation } from "@tanstack/react-query";

import { api, setStoredToken, setStoredStoreId } from "@/lib/api";
import type { Role, Store, User } from "@/lib/types";

export interface AuthMeResponse {
  user: User;
  role: Role;
  stores: Store[];
  currentStore: Store;
}

/** POST /auth/login → { token } */
export async function login(email: string, password: string): Promise<string> {
  const { data } = await api.post<{ token: string }>("/auth/login", {
    email,
    password,
  });
  return data.token;
}

/** GET /auth/me → session payload (hydrates useSession). */
export async function fetchMe(): Promise<AuthMeResponse> {
  const { data } = await api.get<AuthMeResponse>("/auth/me");
  return data;
}

/**
 * useLogin — exchanges credentials for a JWT, persists it, then resolves
 * the full session via /auth/me. The active store is seeded from the
 * response so the very next request is correctly scoped.
 */
export function useLogin() {
  return useMutation({
    mutationFn: async (creds: { email: string; password: string }) => {
      const token = await login(creds.email, creds.password);
      setStoredToken(token);
      const me = await fetchMe();
      setStoredStoreId(me.currentStore.id);
      return me;
    },
  });
}

/**
 * useGoogleLogin — exchanges a Google ID-token credential for an Eclat JWT,
 * persists it, then hydrates the session via /auth/me (mirrors useLogin). The
 * backend matches an existing user by Google email.
 */
export function useGoogleLogin() {
  return useMutation({
    mutationFn: async (credential: string) => {
      const { data } = await api.post<{ token: string }>("/auth/google", {
        credential,
      });
      setStoredToken(data.token);
      const me = await fetchMe();
      setStoredStoreId(me.currentStore.id);
      return me;
    },
  });
}

/**
 * useChangePassword — updates the signed-in user's password (the in-app
 * password; Google sign-in is a separate path). The backend verifies
 * `currentPassword` before accepting `newPassword`.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: async (input: {
      currentPassword: string;
      newPassword: string;
    }) => {
      const { data } = await api.post("/auth/change-password", input);
      return data;
    },
  });
}
