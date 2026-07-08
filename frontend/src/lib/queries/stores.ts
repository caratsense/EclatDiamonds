"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Store administration (head-office only).
 *
 * These hooks back the Store Setup page where HO provisions stores and
 * assigns each a store-manager login. Every store the API returns is already
 * a first-class, multi-store-scoped entity — creating one here gives it its
 * own scoped "individual system" via the existing store-switcher + X-Store-Id
 * header. All mutations invalidate ["stores"] so the table stays fresh.
 *
 * Contract (backend):
 *  GET   /stores               → AdminStore[]
 *  POST  /stores               → AdminStore
 *  PATCH /stores/:id           → AdminStore
 *  POST  /stores/:id/manager   → StoreManagerCreated
 */

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
  isActive: boolean;
  /** true for the synthetic "All Stores" aggregate — not editable. */
  isAggregate: boolean;
  managers: StoreManager[];
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

/** GET /stores — every store with its assigned manager logins (HO view). */
export function useStoresAdmin() {
  return useQuery({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data } = await api.get<AdminStore[]>("/stores");
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
    },
  });
}

/** PATCH /stores/:id — rename, relocate or (de)activate a store. */
export function useUpdateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateStoreInput) => {
      const { data } = await api.patch<AdminStore>(`/stores/${id}`, body);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
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
