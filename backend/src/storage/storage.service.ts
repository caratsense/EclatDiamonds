import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'fs/promises';
import { isAbsolute, join } from 'path';

/**
 * Object/file storage for jewellery images + return photos.
 *
 * Pluggable provider: the default is **local disk** (no account needed — dev &
 * small single-server deploys), served statically at `/uploads`. Postgres only
 * ever stores the returned URL/path (never the binary). Swapping to Cloudflare
 * R2 / Cloudinary in production is a provider change here + env keys; the rest of
 * the app (which only sees a URL string) is unaffected.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly config: ConfigService) {}

  /** Filesystem root for uploads (UPLOAD_DIR, else <cwd>/uploads). */
  get baseDir(): string {
    const configured = this.config.get<string>('UPLOAD_DIR');
    if (configured) return isAbsolute(configured) ? configured : join(process.cwd(), configured);
    return join(process.cwd(), 'uploads');
  }

  /** Public URL prefix the static handler serves `baseDir` under. */
  readonly publicPrefix = '/uploads';

  /**
   * Persist a file buffer under `<baseDir>/<folder>/<filename>` and return its
   * public path (e.g. `/uploads/products/abc.jpg`). The frontend prefixes this
   * with NEXT_PUBLIC_API_URL to load it directly from the backend/CDN.
   */
  async save(folder: string, filename: string, buffer: Buffer): Promise<string> {
    const safeFolder = folder.replace(/[^a-zA-Z0-9._/-]/g, '_');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = join(this.baseDir, safeFolder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeName), buffer);
    const path = `${this.publicPrefix}/${safeFolder}/${safeName}`;
    this.logger.log(`stored ${buffer.length}B -> ${path}`);
    return path;
  }
}
