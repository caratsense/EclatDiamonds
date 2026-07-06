import { timingSafeEqual } from 'crypto';

/**
 * Shared low-level helpers for the external integrations (WhatsApp / Razorpay /
 * gold-rate). Kept dependency-free: Node 18+ global `fetch` + the built-in
 * `crypto` module, so no new packages are needed.
 */

/** Timing-safe string comparison — avoids leaking equality via response time. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort after this many ms (default 10s). */
  timeoutMs?: number;
}

/**
 * `fetch` wrapper that adds a hard timeout and throws a descriptive Error on a
 * non-2xx response. Parses the body as JSON when possible, otherwise returns the
 * raw text. Callers get either the parsed object or a thrown Error — never a
 * silent failure.
 */
export async function fetchJson(url: string, opts: FetchOpts = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? safeJsonParse(text) : null;
    if (!res.ok) {
      const msg =
        data?.error?.message || data?.error?.description || data?.message || text || res.statusText;
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a raw webhook body (Buffer) into JSON, tolerating malformed input. */
export function parseRawJson(raw?: Buffer): any {
  if (!raw || raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return {};
  }
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
