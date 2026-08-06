"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

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
 * persists it, then hydrates the session via /auth/me (mirrors useLogin).
 * `nonce` is the value handed to GIS, echoed back for the backend to verify.
 */
export function useGoogleLogin() {
  return useMutation({
    mutationFn: async (input: { credential: string; nonce?: string }) => {
      const { data } = await api.post<{ token: string }>("/auth/google", {
        credential: input.credential,
        ...(input.nonce ? { nonce: input.nonce } : {}),
      });
      setStoredToken(data.token);
      const me = await fetchMe();
      setStoredStoreId(me.currentStore.id);
      return me;
    },
  });
}

export interface SignupInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
  requestedRole: "salesperson" | "store_manager" | "area_manager";
  requestedStoreId: string;
}

export interface SignupStore {
  id: string;
  name: string;
  city: string;
}

/**
 * useSignupStores — the PUBLIC store directory (no auth) that populates the
 * store picker on the signup form. Names/cities only.
 */
export function useSignupStores() {
  return useQuery({
    queryKey: ["signup-stores"],
    queryFn: async () => {
      const { data } = await api.get<SignupStore[]>("/stores/directory");
      return data;
    },
  });
}

/**
 * useSignup — self-registration. Creates a PENDING request, never a live
 * session: the response is `{ pending: true, message }` and the applicant
 * cannot sign in until an authorised approver grants the account. No token is
 * stored here on purpose.
 */
export function useSignup() {
  return useMutation({
    mutationFn: async (input: SignupInput) => {
      const { data } = await api.post<{
        pending: boolean;
        message: string;
        loginEmail: string;
      }>("/auth/signup", input);
      return data;
    },
  });
}

/**
 * useRequestOtp — asks the backend to send a 6-digit sign-in code on
 * WhatsApp. The response is identical for known and unknown phones (no
 * account enumeration); `dryRun` is true when WhatsApp delivery is not
 * configured (test mode — the code is logged server-side).
 */
export function useRequestOtp() {
  return useMutation({
    mutationFn: async (phone: string) => {
      const { data } = await api.post<{ sent: boolean; dryRun: boolean }>(
        "/auth/otp/request",
        { phone },
      );
      return data;
    },
  });
}

/**
 * useVerifyOtp — exchanges phone + 6-digit code for a session. The backend
 * responds with the exact /auth/login shape (token + full session payload),
 * so no follow-up /auth/me round trip is needed. Token and active store are
 * persisted before resolving (mirrors useLogin).
 */
export function useVerifyOtp() {
  return useMutation({
    mutationFn: async (input: { phone: string; code: string }) => {
      const { data } = await api.post<{ token: string } & AuthMeResponse>(
        "/auth/otp/verify",
        input,
      );
      setStoredToken(data.token);
      setStoredStoreId(data.currentStore.id);
      const me: AuthMeResponse = {
        user: data.user,
        role: data.role,
        stores: data.stores,
        currentStore: data.currentStore,
      };
      return me;
    },
  });
}

/**
 * useResetPassword — sets a new password for another user (store_manager and
 * above; the backend enforces store scope and role rank, returning 403 when
 * the target is out of reach).
 */
export function useResetPassword() {
  return useMutation({
    mutationFn: async (input: { userId: string; newPassword: string }) => {
      const { data } = await api.post<{ ok: boolean }>(
        "/auth/reset-password",
        input,
      );
      return data;
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
