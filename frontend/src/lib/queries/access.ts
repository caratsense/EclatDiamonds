"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { AccessLevel, AccessMap, Role } from "@/lib/types";

export type AccessOverride = AccessLevel | "none";

export interface UserAccess {
  userId: string;
  name: string;
  role: Role;
  /** What the role gives by default. */
  defaults: AccessMap;
  /** Head office's changes for this person only. */
  overrides: Record<string, AccessOverride>;
  /** The result: what they can open now. */
  effective: AccessMap;
}

/** GET /users/:id/access — head office only. */
export function useUserAccess(userId: string | null) {
  return useQuery({
    queryKey: ["user-access", userId],
    enabled: !!userId,
    queryFn: async () => (await api.get<UserAccess>(`/users/${userId}/access`)).data,
  });
}

/** PUT /users/:id/access — replace this person's changes (entries equal to the role default are dropped). */
export function useSetUserAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; overrides: Record<string, AccessOverride> }) =>
      (await api.put<UserAccess>(`/users/${input.userId}/access`, { overrides: input.overrides })).data,
    onSuccess: (data) => qc.setQueryData(["user-access", data.userId], data),
  });
}
