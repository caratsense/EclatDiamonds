"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { ImageSource, ProductCategory } from "@/lib/mock/catalogue";

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
  | "SEARCH_ERROR"
  /** Nothing in the org is indexed yet; the server did not call inference. */
  | "CATALOGUE_INDEX_BUILD_REQUIRED";

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
  /** The design's own photo that matched best — the detail opens on it. */
  matchedImageId?: string | null;
  matchedImageUrl?: string | null;
  matchedImageSource?: ImageSource | null;
  matchedColour?: string | null;
  matchedAngle?: string | null;
  /** Precedence #1 image (pin, else CAD…); stays marked "Primary" in the detail. */
  heroImageUrl?: string | null;
}

/** One ranked visual-search result set is exactly the TOP 10 closest genuine matches. */
export const SIMILARITY_TOP_N = 10;

/** How far the visual index has got, when a search needs it built first. */
export interface IndexCoverage {
  indexed: number;
  total: number;
  queued: number;
  failed: number;
}

export interface SimilaritySearchResult {
  queryId?: string;
  /** false → the inference service isn't wired in this env (not an error). */
  available?: boolean;
  status: SearchStatus;
  matchLevel?: MatchLevel;
  closenessScore?: number;
  results?: SimilarityHit[];
  /** Server-supplied reason on the unavailable / error paths. */
  reason?: string;
  coverage?: IndexCoverage;
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

/** The server is at its concurrent-search limit; try again after `retryAfterSec`. */
export class SearchBusyError extends Error {
  constructor(public retryAfterSec: number) {
    super("Visual search is busy");
  }
}

/** Retry-After is seconds or an HTTP date; anything unreadable → a sane default. */
export function parseRetryAfter(value: unknown, now = Date.now()): number {
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.min(Math.max(Math.ceil(n), 1), 300);
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.min(Math.max(Math.ceil((at - now) / 1000), 1), 300);
  }
  return 5;
}

/**
 * POST /products/jewelry/similarity-search — photograph a piece, get visually
 * ranked catalogue matches (DINOv2 + SigLIP 2 embeddings, server-side).
 * Auth: salesperson and up. All 1–3 photos go in ONE multipart request as
 * `files`; category / limit ride as query params. A 429 surfaces as
 * {@link SearchBusyError} carrying the server's Retry-After.
 */
export function useSimilaritySearch() {
  return useMutation({
    mutationFn: async ({ files, category, limit }: SimilaritySearchInput) => {
      const form = new FormData();
      for (const f of files.slice(0, MAX_QUERY_IMAGES)) form.append("files", f);
      try {
        const { data } = await api.post<SimilaritySearchResult>(
          "/products/jewelry/similarity-search",
          form,
          {
            headers: { "Content-Type": "multipart/form-data" },
            params: { category, limit },
            // The server holds one deadline (45s by default) for the whole
            // search; this only has to outlast it, not race it.
            timeout: 60_000,
          },
        );
        return data;
      } catch (err) {
        const res = (err as { response?: { status?: number; headers?: Record<string, unknown> } })
          .response;
        if (res?.status === 429) throw new SearchBusyError(parseRetryAfter(res.headers?.["retry-after"]));
        throw err;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Query photo preparation. A phone photo is 3–12 MB at 4000px; the matcher
// looks at a few hundred pixels. Shrinking on the device makes the upload
// 10× smaller over shop wifi and bakes the EXIF rotation into the pixels, so
// a portrait shot is not compared lying on its side.
// ---------------------------------------------------------------------------

export const QUERY_MAX_SIDE = 1600;
export const QUERY_MAX_BYTES = 1_000_000;
const QUALITIES = [0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5];
const SCALES = [1, 0.75, 0.5];

/** Scale (w, h) down so the long side is at most `max`; never up. */
export function fitWithin(w: number, h: number, max = QUERY_MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * First encoding under `maxBytes`, trying quality 0.9 down to 0.5, then smaller
 * scales. Returns the smallest attempt if none fits (the server still decides).
 */
export async function encodeUnder(
  encode: (scale: number, quality: number) => Promise<Blob>,
  maxBytes = QUERY_MAX_BYTES,
): Promise<Blob> {
  let smallest: Blob | null = null;
  for (const scale of SCALES) {
    for (const q of QUALITIES) {
      const blob = await encode(scale, q);
      if (blob.size <= maxBytes) return blob;
      if (!smallest || blob.size < smallest.size) smallest = blob;
    }
  }
  return smallest!;
}

/**
 * Resize + orient one photo to ≤1600px long side and ≤1 MB JPEG. A format the
 * browser cannot decode (HEIC outside Safari) goes up as-is for the server to
 * judge — refusing it here would be the browser guessing.
 */
export async function prepareQueryImage(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    const blob = await encodeUnder(async (scale, quality) => {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d")!;
      // JPEG has no alpha: a transparent PNG would otherwise turn black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality),
      );
    });
    const name = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
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

/** GET/POST /products/embeddings/reindex — counts by picture status (the queue is durable). */
export interface ReindexStatus {
  /** Anything queued, running or awaiting retry. */
  running: boolean;
  counts?: Record<string, number>;
  /** Current model + pipeline version key. */
  version?: string | null;
  /** How many pictures a POST queued. */
  queued?: number;
  startedAt?: string;
  finishedAt?: string;
  /** Photos processed so far (indexed, already current or unreadable), of all. */
  done?: number;
  total?: number;
  result?: { embedded?: number; skipped?: number; failed?: number; pruned?: number; total?: number };
  error?: string;
}

const REINDEX_KEY = ["visual-index-status"] as const;

/** Head office only. Polls while a rebuild is running, idle otherwise. */
export function useReindexStatus(enabled: boolean) {
  return useQuery({
    queryKey: REINDEX_KEY,
    enabled,
    queryFn: async () =>
      (await api.get<ReindexStatus>("/products/embeddings/reindex")).data,
    refetchInterval: (q) => (q.state.data?.running ? 5_000 : false),
  });
}

/**
 * Queue indexing. Without `force`: every picture not indexed at the current
 * version — which includes ones that failed or gave up, so this is also
 * "retry failed". With `force`: every picture, re-embedded from scratch.
 * Returns at once; the work runs as durable jobs.
 */
export function useStartReindex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts?: { force?: boolean }) =>
      (
        await api.post<ReindexStatus & { started: boolean }>(
          "/products/embeddings/reindex",
          undefined,
          { params: opts?.force ? { force: 1 } : undefined },
        )
      ).data,
    onSuccess: (data) => {
      qc.setQueryData(REINDEX_KEY, data);
      qc.invalidateQueries({ queryKey: ["catalogue-integration"] });
    },
  });
}
