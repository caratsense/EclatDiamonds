import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchJson } from '../integrations/integrations.util';

/**
 * Pull a numeric embedding out of whatever shape the provider returned, or null.
 *
 * Deliberately tolerant of the two shapes real CLIP-style embedding servers use:
 *   { embedding: [...] }              (most self-hosted / HF inference endpoints)
 *   { data: [{ embedding: [...] }] }  (OpenAI-compatible embedding APIs)
 * plus a bare array. NEVER fabricates numbers — a non-finite or empty result is
 * treated as "no embedding" so a bad response can't poison the catalogue.
 */
export function parseEmbedding(data: any): number[] | null {
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.embedding)
      ? data.embedding
      : Array.isArray(data?.data?.[0]?.embedding)
        ? data.data[0].embedding
        : null;
  if (!raw || !raw.length) return null;
  const vec = raw.map((n: any) => Number(n));
  if (vec.some((n: number) => !Number.isFinite(n))) return null;
  return vec;
}

/**
 * Provider-agnostic image-embedding abstraction (Module 5, real visual search).
 *
 * `embedImage` turns image bytes into a vector via a config-gated HTTP provider.
 * With NO provider configured it returns null — the feature is simply unavailable;
 * it never invents a vector. The interface is intentionally one method so the
 * underlying model (CLIP / SigLIP / a multimodal embedding API) can be swapped by
 * config alone, with no vendor hardcoded.
 *
 * BLOCKED until an image-embedding provider + credential exist:
 *   IMAGE_EMBEDDING_PROVIDER=http
 *   IMAGE_EMBEDDING_URL=<embedding endpoint>
 *   IMAGE_EMBEDDING_KEY=<bearer token>
 * The endpoint must accept POST { image: <base64>, mime } and return an embedding
 * array in one of the shapes `parseEmbedding` understands.
 */
@Injectable()
export class ImageEmbeddingService {
  private readonly logger = new Logger(ImageEmbeddingService.name);

  constructor(private readonly config: ConfigService) {}

  private get provider(): string {
    return (this.config.get<string>('IMAGE_EMBEDDING_PROVIDER') ?? '').toLowerCase();
  }
  private get url(): string {
    return this.config.get<string>('IMAGE_EMBEDDING_URL') ?? '';
  }
  private get key(): string {
    return this.config.get<string>('IMAGE_EMBEDDING_KEY') ?? '';
  }

  /** True only when a supported provider is fully configured. */
  get available(): boolean {
    // 'http' is the only implemented provider; anything else (incl. blank) is
    // treated as unavailable rather than silently guessed.
    return this.provider === 'http' && Boolean(this.url && this.key);
  }

  /**
   * Embed an image to a vector, or null when the provider is unavailable, the
   * input is empty, or the call fails/times out. NEVER returns a fabricated vector.
   */
  async embedImage(bytes: Buffer | undefined, mime: string): Promise<number[] | null> {
    if (!this.available || !bytes?.length) return null;
    try {
      const data = await fetchJson(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.key}`,
        },
        timeoutMs: 30_000,
        body: JSON.stringify({ image: bytes.toString('base64'), mime }),
      });
      const vec = parseEmbedding(data);
      if (!vec) this.logger.warn('image embedding provider returned no usable vector');
      return vec;
    } catch (err) {
      this.logger.warn(
        `image embedding failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
