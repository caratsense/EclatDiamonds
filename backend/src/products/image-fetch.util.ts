import { readFile } from 'fs/promises';
import { join, resolve, sep } from 'path';

/**
 * A picture that could not be read. `permanent` means retrying cannot help
 * (404, not an image, too big, host not allowed); otherwise the queue retries.
 */
export class ImageFetchError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** The image type from the bytes themselves, never from a header or extension. */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

export interface FetchImageOptions {
  /** Local disk root served under `publicPrefix`. */
  baseDir: string;
  publicPrefix: string;
  /** Hosts (`host` or `host:port`) an http(s) picture may come from. */
  allowedHosts: string[];
  maxBytes: number;
  timeoutMs?: number;
}

/**
 * Read a catalogue picture from wherever its row says it lives: our own
 * `/uploads` disk, an inline `data:` URL, or an allow-listed http(s) host.
 * Everything else is refused — the URL comes from a sync, and a sync payload
 * must not be able to make the server fetch an arbitrary address.
 */
export async function fetchImage(url: string, o: FetchImageOptions): Promise<{ buffer: Buffer; mime: string }> {
  const buffer = await fetchBytes(url, o);
  if (buffer.length > o.maxBytes) throw new ImageFetchError(`image too large (${buffer.length} bytes)`, true);
  const mime = sniffImageMime(buffer);
  if (!mime) throw new ImageFetchError('not an image (unrecognised bytes)', true);
  return { buffer, mime };
}

async function fetchBytes(url: string, o: FetchImageOptions): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0 || !url.slice(0, comma).endsWith(';base64')) throw new ImageFetchError('not an image (bad data URL)', true);
    return Buffer.from(url.slice(comma + 1), 'base64');
  }
  if (url.startsWith(`${o.publicPrefix}/`)) {
    const root = resolve(o.baseDir);
    const file = resolve(join(root, url.slice(o.publicPrefix.length + 1)));
    if (!file.startsWith(root + sep)) throw new ImageFetchError('path outside the upload directory', true);
    try {
      return await readFile(file);
    } catch {
      throw new ImageFetchError('download failed: local file missing', true);
    }
  }
  let target = url;
  // Follow redirects by hand so every hop is checked against the allow-list.
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new ImageFetchError('download failed: invalid URL', true);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ImageFetchError('download failed: unsupported URL scheme', true);
    if (!o.allowedHosts.some((h) => h === u.host || h === u.hostname)) {
      throw new ImageFetchError(`download failed: host not allowed (${u.hostname})`, true);
    }
    let res: Response;
    try {
      res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
    } catch (e) {
      throw new ImageFetchError(`download failed: ${e instanceof Error ? e.message : e}`, false);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      target = new URL(res.headers.get('location')!, u).toString();
      continue;
    }
    if (!res.ok) {
      // 404/403/410 will not fix themselves; 429/5xx might.
      throw new ImageFetchError(`download failed: HTTP ${res.status}`, res.status < 500 && res.status !== 429 && res.status !== 408);
    }
    if (Number(res.headers.get('content-length') ?? 0) > o.maxBytes) {
      throw new ImageFetchError(`image too large (${res.headers.get('content-length')} bytes)`, true);
    }
    // Count while reading: a missing or lying content-length must not let a
    // response fill memory.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > o.maxBytes) throw new ImageFetchError(`image too large (> ${o.maxBytes} bytes)`, true);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new ImageFetchError('download failed: too many redirects', true);
}
