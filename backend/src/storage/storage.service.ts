import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'path';
import { Readable } from 'stream';
import { encodeKey, signRequest } from './sigv4';

const ATTENDANCE_MEDIA_MAGIC = Buffer.from('CARATOS_ATTENDANCE_MEDIA', 'ascii');
const ATTENDANCE_MEDIA_VERSION = 1;
const ATTENDANCE_MEDIA_IV_BYTES = 12;
const ATTENDANCE_MEDIA_TAG_BYTES = 16;

/** Does this object start with the versioned attendance-media envelope? */
function isAttendanceEnvelope(buffer: Buffer): boolean {
  return (
    buffer.length >=
      ATTENDANCE_MEDIA_MAGIC.length +
        4 +
        ATTENDANCE_MEDIA_IV_BYTES +
        ATTENDANCE_MEDIA_TAG_BYTES &&
    buffer.subarray(0, ATTENDANCE_MEDIA_MAGIC.length).equals(ATTENDANCE_MEDIA_MAGIC)
  );
}

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
   * Key used only for attendance photographs.
   *
   * The value is deliberately strict: exactly 32 bytes, encoded as either
   * base64 (recommended: `openssl rand -base64 32`) or 64 hexadecimal
   * characters. A typo must not quietly produce a different key and make every
   * existing photograph unreadable.
   */
  private attendanceMediaKey(): Buffer | null {
    const configured = this.config.get<string>('ATTENDANCE_MEDIA_KEY')?.trim();
    if (!configured) return null;

    const raw = configured.replace(/^base64:/i, '');
    let key: Buffer;
    if (/^(?:hex:)?[a-f0-9]{64}$/i.test(configured)) {
      key = Buffer.from(configured.replace(/^hex:/i, ''), 'hex');
    } else if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
      key = Buffer.from(raw, 'base64');
    } else {
      throw new Error(
        'ATTENDANCE_MEDIA_KEY must be exactly 32 bytes encoded as base64 or 64 hexadecimal characters.',
      );
    }
    if (key.length !== 32) {
      throw new Error('ATTENDANCE_MEDIA_KEY must decode to exactly 32 bytes.');
    }
    return key;
  }

  private attendanceAad(organisationId: string, header: Buffer): Buffer {
    return Buffer.concat([
      header,
      Buffer.from(`\u0000caratos:attendance:v1:${organisationId}`, 'utf8'),
    ]);
  }

  /** Encrypt one photo before it reaches local disk, R2 or Cloudinary. */
  private encryptAttendanceMedia(
    organisationId: string,
    filename: string,
    plaintext: Buffer,
    key: Buffer,
  ): Buffer {
    const mime = Buffer.from(this.contentTypeOf(filename), 'utf8');
    if (mime.length > 255) throw new Error('Attendance media type is too long to store safely.');

    const header = Buffer.concat([
      ATTENDANCE_MEDIA_MAGIC,
      Buffer.from([ATTENDANCE_MEDIA_VERSION, mime.length]),
      mime,
    ]);
    const iv = randomBytes(ATTENDANCE_MEDIA_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(this.attendanceAad(organisationId, header));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([header, iv, tag, ciphertext]);
  }

  /** Decrypt the versioned envelope. Authentication failure is a hard refusal. */
  private decryptAttendanceMedia(
    organisationId: string,
    envelope: Buffer,
    key: Buffer,
  ): { buffer: Buffer; contentType: string } {
    const versionAt = ATTENDANCE_MEDIA_MAGIC.length;
    const version = envelope[versionAt];
    if (version !== ATTENDANCE_MEDIA_VERSION) {
      throw new Error(`Unsupported attendance media envelope version ${version}.`);
    }
    const mimeLength = envelope[versionAt + 1];
    const headerEnd = versionAt + 2 + mimeLength;
    const minimum = headerEnd + ATTENDANCE_MEDIA_IV_BYTES + ATTENDANCE_MEDIA_TAG_BYTES + 1;
    if (mimeLength === 0 || envelope.length < minimum) {
      throw new Error('Attendance media envelope is truncated.');
    }
    const header = envelope.subarray(0, headerEnd);
    const contentType = envelope.subarray(versionAt + 2, headerEnd).toString('utf8');
    if (!/^image\/[a-z0-9.+-]+$/i.test(contentType)) {
      throw new Error('Attendance media envelope has an invalid content type.');
    }
    const ivEnd = headerEnd + ATTENDANCE_MEDIA_IV_BYTES;
    const tagEnd = ivEnd + ATTENDANCE_MEDIA_TAG_BYTES;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      envelope.subarray(headerEnd, ivEnd),
    );
    decipher.setAAD(this.attendanceAad(organisationId, header));
    decipher.setAuthTag(envelope.subarray(ivEnd, tagEnd));
    return {
      buffer: Buffer.concat([decipher.update(envelope.subarray(tagEnd)), decipher.final()]),
      contentType,
    };
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
    let safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    let storedBuffer = buffer;

    // Attendance images are uniquely sensitive: encrypt the bytes themselves,
    // so a public R2 URL yields only authenticated ciphertext. This does not
    // change catalogue/return/quote media. Existing plaintext attendance rows
    // remain readable through readAttendanceObject during migration.
    if (folder === 'attendance') {
      const key = this.attendanceMediaKey();
      if (key) {
        storedBuffer = this.encryptAttendanceMedia(organisationId, safeName, buffer, key);
        safeName = `${safeName}.attendance.enc`;
      } else if ((this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'production') {
        // saveCapturedPhoto deliberately lets the punch continue when photo
        // storage fails. Throwing here therefore fails CLOSED for the media: no
        // plaintext object is written, while attendance itself is not lost.
        throw new Error(
          'ATTENDANCE_MEDIA_KEY is required in production before an attendance photo can be stored.',
        );
      } else {
        this.logger.warn(
          'ATTENDANCE_MEDIA_KEY is not configured; writing a plaintext attendance photo outside production.',
        );
      }
    }

    if (this.usingR2) {
      try {
        return await this.saveToR2(safeFolder, safeName, storedBuffer);
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
        return await this.saveToCloudinary(safeFolder, safeName, storedBuffer);
      } catch (err) {
        this.logger.error(
          `Cloudinary upload failed (${err instanceof Error ? err.message : String(err)}) — storing locally instead.`,
        );
      }
    }

    const dir = join(this.baseDir, safeFolder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeName), storedBuffer);
    const path = `${this.publicPrefix}/${safeFolder}/${safeName}`;
    this.logger.log(`stored ${storedBuffer.length}B -> ${path}`);
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

    const target = this.localTarget(storedPath);
    if (!target) return null;
    try {
      return { buffer: await readFile(target), contentType: this.contentTypeOf(target) };
    } catch {
      return null;
    }
  }

  /**
   * Read an attendance photograph after the caller has authorised the database
   * record that points at it.
   *
   * New objects are AES-256-GCM envelopes; existing namespaced plaintext rows
   * remain readable so enabling the key is an online migration rather than a
   * flag day. Ciphertext is never returned when the key is absent, wrong or the
   * object was modified. Ownership is checked here as well as in the HRMS
   * service so this lower-level seam cannot be reused across tenants later.
   */
  async readAttendanceObject(
    organisationId: string,
    storedPath: string | null | undefined,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    if (
      !storedPath ||
      !StorageService.keyBelongsTo(storedPath, organisationId) ||
      !StorageService.keyBelongsToFolder(storedPath, organisationId, 'attendance') ||
      !this.isManagedMedia(storedPath)
    ) {
      return null;
    }
    const object = await this.readObject(storedPath);
    if (!object) return null;
    if (!isAttendanceEnvelope(object.buffer)) {
      // Legacy rows are readable during migration, but this route must never
      // become a way to serve some other tenant-owned document as a punch
      // photo merely because a database field was corrupted or imported.
      return /^image\/[a-z0-9.+-]+$/i.test(object.contentType) ? object : null;
    }

    const key = this.attendanceMediaKey();
    if (!key) {
      this.logger.error(
        'An encrypted attendance photograph cannot be read because ATTENDANCE_MEDIA_KEY is missing.',
      );
      return null;
    }
    try {
      return this.decryptAttendanceMedia(organisationId, object.buffer, key);
    } catch (err) {
      this.logger.error(
        `Attendance photograph authentication failed (${err instanceof Error ? err.message : String(err)}).`,
      );
      return null;
    }
  }

  /** Exposed for a storage-level negative control; it reveals no key material. */
  static isEncryptedAttendanceMedia(buffer: Buffer): boolean {
    return isAttendanceEnvelope(buffer);
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
   * Local disk. The path is server-generated, but it is read back from a
   * database column, so it is treated as untrusted: resolve it and refuse
   * anything that lands outside the upload root. Without this a row carrying
   * `../../etc/passwd` would be a file-read primitive.
   */
  private localTarget(storedPath: string): string | null {
    const relative = storedPath.startsWith(`${this.publicPrefix}/`)
      ? storedPath.slice(this.publicPrefix.length + 1)
      : storedPath.replace(/^\/+/, '');
    const root = normalize(this.baseDir);
    const target = normalize(join(root, relative));
    if (target === root || !target.startsWith(root + sep)) {
      this.logger.error('Refusing to read a stored path that escapes the upload root.');
      return null;
    }
    return target;
  }

  /**
   * Is this stored path one of OUR objects?
   *
   * `Product.imageUrl` is not only written by our own uploads: a website feed
   * can put any URL there. Reading an object on the server's behalf — which a
   * bulk export does thousands of times — must not become a way to make this
   * service fetch arbitrary addresses, so only three shapes qualify: a local
   * `/uploads/` path, or a URL under the configured R2 public base or Cloudinary
   * cloud. The trailing slash in each prefix is what stops
   * `https://pub-x.r2.dev.attacker.example` from passing as ours.
   */
  isManagedMedia(storedPath: string | null | undefined): boolean {
    if (!storedPath) return false;
    if (!/^https?:\/\//i.test(storedPath)) return storedPath.startsWith(`${this.publicPrefix}/`);
    const bases = [
      this.r2.publicBaseUrl ? `${this.r2.publicBaseUrl}/` : '',
      this.cloudName ? `https://res.cloudinary.com/${this.cloudName}/` : '',
    ].filter(Boolean);
    return bases.some((b) => storedPath.startsWith(b));
  }

  /**
   * How big a stored object is, without reading it. Null when it is not there.
   * `size` is null when the host did not say — the caller must then count bytes
   * as they arrive instead of trusting a number it does not have.
   */
  async probeObject(storedPath: string): Promise<{ size: number | null } | null> {
    if (/^https?:\/\//i.test(storedPath)) {
      try {
        // No redirects: a managed URL that answers with one is pointing somewhere else.
        const res = await fetch(storedPath, { method: 'HEAD', redirect: 'error' });
        if (!res.ok) return null;
        const length = Number(res.headers.get('content-length'));
        return { size: Number.isFinite(length) && length >= 0 ? length : null };
      } catch {
        return null;
      }
    }
    const target = this.localTarget(storedPath);
    if (!target) return null;
    try {
      const s = await stat(target);
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  /**
   * A stored object as a stream of chunks, opened only when the first chunk is
   * asked for.
   *
   * An async generator on purpose: nothing is fetched or opened until iteration
   * begins, so a caller can line up thousands of these and only the one being
   * read holds a socket or a file handle.
   */
  async *objectChunks(storedPath: string): AsyncGenerator<Buffer> {
    if (/^https?:\/\//i.test(storedPath)) {
      const res = await fetch(storedPath, { redirect: 'error' });
      if (!res.ok || !res.body) throw new Error(`Object fetch returned ${res.status}.`);
      for await (const chunk of Readable.fromWeb(res.body as never)) yield chunk as Buffer;
      return;
    }
    const target = this.localTarget(storedPath);
    if (!target) throw new Error('Refusing a stored path outside the upload root.');
    for await (const chunk of createReadStream(target)) yield chunk as Buffer;
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

  /** A stricter object-family check used by private media readers. */
  static keyBelongsToFolder(key: string, organisationId: string, folder: string): boolean {
    // A substring test alone lets `org/<id>/attendance/../catalogue/x.png`
    // through, and the storage layer would then resolve it to a catalogue
    // object. No legitimate key has a parent segment, encoded or not.
    if (/(^|[\\/])(\.|%2e){2}([\\/]|$)/i.test(key) || key.includes('\\')) return false;
    const safeFolder = folder.replace(/[^a-zA-Z0-9._-]/g, '_');
    return key.includes(`org/${organisationId}/${safeFolder}/`);
  }

}
