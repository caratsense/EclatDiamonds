import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Read-only client for the website's product API.
 *
 * GET only, to an allow-listed https host, never following a redirect (a
 * redirect could carry the bearer to a host nobody approved). Retries network
 * errors, 429 and 5xx with backoff; a 4xx is final. The token is passed in per
 * call by the service that decrypted it and is never stored or logged here.
 *
 * `fetchImpl` is a seam for tests: the suite replaces it, so no test can reach
 * the live website.
 */
export const DEFAULT_ALLOWED_HOSTS = 'apis.eclatdiamonds.in';
export const WEBSITE_PAGE_SIZE = 100;

export interface WebsitePage {
  products: unknown[];
  total: number | null;
  totalPages: number | null;
}

export class WebsiteClientError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

@Injectable()
export class WebsiteCatalogueClient {
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  /** Base backoff; tests set 0. */
  retryBaseMs = 1_000;
  attempts = 3;
  timeoutMs = 30_000;

  constructor(private readonly config: ConfigService) {}

  allowedHosts(): string[] {
    return (this.config.get<string>('WEBSITE_CATALOGUE_ALLOWED_HOSTS') ?? DEFAULT_ALLOWED_HOSTS)
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  /** Throws unless `base` is an https URL on an allow-listed host, without credentials. */
  assertAllowedBase(base: string): URL {
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new WebsiteClientError('Website API base URL is not a valid URL.', false);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new WebsiteClientError('Website API base URL must be https without credentials or fragment.', false);
    }
    if (!this.allowedHosts().includes(url.hostname.toLowerCase())) {
      throw new WebsiteClientError(`Website API host "${url.hostname}" is not allow-listed.`, false);
    }
    return url;
  }

  async fetchPage(base: string, token: string | null, page: number, limit = WEBSITE_PAGE_SIZE): Promise<WebsitePage> {
    const root = this.assertAllowedBase(base);
    const url = new URL(`${root.pathname.replace(/\/+$/, '')}/products`, root.origin);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    let last: WebsiteClientError | null = null;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return parsePage(await this.once(url, token));
      } catch (e) {
        last = e instanceof WebsiteClientError ? e : new WebsiteClientError(errorText(e), true);
        if (!last.retryable || attempt === this.attempts) break;
        await new Promise((r) => setTimeout(r, this.retryBaseMs * 2 ** (attempt - 1)));
      }
    }
    throw last ?? new WebsiteClientError('Website request failed.', true);
  }

  private async once(url: URL, token: string | null): Promise<unknown> {
    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      throw new WebsiteClientError(`Website API redirected (HTTP ${res.status}); not followed.`, false);
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new WebsiteClientError(`Website API answered HTTP ${res.status} for page ${url.searchParams.get('page')}.`, retryable);
    }
    try {
      return await res.json();
    } catch {
      throw new WebsiteClientError('Website API returned a body that is not JSON.', true);
    }
  }
}

function errorText(e: unknown): string {
  // Network errors never include the request headers, so this cannot leak the token.
  return e instanceof Error ? `Website request failed: ${e.name}: ${e.message}`.slice(0, 300) : 'Website request failed.';
}

const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Accepts the envelope shapes the feed has used: data[], data.products, docs, items; totals at any level. */
export function parsePage(body: unknown): WebsitePage {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const data = b.data;
  const products = Array.isArray(body)
    ? body
    : Array.isArray(data)
      ? data
      : Array.isArray(data?.products)
        ? data.products
        : Array.isArray(data?.docs)
          ? data.docs
          : Array.isArray(b.products)
            ? b.products
            : Array.isArray(b.items)
              ? b.items
              : Array.isArray(b.docs)
                ? b.docs
                : null;
  if (!products) throw new WebsiteClientError('Website API response has no product list.', false);
  const holders = [b, data, b.pagination, b.meta, data?.pagination, data?.meta].filter((h) => h && typeof h === 'object' && !Array.isArray(h));
  const pick = (keys: string[]) => {
    for (const h of holders) for (const k of keys) if (intOrNull(h[k]) != null) return intOrNull(h[k]);
    return null;
  };
  return {
    products,
    total: pick(['total', 'totalCount', 'totalDocs', 'totalProducts', 'totalItems']),
    totalPages: pick(['totalPages', 'pages', 'pageCount']),
  };
}
