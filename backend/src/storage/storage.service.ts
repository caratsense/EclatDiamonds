import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { isAbsolute, join } from 'path';

/**
 * Object/file storage for jewellery images + return photos.
 *
 * Two providers, chosen by `STORAGE_PROVIDER`:
 *
 *  - `local` (default) — disk under `UPLOAD_DIR`, served at `/uploads`. No account
 *    needed; right for dev and a single small server.
 *  - `cloudinary` — set `STORAGE_PROVIDER=cloudinary` plus `CLOUDINARY_CLOUD_NAME`,
 *    `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
 *
 * Why the provider matters for THIS product: the catalogue is photograph-heavy
 * and the photos originate on the shop's own PC. On the local provider every
 * image lands on the Railway volume — one disk, tied to one service, no CDN and
 * no resizing — so a phone on shop wifi downloads full-size camera JPEGs just to
 * draw a grid of thumbnails. Cloudinary serves a resized, format-negotiated
 * variant from an edge instead.
 *
 * Postgres only ever stores the returned URL — never the binary — so switching
 * providers changes nothing else in the app.
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

  private get cloudName(): string {
    return this.config.get<string>('CLOUDINARY_CLOUD_NAME') ?? '';
  }
  private get apiKey(): string {
    return this.config.get<string>('CLOUDINARY_API_KEY') ?? '';
  }
  private get apiSecret(): string {
    return this.config.get<string>('CLOUDINARY_API_SECRET') ?? '';
  }

  /**
   * True when Cloudinary is both selected AND fully configured. Falling back to
   * local on partial config is deliberate: a half-set provider that threw would
   * take down every upload in the app, whereas a local write still succeeds and
   * the misconfiguration shows up in the log.
   */
  get usingCloudinary(): boolean {
    const selected = (this.config.get<string>('STORAGE_PROVIDER') ?? 'local').toLowerCase();
    if (selected !== 'cloudinary') return false;
    const ok = Boolean(this.cloudName && this.apiKey && this.apiSecret);
    if (!ok) {
      this.logger.warn(
        'STORAGE_PROVIDER=cloudinary but CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET are incomplete — falling back to local disk.',
      );
    }
    return ok;
  }

  /**
   * Persist a file buffer and return its public URL.
   *
   * Local provider → `/uploads/<folder>/<filename>`; the frontend prefixes that
   * with NEXT_PUBLIC_API_URL. Cloudinary → an absolute https CDN URL. Callers
   * only ever see a string, so they do not care which one ran.
   */
  async save(folder: string, filename: string, buffer: Buffer): Promise<string> {
    const safeFolder = folder.replace(/[^a-zA-Z0-9._/-]/g, '_');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    if (this.usingCloudinary) {
      try {
        return await this.saveToCloudinary(safeFolder, safeName, buffer);
      } catch (err) {
        // Never lose the upload over a provider outage — write it to disk and say
        // so. A photo on the wrong storage beats a failed intake at the counter.
        this.logger.error(
          `Cloudinary upload failed (${err instanceof Error ? err.message : String(err)}) — storing locally instead.`,
        );
      }
    }

    const dir = join(this.baseDir, safeFolder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeName), buffer);
    const path = `${this.publicPrefix}/${safeFolder}/${safeName}`;
    this.logger.log(`stored ${buffer.length}B -> ${path}`);
    return path;
  }

  /**
   * Signed upload to Cloudinary's REST API as multipart/form-data.
   *
   * Hand-rolled rather than pulling in the `cloudinary` SDK: this is one signed
   * POST, and the signature rule is simply "sort the non-file params, join as
   * k=v&…, append the secret, SHA-1".
   */
  private async saveToCloudinary(
    folder: string,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    // Strip the extension — Cloudinary appends its own based on the format.
    const publicId = filename.replace(/\.[^.]+$/, '');
    const params: Record<string, string> = {
      folder: `eclat/${folder}`,
      overwrite: 'true',
      public_id: publicId,
      timestamp: String(timestamp),
    };
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const signature = createHash('sha1')
      .update(toSign + this.apiSecret)
      .digest('hex');

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)]), filename);
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append('api_key', this.apiKey);
    form.append('signature', signature);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${this.cloudName}/auto/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Cloudinary ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { secure_url?: string };
    if (!json.secure_url) throw new Error('Cloudinary returned no secure_url');
    this.logger.log(`stored ${buffer.length}B -> ${json.secure_url}`);
    return json.secure_url;
  }
}
