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
  ProductSource,
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
  /** Style number, SKU, name, Gati id or website code — matched anywhere in them. */
  q?: string;
  category?: ProductCategory;
  metal?: Metal;
  availability?: Availability;
  /** Explicit store filter (distinct from the session store scope). */
  storeId?: string;
  /** Website listing sub-category, as the listing spells it. */
  subCategory?: string;
  /** A size option, e.g. "IND 12". */
  size?: string;
  karat?: number;
  /** Variant / image colour, e.g. "rose". */
  colour?: string;
  /** Rupees; matched against the online minimum, else the tag price. */
  priceMin?: number;
  priceMax?: number;
  source?: ProductSource;
  imageCoverage?: ImageCoverage;
}

export type ImageCoverage = "none" | "no_cad" | "unindexed" | "indexed";

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
      // shop iPad. Only when it IS a gallery: an API answering with something
      // else must not poison the cache.
      if (Array.isArray(images)) qc.setQueryData(["product-images", productIdOf(vars)], images);
      else qc.invalidateQueries({ queryKey: ["product-images", productIdOf(vars)] });
      // The detail view reads images, hero and order from /full.
      qc.invalidateQueries({ queryKey: ["product-full"] });
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

/**
 * Pin one photo as the design’s primary (head office). The pin outranks the
 * default order (CAD, then website…) until it is removed.
 */
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

/** Remove the head-office pin; the default order (CAD first) takes over again. */
export function useUnpinPrimaryProductImage() {
  return useGalleryMutation(
    async ({ id, imageId }: { id: string; imageId: string }) => {
      const { data } = await api.delete<ProductImage[]>(
        `/products/${id}/images/${imageId}/primary`,
      );
      return data;
    },
    (v) => v.id,
  );
}

// ---------------------------------------------------------------------------
// GET /products/:id/full — everything about one design, fetched lazily when the
// detail opens. Shapes follow docs/modules/05-catalogue-sources.md ("Product
// API"). Cost fields (rates, amounts, margins, raw-material ids) are stripped
// server-side by role; the UI shows a column only when the response has it.
// ---------------------------------------------------------------------------

export interface WebsiteListing {
  marketingName?: string | null;
  slug?: string | null;
  categories?: string[];
  subCategories?: string[];
  features?: string[];
  tags?: string[];
  countries?: string[];
  isActive?: boolean;
  isDeleted?: boolean;
  description?: string | null;
  sizeGuide?: string | null;
  tombstonedAt?: string | null;
}

/** One BOM line as the source sent it — its keys are the source's, not ours. */
export type BomLine = Record<string, unknown>;

export interface ProductVariantView {
  id: string;
  source?: string;
  sourceKey?: string;
  /** Server-built "18K · Yellow Gold · Natural". */
  label?: string | null;
  sku?: string | null;
  metalType?: string | null;
  karat?: number | null;
  metal?: Metal | null;
  diamondType?: string | null;
  colour?: string | null;
  weightType?: string | null;
  goldWeight?: number | null;
  diamondWeight?: number | null;
  stoneWeight?: number | null;
  totalWeight?: number | null;
  price?: number | null;
  /** Store manager and up only. */
  priceWithMargin?: number | null;
  marginPercentage?: number | null;
  makingCharge?: number | null;
  currency?: string | null;
  bom?: BomLine[] | null;
  status?: string | null;
}

export interface ProductPriceView {
  id?: string;
  /** Variant id for variant prices; null for product-level prices. */
  variantId?: string | null;
  variantLabel?: string | null;
  source: string;
  kind: string;
  /** Server-side label, when it sends one. */
  label?: string | null;
  amount: number;
  currency?: string | null;
}

export interface StoreAvailability {
  storeId: string;
  storeName: string;
  count: number;
  /** The viewer's own store. */
  here?: boolean;
}

/** A physical piece with everything Gati knows about it. Amounts are role-gated. */
export interface StockPieceFull {
  id: string;
  tagNo?: string | null;
  storeId?: string | null;
  storeName?: string | null;
  status?: string | null;
  sizeLabel?: string | null;
  hsn?: string | null;
  huid?: string | null;
  hallmarkNo?: string | null;
  certificateNo?: string | null;
  productCode?: string | null;
  quantity?: number | null;
  grossWeight?: number | null;
  netWeight?: number | null;
  pureWeight?: number | null;
  diamondWeightCt?: number | null;
  diamondPieces?: number | null;
  stoneWeightCt?: number | null;
  stonePieces?: number | null;
  tagPrice?: number | null;
  mrp?: number | null;
  metalAmount?: number | null;
  diamondAmount?: number | null;
  stoneAmount?: number | null;
  makingAmount?: number | null;
  cpfAmount?: number | null;
  cost?: number | null;
  variantId?: string | null;
  inwardDate?: string | null;
  ageDays?: number | null;
}

export interface CatalogueConflictView {
  id: string;
  kind: string;
  summary: string;
  status?: string;
  productId?: string | null;
  externalId?: string | null;
  detail?: Record<string, unknown> | null;
  resolution?: Record<string, unknown> | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
}

/**
 * GET /products/:id/full: the list-card view of the product at the root, plus
 * everything below. Absent keys mean "not sent to this role" or "none".
 */
export type ProductFull = Product & {
  hsn?: string | null;
  legacyId?: string | null;
  /** Store manager and up only. */
  costPrice?: number | null;
  identifiers?: Record<string, string | number | null | undefined> | null;
  listing?: WebsiteListing | null;
  /** Website specification text, verbatim, with where and when it came from. */
  specifications?: { text: string; source?: string | null; syncedAt?: string | null } | null;
  variants?: ProductVariantView[];
  /** Size options in source order. */
  sizes?: (string | { value: string; source?: string; sortOrder?: number })[];
  prices?: ProductPriceView[];
  availabilityByStore?: StoreAvailability[];
  pieces?: StockPieceFull[];
  /** Timestamps (…At) plus a few ids; the UI shows the timestamps. */
  provenance?: Record<string, string | null | undefined> | null;
  conflicts?: CatalogueConflictView[];
  /**
   * Set by THIS client when the API has no /full yet: the web app deploys on
   * its own (Vercel, on push) and the API by hand, so for a while one can be
   * ahead of the other. The detail then shows what the older endpoints have.
   */
  legacy?: boolean;
};

export function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

/** 403/404: the design was deleted, or is not in this viewer's scope. */
export function isNotFound(err: unknown): boolean {
  const s = httpStatus(err);
  return s === 404 || s === 403;
}

export function useProductFull(productId: string | null) {
  const storeId = useStoreKey();
  return useQuery({
    queryKey: ["product-full", storeId, productId],
    enabled: !!productId,
    retry: (count, err) => !isNotFound(err) && count < 2,
    queryFn: async (): Promise<ProductFull> => {
      try {
        const { data } = await api.get<ProductFull>(`/products/${productId}/full`);
        return data;
      } catch (err) {
        if (httpStatus(err) !== 404) throw err;
        // The route itself may be missing (older API): ask the long-standing
        // endpoint before calling the design gone. Its own 404 is the real one.
        const [{ data: product }, images, pieces] = await Promise.all([
          api.get<Product>(`/products/${productId}`),
          api.get<ProductImage[]>(`/products/${productId}/images`).then((r) => r.data, () => []),
          api.get<StockPiece[]>(`/products/${productId}/pieces`).then((r) => r.data, () => []),
        ]);
        return { ...product, images, pieces, legacy: true };
      }
    },
  });
}
