"use client";

import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { ProductCategory } from "@/lib/mock/catalogue";

/** How close a hit is — colour-coded in the UI, never shown as raw cosine. */
export type MatchLevel =
  | "VERY_CLOSE"
  | "CLOSE"
  | "SIMILAR"
  | "WEAK"
  | "NO_CLOSE_MATCH";

export type SearchStatus =
  | "MATCHES_FOUND"
  | "NO_CLOSE_MATCH"
  | "NOT_INDEXED"
  | "SEARCH_ERROR";

/** Relevance feedback values accepted by the backend (training signal). */
export type SimilarityFeedbackValue =
  | "very_close"
  | "relevant"
  | "somewhat"
  | "not_relevant";

export interface SimilarityHit {
  productId: string;
  productName: string;
  /** SKU / reference, when the catalogue row has one. */
  sku?: string | null;
  imageUrl?: string | null;
  /** Store the design belongs to (null = company-wide); shown only when relevant to scope. */
  storeId?: string | null;
  storeName?: string | null;
  rank: number;
  /** 0–100, already normalised server-side (NOT a raw cosine). */
  closenessScore: number;
  matchLevel: MatchLevel;
}

/** One ranked visual-search result set is exactly the TOP 10 closest genuine matches. */
export const SIMILARITY_TOP_N = 10;

export interface SimilaritySearchResult {
  queryId: string;
  /** false → the inference service isn't wired in this env (not an error). */
  available: boolean;
  status: SearchStatus;
  matchLevel: MatchLevel;
  closenessScore: number;
  results: SimilarityHit[];
  /** Server-supplied reason on the unavailable / error paths. */
  reason?: string;
}

/** A search may carry up to this many views of the same piece. */
export const MAX_QUERY_IMAGES = 3;

export interface SimilaritySearchInput {
  /**
   * One to three photographs of the SAME piece, from different sides.
   *
   * Not several searches: the server scores each catalogue design on its best
   * view against your best view, and returns one list of designs.
   */
  files: File[];
  category?: ProductCategory;
  limit?: number;
}

/**
 * POST /products/jewelry/similarity-search — photograph a piece, get visually
 * ranked catalogue matches (DINO/SigLIP embeddings, server-side).
 * Auth: salesperson and up. Photos go as multipart `files`; category / limit
 * ride as query params.
 */
export function useSimilaritySearch() {
  return useMutation({
    mutationFn: async ({ files, category, limit }: SimilaritySearchInput) => {
      const form = new FormData();
      for (const f of files.slice(0, MAX_QUERY_IMAGES)) form.append("files", f);
      const { data } = await api.post<SimilaritySearchResult>(
        "/products/jewelry/similarity-search",
        form,
        {
          headers: { "Content-Type": "multipart/form-data" },
          params: { category, limit },
          // Three photos mean three embedding calls, and the inference service
          // is allowed to be cold. The shared 15s default turns a slow search
          // into what looks like a broken one.
          timeout: 120_000,
        },
      );
      return data;
    },
  });
}

export interface SimilarityFeedbackInput {
  queryId: string;
  productId: string;
  rank: number;
  feedback: SimilarityFeedbackValue;
}

/**
 * POST /products/jewelry/similarity-feedback — record whether a hit was
 * relevant. Fire-and-forget from the UI (a training signal, not user-blocking).
 */
export function useSimilarityFeedback() {
  return useMutation({
    mutationFn: async (input: SimilarityFeedbackInput) => {
      const { data } = await api.post<{ stored: boolean }>(
        "/products/jewelry/similarity-feedback",
        input,
      );
      return data;
    },
  });
}
