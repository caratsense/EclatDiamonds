"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  Availability,
  Metal,
  Product,
  ProductCategory,
} from "@/lib/mock/catalogue";

export interface CreateProductInput {
  sku: string;
  name: string;
  category: ProductCategory;
  metal: Metal;
  karat?: number;
  weightGrams?: number;
  caratWeight?: number;
  price?: number;
  availability?: Availability;
  leadTimeDays?: number;
  description?: string;
  storeId?: string;
}

/** Paginated envelope returned by list endpoints when page params are sent. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductListParams {
  /** 1-based page index — always sent so the API returns the envelope. */
  page: number;
  pageSize: number;
  category?: ProductCategory;
  metal?: Metal;
  availability?: Availability;
  /** Explicit store filter (distinct from the session store scope). */
  storeId?: string;
}

/**
 * GET /products — unified catalogue index, server-paginated. The API scopes
 * to the active store (or all stores for broad roles on the "all" scope);
 * category / metal / availability / store filters are applied server-side so
 * `total` reflects the filtered count. Page + pageSize are always sent, which
 * makes the response the `{ items, total, page, pageSize }` envelope.
 */
export function useProducts(params: ProductListParams) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["products", storeId, params],
    queryFn: async () => {
      const { data } = await api.get<Paginated<Product>>("/products", {
        params,
      });
      return data;
    },
    // Keep the previous page on screen while the next one loads — page flips
    // must not flash the grid empty (TanStack v5 keepPreviousData equivalent).
    placeholderData: (prev) => prev,
  });
}

/** POST /products — create a catalogue product (manager+). */
export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductInput) => {
      const { data } = await api.post<Product>("/products", input);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

/** One physical piece on hand — the real tagged price + tracking identifiers. */
export interface StockPiece {
  id: string;
  /** Gati JewelId — the piece's tag / batch number. */
  tagNo: string;
  storeId: string;
  storeName: string;
  status: string;
  grossWeight: number;
  netWeight: number;
  diamondWeightCt: number;
  diamondPieces: number;
  tagPrice: number;
  mrp: number;
  hallmarkNo: string;
  certificateNo: string;
  inwardDate: string | null;
  ageDays: number | null;
}

/**
 * GET /products/:id/pieces — the physical pieces of a design on hand in the
 * viewer's scope, each with its actual tag price and tracking (tag no, hallmark,
 * certificate). Only fetched while the detail dialog is open.
 */
export function useProductPieces(productId: string | null) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["product-pieces", storeId, productId],
    enabled: !!productId,
    queryFn: async () => {
      const { data } = await api.get<StockPiece[]>(`/products/${productId}/pieces`);
      return data;
    },
  });
}

export interface ImageSearchResult {
  aiUsed: boolean;
  detected: { category: string; metal: string; keywords: string[] } | null;
  results: (Product & { similarity?: number })[];
}

/**
 * POST /products/image-search — upload a design photo, get ranked catalogue
 * matches (Claude vision tagging + rule-based match, server-side).
 */
export function useImageSearch() {
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post<ImageSearchResult>(
        "/products/image-search",
        form,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      return data;
    },
  });
}

/**
 * POST /products/:id/image — upload/replace a product photo (manager+).
 * Sends multipart form-data; refreshes the catalogue on success.
 */
export function useUploadProductImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post<Product>(`/products/${id}/image`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}
