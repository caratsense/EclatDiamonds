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
export interface BatchResult extends DualEmbedding {
  id: string;
  imageHash?: string;
  /** A ≤`thumbnailPx` rendition, when asked for and the service supports it. */
  thumb?: { bytes: Buffer; mime: string };
  width?: number;
  height?: number;
}
export interface BatchResponse {
  results: BatchResult[];
  errors: { id: string; error: string }[];
  /** Per-stage compute time reported by the service (decode/detect/dino/siglip). */
  timings: Record<string, number>;
  /** Wall time of the HTTP call, as seen from here. */
  wallMs: number;
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

function numbers(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}

/**
 * Client for the separately-built DINOv2 + SigLIP 2 inference service (Module 5).
 *
 * Config-gated: with NO `ML_INFERENCE_URL` the service reports `available:false`
 * and every call returns empty — the feature is off, it NEVER fabricates a
 * vector. Contract:
 *   POST /embed/batch  { images:[{id,image_b64,mime}], thumbnail_px? }
 *        -> { results:[{id,dino,siglip,views,image_hash,thumb_b64?,thumb_mime?,width?,height?}], errors:[...], timings_ms? }
 *   GET  /health       -> { models:{dino:{id},siglip:{id}} | model_versions:{dino,siglip}, preprocessing_version }
 * Optional key via `ML_INFERENCE_KEY`, sent as both `x-api-key` and a bearer.
 *
 * One attempt per call. Retrying belongs to the caller: the index queue backs
 * off between attempts, and search has a single deadline it must not exceed.
 */
@Injectable()
export class MlInferenceService {
  private readonly logger = new Logger(MlInferenceService.name);
  private versionsCache: { at: number; v: InferenceVersions } | null = null;

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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.key) {
      h.authorization = `Bearer ${this.key}`;
      h['x-api-key'] = this.key;
    }
    return h;
  }

  /**
   * The last versions a /health call returned — no network, never blocks.
   * Empty until one has succeeded. For callers on a request path (enqueue from
   * an upload or a sync); the worker checks the live version before it embeds.
   */
  cachedVersions(): InferenceVersions {
    return this.versionsCache?.v ?? {};
  }

  /**
   * The versions currently served, cached for 30s (every index job asks). Empty
   * on any failure — callers treat that as "cannot tell", never as a version.
   */
  async currentVersions(): Promise<InferenceVersions> {
    if (!this.available) return {};
    if (this.versionsCache && Date.now() - this.versionsCache.at < 30_000) return this.versionsCache.v;
    try {
      const data = await fetchJson(`${this.url}/health`, { method: 'GET', headers: this.headers(), timeoutMs: 10_000 });
      const v: InferenceVersions = {
        // Both health shapes seen in the wild: the service's own `models.*.id`
        // and the documented `model_versions`.
        dino: data?.model_versions?.dino ?? data?.models?.dino?.id,
        siglip: data?.model_versions?.siglip ?? data?.models?.siglip?.id,
        // An int from the service; the DB column is a String.
        preprocessing: data?.preprocessing_version != null ? String(data.preprocessing_version) : undefined,
      };
      if (v.dino && v.siglip && v.preprocessing) this.versionsCache = { at: Date.now(), v };
      return v;
    } catch (err) {
      this.logger.warn(`inference /health failed: ${err instanceof Error ? err.message : err}`);
      return {};
    }
  }

  /**
   * Embed a batch. Per-id results and per-id errors, so one bad image never
   * fails the rest. Throws only when the whole call fails or times out.
   */
  async embedBatch(items: BatchItem[], opts: { timeoutMs?: number; thumbnailPx?: number } = {}): Promise<BatchResponse> {
    if (!this.available || !items.length) return { results: [], errors: [], timings: {}, wallMs: 0 };
    const body = JSON.stringify({
      images: items.map((i) => ({ id: i.id, image_b64: i.bytes.toString('base64'), mime: i.mime })),
      ...(opts.thumbnailPx ? { thumbnail_px: opts.thumbnailPx } : {}),
    });
    const t0 = Date.now();
    const data = await fetchJson(`${this.url}/embed/batch`, {
      method: 'POST',
      headers: this.headers(),
      timeoutMs: opts.timeoutMs ?? 120_000,
      body,
    });
    const wallMs = Date.now() - t0;
    const results: BatchResult[] = [];
    for (const r of data?.results ?? []) {
      const dino = parseEmbedding(r?.dino);
      const siglip = parseEmbedding(r?.siglip);
      if (!dino || !siglip) continue;
      results.push({
        id: String(r.id),
        dino,
        siglip,
        views: parseViews(r?.views),
        imageHash: r?.image_hash,
        thumb:
          typeof r?.thumb_b64 === 'string' && r.thumb_b64
            ? { bytes: Buffer.from(r.thumb_b64, 'base64'), mime: String(r?.thumb_mime ?? 'image/jpeg') }
            : undefined,
        width: Number.isInteger(r?.width) ? r.width : undefined,
        height: Number.isInteger(r?.height) ? r.height : undefined,
      });
    }
    const errors = (data?.errors ?? []).map((e: any) => ({ id: String(e?.id), error: String(e?.error ?? 'error') }));
    return { results, errors, timings: numbers(data?.timings_ms), wallMs };
  }
}
