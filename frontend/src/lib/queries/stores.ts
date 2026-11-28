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
  geofenceRadiusM?: number | null;
  /** Lifecycle state: pending review, live, or soft-closed. */
  status: StoreStatus;
  isActive: boolean;
  /** true for the synthetic "All Stores" aggregate — not editable. */
  isAggregate: boolean;
  /** true for a system quarantine bucket used by imports, never a physical branch. */
  isHolding: boolean;
  /** true for a physical attendance location that does not trade or hold stock. */
  attendanceOnly: boolean;
  /**
   * No geofence centre. Attendance still records punches here, but none of
   * them can be location-checked. Carried on ACTIVE branches too since
   * 28 Nov — a missing geofence no longer stops a branch going live, so the
   * screen is now the only thing that keeps saying it is missing.
   */
  needsGeo: boolean;
  /** No region, so this branch is absent from area-manager rollups. */
  needsRegion: boolean;
  /** Configured weekly off (0 = Sunday). Null when none has been set. */
  weekOffDay?: number | null;
  managers: StoreManager[];
}

/** A pending branch awaiting head office's review of the details it is missing. */
export interface PendingStore {
  id: string;
  name: string;
  city: string;
  code?: string | null;
  regionId?: string | null;
  status: StoreStatus;
  /** Holding buckets are informational and must never enter branch activation flows. */
  isHolding: boolean;
  /** Attendance locations are physical, but are not trading branches. */
  attendanceOnly: boolean;
  /**
   * Geofence (lat/lng) still missing. Attendance geofencing is off here until
   * it is set; it does NOT block activation (client, 28 Nov).
   */
  needsGeo: boolean;
  /**
   * Region assignment still missing, so the branch is absent from area
   * rollups. Does not block activation either.
   */
  needsRegion: boolean;
  /** No store-manager login yet. */
  needsManager: boolean;
}

export interface CreateStoreInput {
  name: string;
  city: string;
  code?: string;
  regionId?: string;
  latitude?: number;
  longitude?: number;
  geofenceRadiusM?: number;
}

export interface UpdateStoreInput {
  id: string;
  name?: string;
  city?: string;
  code?: string;
  regionId?: string;
  latitude?: number;
  longitude?: number;
  geofenceRadiusM?: number;
}

/** Optional geographical/management grouping returned by GET /regions. */
export interface StoreRegion {
  id: string;
  name: string;
  code?: string | null;
}

export interface CreateRegionInput {
  name: string;
  code?: string;
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
 * GET /stores/pending — branches head office has not reviewed yet, each
 * flagged with the geo/region/manager details it is still missing (none of
 * which stops it being activated). The whole store lifecycle
 * (provision/activate/close/edit) is
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

/** GET /regions — valid region choices for store create/edit forms. */
export function useRegions() {
  const role = useSession((s) => s.role);
  return useQuery({
    queryKey: ["regions"],
    enabled: ROLE_RANK[role] >= ROLE_RANK.store_manager,
    queryFn: async () => {
      const { data } = await api.get<StoreRegion[]>("/regions");
      return data;
    },
  });
}

/** POST /regions — head office creates an organisation-scoped region option. */
export function useCreateRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRegionInput) => {
      const { data } = await api.post<StoreRegion>("/regions", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["regions"] });
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

/** PATCH /stores/:id — rename, relocate, or set geo/region details. */
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
 * PATCH /stores/:id/activate — flip a pending or closed branch to active.
 *
 * It no longer refuses a branch whose geofence or region is missing. Those
 * serve attendance and area rollups, not trading, and refusing was stopping
 * the client from opening a shop that was already selling (28 Nov). The gaps
 * come back on the branch as `needsGeo` / `needsRegion` and stay visible.
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
