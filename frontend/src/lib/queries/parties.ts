"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type { Paginated } from "@/lib/queries/products";

/**
 * GET /parties — the customer directory, server-paginated + store-scoped. Keyed
 * on the active store so a store switch refetches. Defaults to `type=customer`;
 * the page can widen to suppliers / staff / all.
 */

export type PartyTypeName =
  | "customer"
  | "supplier"
  | "staff"
  | "salesperson"
  | "branch"
  | "account";

export interface PartyRow {
  id: string;
  name: string;
  code: string | null;
  types: PartyTypeName[];
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
  birthday: string | null;
  anniversary: string | null;
  creditLimit: number | null;
  isBlacklisted: boolean;
  salesCount: number;
  createdAt: string | null;
}

export interface PartyListParams {
  page: number;
  pageSize: number;
  q?: string;
  type?: PartyTypeName | "all";
}

export function useParties(params: PartyListParams) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["parties", storeId, params],
    queryFn: async () => {
      const { data } = await api.get<Paginated<PartyRow>>("/parties", { params });
      return data;
    },
    // Keep the previous page on screen while the next loads — no empty flash.
    placeholderData: (prev) => prev,
  });
}
