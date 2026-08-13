"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Store administration + lifecycle (area-manager and above).
 *
 * These hooks back the Store Setup page where area managers / HO provision
 * stores, review pending branches, and move each store through its lifecycle
 * (pending → active → closed). Every store the API returns is already a
 * first-class, multi-store-scoped entity — creating one here gives it its own
 * scoped "individual system" via the existing store-switcher + X-Store-Id
 * header. All mutations invalidate ["stores"] (and ["stores","pending"]) so
 * the table stays fresh.
 *
 * Contract (backend):
 *  GET   /stores               → AdminStore[]
 *  GET   /stores/pending       → PendingStore[]   (area_manager+, scoped)
 *  POST  /stores               → AdminStore        (area_manager+)
 *  PATCH /stores/:id           → AdminStore        (head_office)
 *  PATCH /stores/:id/activate  → AdminStore        (area_manager+)
 *  PATCH /stores/:id/close     → AdminStore        (head_office)
 *  POST  /stores/:id/manager   → StoreManagerCreated (head_office)
 */

/** Lifecycle state returned on every store. */
export type StoreStatus = "pending" | "active" | "closed";

export interface StoreManager {
  id: string;
  name: string;
  email: string;
}

export interface AdminStore {
  id: string;
  name: string;
  city: string;
  code?: string | null;
  regionId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Lifecycle state: pending review, live, or soft-closed. */
  status: StoreStatus;
  isActive: boolean;
  /** true for the synthetic "All Stores" aggregate — not editable. */
  isAggregate: boolean;
  managers: StoreManager[];
}

/** A pending branch awaiting the details it needs before it can go live. */
export interface PendingStore {
  id: string;
  name: string;
  city: string;
  code?: string | null;
  regionId?: string | null;
  status: StoreStatus;
  /** Geofence (lat/lng) still missing — blocks activation. */
  needsGeo: boolean;
  /** Region assignment still missing — blocks activation. */
  needsRegion: boolean;
  /** No store-manager login yet — does not block activation. */
  needsManager: boolean;
}

export interface CreateStoreInput {
  name: string;
  city: string;
  code?: string;
  regionId?: string;
  latitude?: number;
  longitude?: number;
}

export interface UpdateStoreInput {
  id: string;
  name?: string;
  city?: string;
  code?: string;
  isActive?: boolean;
  regionId?: string;
  latitude?: number;
  longitude?: number;
}

export interface AddStoreManagerInput {
  storeId: string;
  name: string;
  email: string;
  phone?: string;
  password: string;
}

export interface StoreManagerCreated {
  userId: string;
  name: string;
  email: string;
  storeId: string;
}

/** GET /stores — every store with its lifecycle status + manager logins. */
export function useStoresAdmin() {
  return useQuery({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data } = await api.get<AdminStore[]>("/stores");
      return data;
    },
  });
}

/**
 * GET /stores/pending — branches still awaiting geo/region/manager before they
 * can go live. The whole store lifecycle (provision/activate/close/edit) is
 * head-office only, so this is enabled for head office alone (the endpoint 403s
 * below that rank).
 */
export function usePendingStores() {
  const role = useSession((s) => s.role);
  return useQuery({
    queryKey: ["stores", "pending"],
    enabled: ROLE_RANK[role] >= ROLE_RANK.head_office,
    queryFn: async () => {
      const { data } = await api.get<PendingStore[]>("/stores/pending");
      return data;
    },
  });
}

/** POST /stores — provision a new store branch. */
export function useCreateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStoreInput) => {
      const { data } = await api.post<AdminStore>("/stores", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
      qc.invalidateQueries({ queryKey: ["stores", "pending"] });
    },
  });
}

/** PATCH /stores/:id — rename, relocate, set geo/region or (de)activate. */
export function useUpdateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateStoreInput) => {
      const { data } = await api.patch<AdminStore>(`/stores/${id}`, body);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
      qc.invalidateQueries({ queryKey: ["stores", "pending"] });
    },
  });
}

/**
 * PATCH /stores/:id/activate — flip a pending branch to active.
 * The server 400s (with a message) if the geofence or region is still
 * missing, so callers should surface that message and route the user to
 * set those first.
 */
export function useActivateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.patch<AdminStore>(`/stores/${id}/activate`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
      qc.invalidateQueries({ queryKey: ["stores", "pending"] });
    },
  });
}

/** PATCH /stores/:id/close — soft-close a branch; its history is preserved. */
export function useCloseStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.patch<AdminStore>(`/stores/${id}/close`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
      qc.invalidateQueries({ queryKey: ["stores", "pending"] });
    },
  });
}

/** POST /stores/:id/manager — create + assign a store-manager login. */
export function useAddStoreManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ storeId, ...body }: AddStoreManagerInput) => {
      const { data } = await api.post<StoreManagerCreated>(
        `/stores/${storeId}/manager`,
        body,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
    },
  });
}
