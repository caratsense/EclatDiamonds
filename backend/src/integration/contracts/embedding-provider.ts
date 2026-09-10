/**
 * CaratOS integration contracts — IMAGE EMBEDDING PROVIDER.
 *
 * Contracts only. Abstracts visual-similarity so it is never locked to one vendor.
 * The existing self-hosted DINOv2/SigLIP pipeline is one implementation; Gemini /
 * OpenAI / future models are adapters behind the same interface.
 *
 * Rules:
 *  - AI operates on CANONICAL products regardless of source system.
 *  - If a provider is unavailable, the catalogue still works and search reports a
 *    degraded state — it NEVER fabricates similarity scores.
 */

/** A vector embedding for one image, plus which model produced it. */
export interface ImageEmbedding {
  /** Model identifier, e.g. 'dinov2-vitb14' | 'siglip2' — for index compatibility. */
  model: string;
  /** Embedding dimensions (e.g. 768). */
  dim: number;
  vector: number[];
  /** Preprocessing version, so re-index can detect stale embeddings. */
  preprocessing?: string;
}

/** Whether the provider can currently produce embeddings. */
export type EmbeddingProviderState = 'available' | 'degraded' | 'unavailable';

export interface EmbeddingProviderHealth {
  state: EmbeddingProviderState;
  /** Human-readable reason when not 'available' (surfaced honestly in the UI). */
  detail?: string;
}

/**
 * Produces image embeddings for vector search. An implementation MUST return a
 * clear health state rather than throwing when the backing model is down, so the
 * caller can show "visual search unavailable" instead of a fake result.
 */
export interface ImageEmbeddingProvider {
  readonly name: string;

  /** Current provider health — checked before a search claims to be "visual". */
  health(): Promise<EmbeddingProviderHealth>;

  /**
   * Embed one image (bytes or an already-fetched buffer). Returns null when the
   * provider is unavailable — the caller degrades gracefully, never fabricates.
   */
  embed(image: EmbeddingInput): Promise<ImageEmbedding | null>;
}

/** Input to an embedding call — a buffer or a resolvable storage key/URL. */
export interface EmbeddingInput {
  bytes?: Uint8Array;
  storageKey?: string;
  url?: string;
}
