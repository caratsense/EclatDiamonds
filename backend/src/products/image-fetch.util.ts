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
    // A generated placeholder cover travels inline in the row rather than as a
    // file, so this function has to understand three URL shapes, not two.
    // Decoding it here keeps the indexer honest about everything the column
    // actually holds — though a vector placeholder is not a photograph, and the
    // inference service is entitled to reject it once decoded.
    if (imageUrl.startsWith('data:')) {
      const comma = imageUrl.indexOf(',');
      if (comma < 0) return null;
      const header = imageUrl.slice(5, comma);
      if (!header.endsWith(';base64')) return null;
      return {
        buffer: Buffer.from(imageUrl.slice(comma + 1), 'base64'),
        mime: header.slice(0, -';base64'.length) || 'image/png',
      };
    }
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
