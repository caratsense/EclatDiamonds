import { readFile } from 'fs/promises';
import { join } from 'path';

interface StorageLike {
  publicPrefix: string;
  baseDir: string;
}

/**
 * Fetch the raw bytes of a stored product image from its URL — absolute
 * (R2/Cloudinary) or the local `/uploads/...` path. Returns null on any failure
 * rather than throwing, so a broken image just skips that one product during a
 * re-index instead of aborting the whole run.
 *
 * ponytail: mirrors AiImageSearchService.readImageBytes (private there) so the new
 * dual-embedding indexer doesn't have to touch the existing single-vector service.
 */
export async function readImageBytes(
  storage: StorageLike,
  imageUrl: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  try {
    if (/^https?:\/\//i.test(imageUrl)) {
      const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        mime: res.headers.get('content-type') ?? 'image/jpeg',
      };
    }
    const prefix = `${storage.publicPrefix}/`;
    if (imageUrl.startsWith(prefix)) {
      const rel = imageUrl.slice(prefix.length);
      const buffer = await readFile(join(storage.baseDir, rel));
      const ext = rel.toLowerCase().split('.').pop() ?? '';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return { buffer, mime };
    }
    return null;
  } catch {
    return null;
  }
}
