import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'path';
import { encodeKey, signRequest } from './sigv4';

/**
 * Object/file storage for jewellery images + return photos.
 *
 * Three providers, chosen by `STORAGE_PROVIDER`:
 *
 *  - `local` (default) — disk under `UPLOAD_DIR`, served at `/uploads`. No account
 *    needed; right for dev and a single small server.
 *  - `r2` — Cloudflare R2. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
 *    `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`.
 *  - `cloudinary` — set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
 *    `CLOUDINARY_API_SECRET`.
 *
 * Why the provider matters for THIS product: the catalogue is photograph-heavy
 * and the photos originate on the shop's own PC. On the local provider every
 * image lands on the Railway volume — one disk, tied to one service, no CDN — so
 * a phone on shop wifi downloads full-size camera JPEGs just to draw a grid of
 * thumbnails. R2 and Cloudinary both serve from an edge instead.
 *
 * R2 vs Cloudinary, since both are wired up: R2 is plain object storage behind
 * Cloudflare's CDN with **zero egress fees**, which is the deciding factor for a
 * catalogue browsed all day across stores. What it does not do is transform
 * images — there is no "give me a 300px webp" URL parameter unless Cloudflare
 * Images is enabled separately, so the bytes uploaded are the bytes served.
 * Uploading a sensible size therefore matters more on R2 than it did on
 * Cloudinary.
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

  private get selectedProvider(): string {
    return (this.config.get<string>('STORAGE_PROVIDER') ?? 'local').toLowerCase();
  }

  /**
   * True when Cloudinary is both selected AND fully configured. Falling back to
   * local on partial config is deliberate: a half-set provider that threw would
   * take down every upload in the app, whereas a local write still succeeds and
   * the misconfiguration shows up in the log.
   */
  get usingCloudinary(): boolean {
    if (this.selectedProvider !== 'cloudinary') return false;
    const ok = Boolean(this.cloudName && this.apiKey && this.apiSecret);
    if (!ok) {
      this.logger.warn(
        'STORAGE_PROVIDER=cloudinary but CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET are incomplete — falling back to local disk.',
      );
    }
    return ok;
  }

  private get r2(): {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl: string;
    endpoint: string;
  } {
    const accountId = this.config.get<string>('R2_ACCOUNT_ID') ?? '';
    return {
      accountId,
      accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID') ?? '',
      secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY') ?? '',
      bucket: this.config.get<string>('R2_BUCKET') ?? '',
      publicBaseUrl: (this.config.get<string>('R2_PUBLIC_BASE_URL') ?? '').replace(/\/+$/, ''),
      // Optional override for R2's jurisdiction-specific hosts (e.g. the EU
      // endpoint `<account>.eu.r2.cloudflarestorage.com`), and for pointing at a
      // local S3 stand-in under test.
      endpoint: (
        this.config.get<string>('R2_ENDPOINT') ??
        `https://${accountId}.r2.cloudflarestorage.com`
      ).replace(/\/+$/, ''),
    };
  }

  /**
   * True when R2 is selected AND fully configured — same fall-back-to-local
   * reasoning as Cloudinary above.
   *
   * `R2_PUBLIC_BASE_URL` is required rather than derived because an R2 bucket is
   * private by default and its public address is a separate decision: either the
   * generated `https://pub-<hash>.r2.dev` dev domain or a custom domain. There is
   * no way to compute it from the account id, and guessing would store URLs that
   * 404 for every customer.
   */
  get usingR2(): boolean {
    if (this.selectedProvider !== 'r2') return false;
    const { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl } = this.r2;
    const ok = Boolean(accountId && accessKeyId && secretAccessKey && bucket && publicBaseUrl);
    if (!ok) {
      this.logger.warn(
        'STORAGE_PROVIDER=r2 but R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / ' +
          'R2_BUCKET / R2_PUBLIC_BASE_URL are incomplete — falling back to local disk.',
      );
    }
    return ok;
  }

  /**
   * Persist a file buffer and return its public URL.
   *
   * Local provider → `/uploads/org/<org>/<folder>/<filename>`; the frontend
   * prefixes that with NEXT_PUBLIC_API_URL. Cloudinary → an absolute https CDN
   * URL. Callers only ever see a string, so they do not care which one ran.
   *
   * `organisationId` (from the authenticated user, never the request) namespaces
   * every NEW key as `org/<organisationId>/<folder>/<filename>` so one tenant
   * cannot guess or collide with another's objects. It is required, not
   * defaulted: a missing org is a bug at the call site, not something to paper
   * over with a shared bucket path. Backward compatibility is free — existing
   * rows keep their old (un-prefixed) URLs and we never rewrite them; only new
   * writes get the prefix.
   */
  async save(
    organisationId: string,
    folder: string,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    if (!organisationId) {
      throw new Error('StorageService.save requires an organisationId to namespace the object key');
    }
    const safeFolder = `org/${organisationId}/${folder}`.replace(/[^a-zA-Z0-9._/-]/g, '_');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    if (this.usingR2) {
      try {
        return await this.saveToR2(safeFolder, safeName, buffer);
      } catch (err) {
        // Never lose the upload over a provider outage — write it to disk and say
        // so. A photo on the wrong storage beats a failed intake at the counter.
        this.logger.error(
          `R2 upload failed (${err instanceof Error ? err.message : String(err)}) — storing locally instead.`,
        );
      }
    }

    if (this.usingCloudinary) {
      try {
        return await this.saveToCloudinary(safeFolder, safeName, buffer);
      } catch (err) {
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

  /** Content-Type from the filename. R2 stores whatever we declare and serves it
   *  back verbatim, so getting this wrong makes browsers download the file
   *  instead of rendering it. */
  private contentTypeOf(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const types: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      tif: 'image/tiff',
      tiff: 'image/tiff',
      svg: 'image/svg+xml',
      pdf: 'application/pdf',
    };
    return types[ext] ?? 'application/octet-stream';
  }

  /**
   * PUT the object to R2 over its S3-compatible API, then return the public URL.
   *
   * A single signed PUT rather than the AWS SDK — see `sigv4.ts` for why, and for
   * the botocore-verified signer this depends on.
   *
   * `Cache-Control: immutable` is safe because the key embeds the record id and
   * we overwrite in place only when the record's image genuinely changes; the
   * catalogue is read constantly and re-uploaded rarely.
   */
  private async saveToR2(folder: string, filename: string, buffer: Buffer): Promise<string> {
    const { accessKeyId, secretAccessKey, bucket, publicBaseUrl, endpoint } = this.r2;
    const key = `${folder}/${filename}`;
    const url = `${endpoint}/${bucket}/${encodeKey(key)}`;
    const contentType = this.contentTypeOf(filename);

    const headers = signRequest({
      method: 'PUT',
      url,
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=31536000, immutable',
      },
      payload: buffer,
      accessKeyId,
      secretAccessKey,
      region: 'auto',
      service: 's3',
    });

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      throw new Error(`R2 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const publicUrl = `${publicBaseUrl}/${encodeKey(key)}`;
    this.logger.log(`stored ${buffer.length}B -> ${publicUrl}`);
    return publicUrl;
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

  /* -------------------------------------------- media access (Phase B2) */

  /**
   * The read seam for stored media.
   *
   * ## Honest current behaviour
   *
   * This returns the object's PUBLIC URL. R2 is configured for public read, so
   * an object URL is a bearer capability: anyone holding the link can fetch it
   * with no tenant check. Keys are namespaced `org/{organisationId}/…`, so one
   * tenant cannot GUESS another's objects — but segregation is not
   * authorisation, and this method does not pretend otherwise.
   *
   * ## Why it exists before it does anything
   *
   * Every read path now calls one function instead of interpolating a base URL,
   * so making media private later is a change to THIS method plus a credential,
   * rather than an archaeology exercise across two applications. The seam is the
   * deliverable; the signing is not, and is explicitly not claimed.
   *
   * ## What making it private actually requires
   *
   *   1. Turn off public read on the bucket.
   *   2. Sign here, with a short expiry, after checking the caller's
   *      organisation against the `org/{id}/` prefix in the key.
   *   3. Migrate URLs already persisted in `Product.imageUrl`, `ReturnPhoto`,
   *      `QuotePhoto` and the order-receipt columns — they are absolute today.
   *   4. Stop the frontend caching them indefinitely; a signed URL expires and a
   *      cached one becomes a broken image.
   *   5. Re-check the AI image-search result set, which returns image URLs in
   *      bulk and would otherwise sign hundreds per request.
   *
   * Steps 3-5 are why this was not done in the hardening pass: a half-migrated
   * media path is worse than an honest public one, because nobody can tell which
   * objects are protected. Tracked in docs/OPERATIONS.md.
   */
  mediaUrl(storedPath: string | null | undefined): string | null {
    if (!storedPath) return null;
    if (/^https?:\/\//.test(storedPath)) return storedPath;
    return storedPath.startsWith('/') ? storedPath : `/${storedPath}`;
  }

  /**
   * Read one stored object back as bytes.
   *
   * The other half of the seam `mediaUrl` describes. Callers that must not hand
   * out a public URL — the attendance and counter photos — go through this and
   * serve the bytes themselves after checking who is asking.
   *
   * `storedPath` is whatever `save` returned: a `/uploads/...` path on the local
   * provider, an absolute URL on R2 or Cloudinary. Null is returned rather than
   * thrown for anything unreadable, because the caller is answering a request
   * and a missing photo is a 404, not a server fault.
   */
  async readObject(
    storedPath: string | null | undefined,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    if (!storedPath) return null;

    if (/^https?:\/\//.test(storedPath)) {
      try {
        const res = await fetch(storedPath);
        if (!res.ok) {
          this.logger.warn(`Object fetch returned ${res.status} for a stored media URL.`);
          return null;
        }
        return {
          buffer: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? this.contentTypeOf(storedPath),
        };
      } catch (err) {
        this.logger.error(
          `Object fetch failed (${err instanceof Error ? err.message : String(err)}).`,
        );
        return null;
      }
    }

    // Local disk. The path is server-generated, but it is read back from a
    // database column, so it is treated as untrusted: resolve it and refuse
    // anything that lands outside the upload root. Without this a row carrying
    // `../../etc/passwd` would be a file-read primitive.
    const relative = storedPath.startsWith(`${this.publicPrefix}/`)
      ? storedPath.slice(this.publicPrefix.length + 1)
      : storedPath.replace(/^\/+/, '');
    const root = normalize(this.baseDir);
    const target = normalize(join(root, relative));
    if (target !== root && !target.startsWith(root + sep)) {
      this.logger.error('Refusing to read a stored path that escapes the upload root.');
      return null;
    }

    try {
      return { buffer: await readFile(target), contentType: this.contentTypeOf(target) };
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------ private documents */

  /**
   * Root for documents that must never have a public address.
   *
   * Deliberately NOT under `baseDir`: main.ts mounts `baseDir` at `/uploads`
   * for anyone holding a path, and a customer's priced quote is not a catalogue
   * image. Nor does this go to R2 — that bucket is public-read in this
   * deployment (see `mediaUrl`), so an object there has a permanent public URL
   * whether or not we hand it out. Bytes stored here leave the server only
   * through an authorised route, or as an upload straight to a provider.
   *
   * ponytail: server-local disk. Fine for one backend instance, and every
   * document stored here today is regenerable from its database record. Add a
   * private bucket (signed PUT/GET, as KnowledgeStorageService does) when there
   * is more than one instance or the disk does not survive deploys.
   */
  get privateDir(): string {
    const configured = this.config.get<string>('PRIVATE_UPLOAD_DIR');
    if (configured) return isAbsolute(configured) ? configured : join(process.cwd(), configured);
    return join(process.cwd(), 'uploads-private', 'documents');
  }

  /** Store a private document. Returns its key, never a URL. */
  async savePrivate(
    organisationId: string,
    folder: string,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    if (!organisationId) {
      throw new Error('StorageService.savePrivate requires an organisationId to namespace the key');
    }
    const key = `org/${organisationId}/${folder}/${filename}`.replace(/[^a-zA-Z0-9._/-]/g, '_');
    const target = this.privatePath(key);
    if (!target) {
      throw new Error('Refusing to store a private document outside a private, non-public root.');
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);
    return key;
  }

  /**
   * Read a private document back, for its own organisation only. Null for a key
   * that belongs to another tenant, escapes the root, or no longer exists.
   */
  async readPrivate(organisationId: string, key: string): Promise<Buffer | null> {
    if (!organisationId || !key.startsWith(`org/${organisationId}/`)) return null;
    const target = this.privatePath(key);
    if (!target) return null;
    try {
      return await readFile(target);
    } catch {
      return null;
    }
  }

  private privatePath(key: string): string | null {
    const root = normalize(this.privateDir);
    // A private root inside the public one would be served at /uploads to
    // anyone with the path — refuse to use it rather than store in the open.
    const publicRoot = normalize(this.baseDir);
    if (root === publicRoot || root.startsWith(publicRoot + sep)) {
      this.logger.error('PRIVATE_UPLOAD_DIR is inside UPLOAD_DIR, which is served publicly; refusing it.');
      return null;
    }
    const target = normalize(join(root, key));
    return target.startsWith(root + sep) ? target : null;
  }

  /**
   * Does this object key belong to the given organisation?
   *
   * The check a signed-URL implementation will need, available now so the rule
   * has one definition rather than being re-derived at each call site when the
   * migration happens. Objects written before key namespacing carry no prefix
   * and return false — they are legacy and must be treated as unattributed
   * rather than silently granted to whoever asks.
   */
  static keyBelongsTo(key: string, organisationId: string): boolean {
    return key.includes(`org/${organisationId}/`);
  }

}
