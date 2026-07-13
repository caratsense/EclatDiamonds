"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Staff / team administration (head-office only).
 *
 * These hooks back the Team page where HO manages every user across all
 * stores and assigns roles. Everyone defaults to "salesperson"; HO promotes
 * to store_manager / area_manager. Users are global (not store-scoped) from
 * HO's vantage point, so the list keys on ["users"] rather than the active
 * store — all mutations invalidate ["users"] so the table stays fresh.
 *
 * Contract (backend, head_office only):
 *  GET   /users            → StaffUser[]
 *  POST  /users            → StaffUser
 *  PATCH /users/:id/role   → StaffUser
 *  PATCH /users/:id/store  → StaffUser
 */

/** Roles HO can assign from the Team page (a subset of the full Role union;
 *  head_office itself is provisioned separately, not granted here). */
export type StaffRole = "salesperson" | "store_manager" | "area_manager";

export interface StaffUserStore {
  id: string;
  name: string;
}

export interface StaffUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: StaffRole;
  stores: StaffUserStore[];
  isActive: boolean;
}

export interface CreateUserInput {
  name: string;
  storeId: string;
  phone?: string;
  email?: string;
  role?: StaffRole;
}

/** GET /users — every staff member across all stores (HO view). */
export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const { data } = await api.get<StaffUser[]>("/users");
      return data;
    },
  });
}

/** POST /users — add a staff member (defaults to salesperson). */
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateUserInput) => {
      const { data } = await api.post<StaffUser>("/users", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

/** PATCH /users/:id/role — promote or demote a staff member. */
export function useUpdateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, role }: { id: string; role: StaffRole }) => {
      const { data } = await api.patch<StaffUser>(`/users/${id}/role`, { role });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

/** PATCH /users/:id/store — reassign a staff member's primary store. */
export function useUpdateUserStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, storeId }: { id: string; storeId: string }) => {
      const { data } = await api.patch<StaffUser>(`/users/${id}/store`, {
        storeId,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
