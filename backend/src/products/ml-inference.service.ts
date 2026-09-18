import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchJson } from '../integrations/integrations.util';
import { parseEmbedding } from './image-embedding.service';

/**
 * One piece of jewellery the inference service found inside a picture, embedded
 * on its own: the pendant on a velvet stand, each render on a CAD sheet, the
 * ring on a hand. The whole-picture vector sits alongside, never replaced.
 */
export interface View {
  dino: number[];
  siglip: number[];
}

/** A dual visual embedding for one image. */
export interface DualEmbedding {
  dino: number[];
  siglip: number[];
  /** Detected jewellery, best first. Empty from a service without the detector. */
  views: View[];
  dinoModelVersion: string;
  siglipModelVersion: string;
  preprocessingVersion: string;
  imageHash: string;
}

/** The model/pipeline versions the inference service is currently serving. */
export interface InferenceVersions {
  dino?: string;
  siglip?: string;
  preprocessing?: string;
}

export interface BatchItem {
  id: string;
  bytes: Buffer;
  mime: string;
}
export interface BatchResult {
  id: string;
  dino: number[];
  siglip: number[];
  views: View[];
  imageHash?: string;
}

/** The views in a response, keeping only well-formed ones. */
function parseViews(raw: unknown): View[] {
  if (!Array.isArray(raw)) return [];
  const out: View[] = [];
  for (const v of raw) {
    const dino = parseEmbedding(v?.dino);
    const siglip = parseEmbedding(v?.siglip);
    if (dino && siglip) out.push({ dino, siglip });
  }
  return out;
}

/**
 * Client for the separately-built DINOv3 + SigLIP 2 inference service (Module 5).
 *
 * Config-gated exactly like ImageEmbeddingService: with NO `ML_INFERENCE_URL` set
 * the service reports `available:false` and every call returns null/empty — the
 * feature is simply off, it NEVER fabricates a vector. Contract:
 *   POST /embed        { image_b64, mime } -> { dino, siglip, views:[{box,score,dino,siglip}], model_versions, preprocessing_version, image_hash }
 *   POST /embed/batch  { images:[{id,image_b64,mime}] } -> { results:[{id,dino,siglip,views,image_hash}], errors:[...] }
 *   GET  /health       -> { model_versions:{dino,siglip}, preprocessing_version, ... }
 * Optional bearer via `ML_INFERENCE_KEY`.
 */
@Injectable()
export class MlInferenceService {
  private readonly logger = new Logger(MlInferenceService.name);

  constructor(private readonly config: ConfigService) {}

  private get url(): string {
    return (this.config.get<string>('ML_INFERENCE_URL') ?? '').replace(/\/+$/, '');
  }
  private get key(): string {
    return this.config.get<string>('ML_INFERENCE_KEY') ?? '';
  }

  /** True only when an inference endpoint is configured. */
  get available(): boolean {
    return Boolean(this.url);
  }

  /**
   * One retry, for a service that is allowed to be asleep.
   *
   * The inference container runs with Railway Serverless on: after ten idle
   * minutes it is stopped, and the request that wakes it either times out while
   * two vision models load or comes back 502. Both are normal, both are
   * transient, and without this the caller sees an ordinary failure and quietly
   * returns no vector -- an image search that silently finds nothing.
   *
   * Deliberately one retry, not a backoff loop: if the second attempt also fails
   * the service is broken rather than sleeping, and hammering it helps nobody.
   * The retry is given a longer budget because a cold start is the slow case by
   * definition.
   */
  private async wakeAware<T>(
    what: string,
    call: (timeoutMs: number) => Promise<T>,
    warmMs: number,
    coldMs: number,
  ): Promise<T> {
    try {
      return await call(warmMs);
    } catch (err) {
      this.logger.log(`inference ${what} failed (${err instanceof Error ? err.message : err}); retrying once in case it was asleep`);
      return await call(coldMs);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.key) h.authorization = `Bearer ${this.key}`;
    return h;
  }

  /** Best-effort probe of the versions currently served. Nulls on any failure. */
  async currentVersions(): Promise<InferenceVersions> {
    if (!this.available) return {};
    try {
      const data = await fetchJson(`${this.url}/health`, {
        method: 'GET',
        headers: this.headers(),
        timeoutMs: 10_000,
      });
      return {
        dino: data?.model_versions?.dino,
        siglip: data?.model_versions?.siglip,
        // The service returns preprocessing_version as an int; the DB column is a
        // String, so normalise it here (a number would fail the Prisma upsert).
        preprocessing:
          data?.preprocessing_version != null ? String(data.preprocessing_version) : undefined,
      };
    } catch (err) {
      this.logger.warn(`inference /health failed: ${err instanceof Error ? err.message : err}`);
      return {};
    }
  }

  /** Embed a single image, or null when unavailable / empty / the call fails. */
  async embed(bytes: Buffer | undefined, mime: string): Promise<DualEmbedding | null> {
    if (!this.available || !bytes?.length) return null;
    try {
      const body = JSON.stringify({ image_b64: bytes.toString('base64'), mime });
      const data = await this.wakeAware(
        '/embed',
        (timeoutMs) =>
          fetchJson(`${this.url}/embed`, {
            method: 'POST',
            headers: this.headers(),
            timeoutMs,
            body,
          }),
        30_000,
        180_000,
      );
      const dino = parseEmbedding(data?.dino);
      const siglip = parseEmbedding(data?.siglip);
      if (!dino || !siglip) {
        this.logger.warn('inference /embed returned no usable dual vector');
        return null;
      }
      return {
        dino,
        siglip,
        views: parseViews(data?.views),
        dinoModelVersion: data?.model_versions?.dino ?? 'unknown',
        siglipModelVersion: data?.model_versions?.siglip ?? 'unknown',
        preprocessingVersion:
          data?.preprocessing_version != null ? String(data.preprocessing_version) : 'unknown',
        imageHash: data?.image_hash ?? '',
      };
    } catch (err) {
      this.logger.warn(`inference /embed failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Embed a batch. Returns per-id results plus per-id errors so one bad image
   * never fails the whole re-index. Throws only when the whole call fails (so the
   * caller can mark every item in the chunk failed without corrupting existing
   * rows).
   */
  async embedBatch(items: BatchItem[]): Promise<{ results: BatchResult[]; errors: { id: string; error: string }[] }> {
    if (!this.available || !items.length) return { results: [], errors: [] };
    const batchBody = JSON.stringify({
      images: items.map((i) => ({ id: i.id, image_b64: i.bytes.toString('base64'), mime: i.mime })),
    });
    const data = await this.wakeAware(
      '/embed/batch',
      (timeoutMs) =>
        fetchJson(`${this.url}/embed/batch`, {
          method: 'POST',
          headers: this.headers(),
          timeoutMs,
          body: batchBody,
        }),
      120_000,
      300_000,
    );
    const results: BatchResult[] = [];
    for (const r of data?.results ?? []) {
      const dino = parseEmbedding(r?.dino);
      const siglip = parseEmbedding(r?.siglip);
      if (dino && siglip) {
        results.push({ id: r.id, dino, siglip, views: parseViews(r?.views), imageHash: r?.image_hash });
      }
    }
    const errors = (data?.errors ?? []).map((e: any) => ({ id: e?.id, error: String(e?.error ?? 'error') }));
    return { results, errors };
  }
}
