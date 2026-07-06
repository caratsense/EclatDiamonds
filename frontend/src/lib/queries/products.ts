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

/**
 * GET /products — unified catalogue index. The API returns the active store's
 * products (or all stores for broad roles on the "all" scope). Category /
 * metal / availability filtering stays client-side over this set.
 */
export function useProducts() {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["products", storeId],
    queryFn: async () => {
      const { data } = await api.get<Product[]>("/products");
      return data;
    },
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
