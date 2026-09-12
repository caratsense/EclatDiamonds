import { Injectable, Logger } from '@nestjs/common';

/**
 * The one place an adapter reaches the internet.
 *
 * ## Why a class and not `fetch` inline
 *
 * Not abstraction for its own sake — it is the seam the fixture tests need. An
 * adapter that calls `fetch` directly can only be tested by either contacting a
 * real provider (which nobody here is provisioned for) or by monkey-patching a
 * global (which leaks between tests). Injecting one narrow service means an
 * adapter can be driven end to end, request construction included, against a
 * stub that asserts exactly what would have gone on the wire.
 *
 * ## What it guarantees on the way out
 *
 *  - A hard timeout. Every provider is somebody else's uptime, and an outbound
 *    call with no deadline turns their bad afternoon into a stuck worker here.
 *  - `redirect: 'error'`. A 302 on an authenticated POST would replay the
 *    Authorization header at whatever host the redirect names.
 *  - A REDACTED error. Provider errors echo request values, so the message that
 *    reaches a log or a JobTask row is stripped of bearer material, URLs and
 *    long opaque runs, and bounded in length.
 */

export interface OutboundResponse {
  status: number;
  ok: boolean;
  /** Parsed when the body was JSON; the raw text otherwise. */
  body: unknown;
}

export class OutboundHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'OutboundHttpError';
  }
}

@Injectable()
export class OutboundHttp {
  private readonly log = new Logger(OutboundHttp.name);

  async postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs = 10_000,
  ): Promise<OutboundResponse> {
    // Refused here rather than at each caller: an adapter assembling a URL from
    // tenant configuration must not be able to reach a plaintext host with a
    // credential attached.
    if (!/^https:\/\//i.test(url)) {
      throw new OutboundHttpError('Refusing to send a credential over a non-https URL.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const raw = (await response.text()).slice(0, 64_000);
      return { status: response.status, ok: response.ok, body: parse(raw) };
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'could not be made';
      throw new OutboundHttpError(`The request to the provider ${reason}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turn a provider's failure into something safe to store.
   *
   * Providers echo request values in their errors — including, on a bad day, a
   * token. This is the only text from a provider that reaches a log line, an
   * audit row or a screen.
   */
  static redact(value: unknown, status: number | null): string {
    const generic = status ? `The provider refused it (HTTP ${status}).` : 'The provider refused it.';
    if (typeof value !== 'string' || !value.trim()) return generic;
    const safe = value
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/(?:bearer\s+|access_token\s*[=:]\s*|api[_-]?key\s*[=:]\s*)\S+/gi, '[redacted]')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[A-Za-z0-9_-]{80,}/g, '[opaque]')
      .trim()
      .slice(0, 300);
    return safe ? `${status ? `HTTP ${status}: ` : ''}${safe}` : generic;
  }

  /** Pull a provider's own error message out of a parsed body. */
  static providerMessage(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body;
    const row = body as Record<string, unknown>;
    const error = row.error;
    if (error && typeof error === 'object') {
      const inner = error as Record<string, unknown>;
      return inner.message ?? inner.description ?? inner.detail ?? JSON.stringify(inner).slice(0, 300);
    }
    return row.message ?? error ?? null;
  }
}

function parse(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
