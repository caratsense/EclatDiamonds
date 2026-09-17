"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useStoreKey } from "@/lib/queries/keys";
import type {
  Availability,
  Metal,
  Product,
  ProductCategory,
  ProductImage,
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
  /**
   * What the thing actually is, for an industry whose products have no honest
   * member of the jewellery `ProductCategory` / `Metal` enums. Those columns
   * take `other` / `unspecified` and the real words are carried here.
   */
  categoryLabel?: string;
  materialLabel?: string;
  unitOfMeasure?: string;
  /** Tenant-defined fields, keyed by AttributeDefinition.key. */
  attributes?: Record<string, unknown>;
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

/** Every mutation below returns the design’s full gallery, so they share this. */
function useGalleryMutation<V>(
  call: (vars: V) => Promise<ProductImage[]>,
  productIdOf: (vars: V) => string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (images, vars) => {
      // Seed the cache from the response instead of refetching: the server just
      // told us the new state, and a round trip here is a visible flicker on a
      // shop iPad.
      qc.setQueryData(["product-images", productIdOf(vars)], images);
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

/** GET /products/:id/images — every angle of a design, cover first. */
export function useProductImages(productId: string | null) {
  return useQuery({
    queryKey: ["product-images", productId],
    enabled: !!productId,
    queryFn: async () => {
      const { data } = await api.get<ProductImage[]>(`/products/${productId}/images`);
      return data;
    },
  });
}

/**
 * POST /products/:id/images — add photographs, several at once.
 *
 * One request for the whole set rather than one per angle: they are taken back
 * to back at the counter, and a round trip each over shop wifi is how somebody
 * ends up uploading only the front.
 */
export function useAddProductImages() {
  return useGalleryMutation(
    async ({ id, files, angles }: { id: string; files: File[]; angles?: string[] }) => {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      // Positional, one per file, so the server can pair them up.
      if (angles) for (const a of angles) form.append("angles", a ?? "");
      const { data } = await api.post<ProductImage[]>(`/products/${id}/images`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        // Several full-resolution iPad photos on shop wifi outlast the shared
        // 15s default, and a timeout here looks exactly like a rejected upload.
        timeout: 120_000,
      });
      return data;
    },
    (v) => v.id,
  );
}

/** Make one photo the design’s cover. */
export function useSetPrimaryProductImage() {
  return useGalleryMutation(
    async ({ id, imageId }: { id: string; imageId: string }) => {
      const { data } = await api.post<ProductImage[]>(
        `/products/${id}/images/${imageId}/primary`,
      );
      return data;
    },
    (v) => v.id,
  );
}

/** Remove one photo; the server re-elects a cover if it was the one removed. */
export function useDeleteProductImage() {
  return useGalleryMutation(
    async ({ id, imageId }: { id: string; imageId: string }) => {
      const { data } = await api.delete<ProductImage[]>(`/products/${id}/images/${imageId}`);
      return data;
    },
    (v) => v.id,
  );
}
