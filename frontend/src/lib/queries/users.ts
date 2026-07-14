"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Staff / team administration (delegated, store-scoped).
 *
 * These hooks back the role-aware Team page. Unlike the old head-office-only
 * model, management is now delegated down the hierarchy: a store manager sees
 * and adds staff within their store, an area manager across their stores, and
 * head office everywhere. The backend enforces store scope and the role-rank
 * rules on every call; the client mirrors them only to avoid offering illegal
 * choices.
 *
 * Query keys:
 *  - ["users", storeId | "all"]  → the store-scoped roster
 *  - ["users", "unassigned"]     → users with no store link yet
 * Every mutation invalidates both so roster + pending list stay fresh.
 *
 * Contract (backend, store_manager and above unless noted):
 *  GET   /users?storeId?        → StaffUser[]  (store-scoped server-side)
 *  GET   /users/unassigned      → StaffUser[]  (no store link)
 *  POST  /users                 → StaffUser    (role defaults salesperson)
 *  PATCH /users/:id/role        → StaffUser    (area_manager+)
 *  PATCH /users/:id/store       → StaffUser    (area_manager+)
 *  PATCH /users/:id/deactivate  → StaffUser    (reassigns leads/walk-ins)
 *  PATCH /users/:id/activate    → StaffUser
 */

/** Roles that can be assigned from the Team page (a subset of the full Role
 *  union; head_office itself is provisioned separately, not granted here). */
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

export interface CreateStaffInput {
  name: string;
  storeId: string;
  phone?: string;
  email?: string;
  role?: StaffRole;
}

const USERS_KEY = ["users"] as const;
const UNASSIGNED_KEY = ["users", "unassigned"] as const;

/** Invalidate both the roster and the pending-assignment list. */
function invalidateUsers(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: USERS_KEY });
  qc.invalidateQueries({ queryKey: UNASSIGNED_KEY });
}

/** GET /users — the staff roster, store-scoped server-side. Pass a storeId to
 *  narrow to a single branch; omit it for the caller's full scope. */
export function useStaff(storeId?: string) {
  return useQuery({
    queryKey: ["users", storeId ?? "all"],
    queryFn: async () => {
      const { data } = await api.get<StaffUser[]>("/users", {
        params: storeId ? { storeId } : undefined,
      });
      return data;
    },
  });
}

/** GET /users/unassigned — users created without a store link yet. */
export function useUnassignedStaff() {
  return useQuery({
    queryKey: UNASSIGNED_KEY,
    queryFn: async () => {
      const { data } = await api.get<StaffUser[]>("/users/unassigned");
      return data;
    },
  });
}

/** POST /users — add a staff member (defaults to salesperson). */
export function useCreateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStaffInput) => {
      const { data } = await api.post<StaffUser>("/users", input);
      return data;
    },
    onSuccess: () => invalidateUsers(qc),
  });
}

/** PATCH /users/:id/role — promote or demote a staff member (area_manager+). */
export function useUpdateStaffRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, role }: { id: string; role: StaffRole }) => {
      const { data } = await api.patch<StaffUser>(`/users/${id}/role`, { role });
      return data;
    },
    onSuccess: () => invalidateUsers(qc),
  });
}

/** PATCH /users/:id/store — assign / reassign a staff member's store
 *  (area_manager+). Also used to place a pending (unassigned) user. */
export function useUpdateStaffStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, storeId }: { id: string; storeId: string }) => {
      const { data } = await api.patch<StaffUser>(`/users/${id}/store`, {
        storeId,
      });
      return data;
    },
    onSuccess: () => invalidateUsers(qc),
  });
}

/** PATCH /users/:id/deactivate — offboard a staff member. When reassignToId is
 *  given, the leaver's open leads / walk-ins are handed off to that person. */
export function useDeactivateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      reassignToId,
    }: {
      id: string;
      reassignToId?: string;
    }) => {
      const { data } = await api.patch<StaffUser>(`/users/${id}/deactivate`, {
        reassignToId,
      });
      return data;
    },
    onSuccess: () => invalidateUsers(qc),
  });
}

/** PATCH /users/:id/activate — reactivate a previously deactivated member. */
export function useActivateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data } = await api.patch<StaffUser>(`/users/${id}/activate`, {});
      return data;
    },
    onSuccess: () => invalidateUsers(qc),
  });
}
