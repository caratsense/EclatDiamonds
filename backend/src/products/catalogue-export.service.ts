import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Availability, JobTask, Prisma, ProductCategory, StockClass } from '@prisma/client';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readdir, readFile, rename, stat, unlink } from 'fs/promises';
import JSZip from 'jszip';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { EmailService } from '../integrations/email.service';
import { JobContext, JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/**
 * Head office takes the catalogue's photographs away in one archive.
 *
 * ── Streamed, never held ────────────────────────────────────────────────────
 *
 * Every photograph is registered with the archive as a stream that opens only
 * when the writer reaches it, and the archive is written straight to disk. JSZip
 * works through its sources one at a time with `streamFiles`, so however many
 * photographs there are, one is being read at any moment and none is buffered
 * whole. STORE, not DEFLATE: a JPEG does not compress, and pretending to costs
 * CPU for nothing.
 *
 * ── Limits refuse; they never trim ───────────────────────────────────────────
 *
 * An archive over the file or byte limit is refused — at the request when the
 * count already says so, in the job when the sizes do — rather than cut short.
 * A ZIP of 2,000 of 2,600 photographs that does not say which 600 are missing is
 * worse than no ZIP. The hard ceilings sit below what a ZIP without ZIP64 can
 * address, which JSZip cannot write.
 *
 * ── Private, and audited both ways ───────────────────────────────────────────
 *
 * The archive lives under `org/<org>/exports/` in the upload root, a folder the
 * public static handler refuses (main.ts). It leaves only through an
 * authenticated head-office route, and who asked for it and who downloaded it
 * are both in the audit trail.
 *
 * ── Photographs we may read ──────────────────────────────────────────────────
 *
 * Only objects in this deployment's own storage. A product whose image URL
 * points anywhere else is listed as skipped, not fetched: a bulk export must not
 * become a way to make the server request arbitrary addresses.
 */

export const CATALOGUE_EXPORT_JOB = 'catalogue.export';

/** Below a ZIP32's 65,535 entries with room to spare. */
const HARD_MAX_FILES = 10_000;
/** Below a ZIP32's 4GiB offset ceiling. JSZip writes no ZIP64. */
const HARD_MAX_BYTES = 3 * 1024 ** 3;
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;

/** Most mail servers refuse far below this; 10MB is where attaching stops being polite. */
const EMAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const PROBE_CONCURRENCY = 8;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff']);
const ON_HAND = ['in_stock', 'aging', 'dead_stock', 'reserved'] as const;

export interface CatalogueExportFilters {
  storeId?: string;
  category?: ProductCategory;
  /** Style Number or SKU, contains, case-insensitive. */
  code?: string;
  /** Product last updated on or after this UTC day (YYYY-MM-DD). */
  updatedFrom?: string;
  /** ...and on or before this one. */
  updatedTo?: string;
  availability?: Availability;
  stockClass?: StockClass;
}

interface ExportPayload {
  filters: CatalogueExportFilters;
  requestedBy: { id: string; name: string };
  /** The address is looked up when the mail is sent, not copied into the queue. */
  emailMe: boolean;
}

export type SkipReason = 'external' | 'not_authorised' | 'missing';

interface SkippedPhoto {
  sku: string;
  productName: string;
  reason: SkipReason;
  detail: string;
}

interface ExportResult {
  /** File name inside the tenant's private export folder. */
  archive: string;
  /** What the download is saved as. */
  filename: string;
  files: number;
  bytes: number;
  skippedCount: number;
  skipped: SkippedPhoto[];
  expiresAt: string;
  email: { status: string; detail: string } | null;
}

const SKIP_DETAIL: Record<SkipReason, string> = {
  external: 'The photograph is hosted outside this workspace’s storage, so it was not fetched.',
  not_authorised: 'The stored photograph belongs to another workspace.',
  missing: 'The product names a photograph that is not in storage.',
};

@Injectable()
export class CatalogueExportService implements OnModuleInit {
  private readonly log = new Logger(CatalogueExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.jobs.register(CATALOGUE_EXPORT_JOB, (payload, ctx) => this.build(payload as ExportPayload, ctx));
  }

  /** Env-tunable for a deployment's disk and patience; never past the format's ceilings. */
  get limits(): { maxFiles: number; maxBytes: number } {
    const read = (key: string, fallback: number, hard: number) => {
      const v = Number(this.config.get<string>(key));
      return Number.isInteger(v) && v > 0 ? Math.min(v, hard) : fallback;
    };
    return {
      maxFiles: read('CATALOGUE_EXPORT_MAX_FILES', DEFAULT_MAX_FILES, HARD_MAX_FILES),
      maxBytes: read('CATALOGUE_EXPORT_MAX_BYTES', DEFAULT_MAX_BYTES, HARD_MAX_BYTES),
    };
  }

  // ==========================================================================
  // Request, status, download
  // ==========================================================================

  async create(user: AuthUser, input: CatalogueExportFilters & { emailMe?: boolean }) {
    const filters = normaliseFilters(input);
    if (filters.storeId) this.scope.assertStoreAllowed(user, filters.storeId);

    const matching = await this.prisma.product.count({
      where: whereFor(user.organisationId, filters),
    });
    if (matching === 0) {
      throw new BadRequestException('No product with a photograph matches these filters.');
    }
    const { maxFiles } = this.limits;
    if (matching > maxFiles) {
      throw new BadRequestException(
        `${matching} products with photographs match, and one archive holds at most ${maxFiles}. Narrow the filters and export in parts.`,
      );
    }

    const payload: ExportPayload = {
      filters,
      requestedBy: { id: user.id, name: user.name },
      emailMe: Boolean(input.emailMe),
    };
    // Always the queue, however small: one path to reason about, and a request
    // that returns at once rather than holding a connection open while
    // thousands of photographs are read. maxAttempts 1 — a limit breach fails
    // the same way every time, and a retry would only repeat the work.
    const job = await this.jobs.enqueue({
      kind: CATALOGUE_EXPORT_JOB,
      organisationId: user.organisationId,
      createdById: user.id,
      maxAttempts: 1,
      payload: payload as unknown as Prisma.InputJsonValue,
    });

    await this.audit.record(user, {
      action: 'catalogue.export_requested',
      entityType: 'JobTask',
      entityId: job.id,
      storeId: filters.storeId ?? null,
      summary: `Requested a photo archive of ${matching} catalogue product(s)`,
      metadata: { filters, matching, emailMe: payload.emailMe },
    });
    return this.get(user, job.id);
  }

  async list(user: AuthUser) {
    const rows = await this.prisma.jobTask.findMany({
      where: { organisationId: user.organisationId, kind: CATALOGUE_EXPORT_JOB },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map((j) => toView(j, false));
  }

  async get(user: AuthUser, id: string) {
    return toView(await this.find(user, id), true);
  }

  async download(user: AuthUser, id: string) {
    const job = await this.find(user, id);
    if (job.status !== 'succeeded' || !job.result) {
      throw new ConflictException('That archive is not ready. Check its status first.');
    }
    const result = job.result as unknown as ExportResult;
    // Server-written, but read back from a column: only a bare file name is
    // ever joined to the export folder.
    if (!/^[a-z0-9]+\.zip$/i.test(result.archive)) throw new NotFoundException('Export not found');
    if (Date.parse(result.expiresAt) < Date.now()) {
      throw new GoneException('That archive has expired. Generate it again.');
    }
    const path = join(this.exportDir(user.organisationId), result.archive);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new GoneException('That archive is no longer on the server. Generate it again.');
    }

    await this.audit.record(user, {
      action: 'catalogue.export_downloaded',
      entityType: 'JobTask',
      entityId: job.id,
      summary: `Downloaded ${result.filename} (${result.files} photograph(s))`,
      metadata: {
        files: result.files,
        bytes: size,
        requestedById: (job.payload as unknown as ExportPayload).requestedBy?.id ?? null,
      },
    });
    return { stream: createReadStream(path), size, filename: result.filename };
  }

  /** Another tenant's export, or anything that is not an export, is simply not found. */
  private async find(user: AuthUser, id: string): Promise<JobTask> {
    const job = await this.prisma.jobTask.findFirst({
      where: { id, organisationId: user.organisationId, kind: CATALOGUE_EXPORT_JOB },
    });
    if (!job) throw new NotFoundException('Export not found');
    return job;
  }

  private exportDir(organisationId: string): string {
    // Under the upload root so it lands on the same persistent volume, in a
    // folder main.ts refuses to serve publicly.
    return join(this.storage.baseDir, 'org', organisationId.replace(/[^a-zA-Z0-9._-]/g, '_'), 'exports');
  }

  // ==========================================================================
  // The job
  // ==========================================================================

  private async build(payload: ExportPayload, ctx: JobContext): Promise<ExportResult> {
    const org = ctx.organisationId;
    if (!org) throw new Error('A catalogue export must belong to an organisation.');
    const { maxFiles, maxBytes } = this.limits;
    const filters = payload.filters ?? {};

    const products = await this.prisma.product.findMany({
      where: whereFor(org, filters),
      orderBy: [{ sku: 'asc' }, { id: 'asc' }],
      take: maxFiles + 1,
      select: {
        id: true, sku: true, name: true, styleNumber: true, imageUrl: true,
        // The piece numbers for this design, where pieces have them — scoped to
        // the branch the export was narrowed to.
        stockItems: {
          where: {
            vin: { not: null },
            status: { in: [...ON_HAND] },
            ...(filters.storeId ? { storeId: filters.storeId } : {}),
          },
          orderBy: { vin: 'asc' },
          select: { vin: true },
        },
      },
    });
    // The count was checked when this was requested; the catalogue can have
    // grown since. Refused, not trimmed.
    if (products.length > maxFiles) {
      throw new Error(
        `More than ${maxFiles} products now match, and one archive holds at most ${maxFiles}. Nothing was written. Narrow the filters and export again.`,
      );
    }

    const checked = await mapPool(products, PROBE_CONCURRENCY, async (p) => {
      const url = p.imageUrl ?? '';
      if (!this.storage.isManagedMedia(url)) return { p, url, reason: 'external' as SkipReason };
      const owner = /(?:^|\/)org\/([^/]+)\//.exec(url)?.[1];
      if (owner && owner !== org) return { p, url, reason: 'not_authorised' as SkipReason };
      const probe = await this.storage.probeObject(url);
      return probe ? { p, url, size: probe.size } : { p, url, reason: 'missing' as SkipReason };
    });

    const declared = checked.reduce((sum, c) => sum + ('size' in c ? (c.size ?? 0) : 0), 0);
    if (declared > maxBytes) {
      throw new Error(
        `The photographs come to ${size(declared)}, and one archive holds at most ${size(maxBytes)}. Nothing was written. Narrow the filters and export in parts.`,
      );
    }

    const taken = new Set<string>(['manifest.csv']);
    const manifest: string[][] = [
      ['file', 'sku', 'style_number', 'vin', 'product_name', 'status', 'reason'],
    ];
    const included: { url: string; entry: string }[] = [];
    const skipped: SkippedPhoto[] = [];

    for (const c of checked) {
      const vins = c.p.stockItems.map((s) => s.vin).join('; ');
      if ('reason' in c && c.reason) {
        skipped.push({ sku: c.p.sku, productName: c.p.name, reason: c.reason, detail: SKIP_DETAIL[c.reason] });
        manifest.push(['', c.p.sku, c.p.styleNumber ?? '', vins, c.p.name, 'skipped', SKIP_DETAIL[c.reason]]);
        continue;
      }
      const entry = `photos/${safeEntryName(c.p.sku, extensionOf(c.url), taken)}`;
      included.push({ url: c.url, entry });
      manifest.push([entry, c.p.sku, c.p.styleNumber ?? '', vins, c.p.name, 'included', '']);
    }

    const dir = this.exportDir(org);
    await mkdir(dir, { recursive: true });
    await this.prune(dir);
    const final = join(dir, `${ctx.jobId}.zip`);
    const partial = `${final}.partial`;

    const zip = new JSZip();
    // A byte-order mark so a spreadsheet opens the names as UTF-8.
    zip.file('manifest.csv', `\uFEFF${manifest.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);

    const storage = this.storage;
    let streamed = 0;
    for (const item of included) {
      // The limit again, on bytes actually read: a host that did not declare a
      // size, or declared the wrong one, cannot push the archive past it.
      const counted = async function* () {
        for await (const chunk of storage.objectChunks(item.url)) {
          streamed += chunk.length;
          if (streamed > maxBytes) {
            throw new Error(
              `The photographs passed ${size(maxBytes)} while being read, over the limit for one archive. Nothing was kept. Narrow the filters.`,
            );
          }
          yield chunk;
        }
      };
      zip.file(item.entry, Readable.from(counted(), { objectMode: false }), { binary: true });
    }

    try {
      await pipeline(
        zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' }),
        createWriteStream(partial),
      );
      await rename(partial, final);
    } catch (err) {
      // A half-written archive is not a smaller archive. It goes.
      await unlink(partial).catch(() => undefined);
      throw err;
    }

    const bytes = (await stat(final)).size;
    const expiresAt = new Date(Date.now() + RETENTION_DAYS * DAY_MS);
    const filename = `catalogue-photos-${new Date().toISOString().slice(0, 10)}.zip`;
    const email = payload.emailMe
      ? await this.deliver(org, payload, final, filename, bytes, included.length, skipped.length, expiresAt)
      : null;

    this.log.log(
      `Catalogue export ${ctx.jobId}: ${included.length} photograph(s), ${skipped.length} skipped, ${size(bytes)}`,
    );
    return {
      archive: `${ctx.jobId}.zip`,
      filename,
      files: included.length,
      bytes,
      skippedCount: skipped.length,
      skipped,
      expiresAt: expiresAt.toISOString(),
      email,
    };
  }

  /**
   * Mail it to the person who asked, never to an address typed into a form.
   *
   * Attached when it is small enough to be polite; otherwise the mail says where
   * to download it. Not configured is reported as not sent — the archive is
   * still there, and the screen must not claim a delivery that did not happen.
   */
  private async deliver(
    org: string,
    payload: ExportPayload,
    path: string,
    filename: string,
    bytes: number,
    files: number,
    skippedCount: number,
    expiresAt: Date,
  ): Promise<{ status: string; detail: string }> {
    if (!this.email.enabled) {
      return {
        status: 'dry_run',
        detail: 'Email is not configured on this server, so nothing was sent. Download the archive here.',
      };
    }
    const requester = await this.prisma.user.findFirst({
      where: { id: payload.requestedBy.id, organisationId: org },
      select: { email: true },
    });
    if (!requester?.email) {
      return { status: 'no_recipient', detail: 'The person who asked has no email address on file.' };
    }

    const attach = bytes <= EMAIL_ATTACHMENT_MAX_BYTES;
    const body = [
      `Your catalogue photo archive is ready: ${files} photograph(s)${
        skippedCount ? `, ${skippedCount} skipped (listed in manifest.csv)` : ''
      }.`,
      '',
      attach
        ? 'It is attached.'
        : `At ${size(bytes)} it is too large to attach. Sign in and open Data → Product photographs to download it.`,
      `It can be downloaded until ${expiresAt.toISOString().slice(0, 10)}.`,
      '',
      'Generated by CaratSense.',
    ].join('\n');

    const res = await this.email.send(
      requester.email,
      'Catalogue photo archive',
      body,
      attach ? [{ filename, content: await readFile(path), contentType: 'application/zip' }] : undefined,
    );
    if (res.dryRun) {
      return { status: 'dry_run', detail: 'Email is not configured on this server, so nothing was sent.' };
    }
    if (!res.sent) return { status: 'failed', detail: res.error ?? 'The mail server refused it.' };
    return attach
      ? { status: 'sent', detail: 'Sent with the archive attached.' }
      : {
          status: 'sent_without_attachment',
          detail: `Too large to attach (${size(bytes)}, limit ${size(EMAIL_ATTACHMENT_MAX_BYTES)}), so the email says where to download it.`,
        };
  }

  /** Archives past retention, and anything half-written by a crashed run, are removed. */
  private async prune(dir: string) {
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, name);
      const s = await stat(path).catch(() => null);
      if (s?.isFile() && s.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
    }
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function toView(job: JobTask, detail: boolean) {
  const payload = (job.payload ?? {}) as unknown as ExportPayload;
  const result = (job.result ?? null) as unknown as ExportResult | null;
  const status =
    job.status === 'succeeded'
      ? 'completed'
      : job.status === 'dead' || job.status === 'failed'
        ? 'failed'
        : 'pending';
  return {
    id: job.id,
    status,
    /** Within `pending`: a worker has it. */
    running: job.status === 'running',
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    requestedBy: payload.requestedBy ?? null,
    filters: payload.filters ?? {},
    emailRequested: Boolean(payload.emailMe),
    error: status === 'failed' ? job.lastError : null,
    archive:
      status === 'completed' && result
        ? {
            filename: result.filename,
            files: result.files,
            bytes: result.bytes,
            skippedCount: result.skippedCount,
            expiresAt: result.expiresAt,
            expired: Date.parse(result.expiresAt) < Date.now(),
          }
        : null,
    email: result?.email ?? null,
    ...(detail ? { skipped: result?.skipped ?? [] } : {}),
  };
}

function normaliseFilters(input: CatalogueExportFilters): CatalogueExportFilters {
  const out: CatalogueExportFilters = {};
  if (input.storeId) out.storeId = input.storeId;
  if (input.category) out.category = input.category;
  if (input.code?.trim()) out.code = input.code.trim();
  if (input.updatedFrom) out.updatedFrom = input.updatedFrom;
  if (input.updatedTo) out.updatedTo = input.updatedTo;
  if (input.availability) out.availability = input.availability;
  if (input.stockClass) out.stockClass = input.stockClass;
  if (out.updatedFrom && out.updatedTo && out.updatedFrom > out.updatedTo) {
    throw new BadRequestException('The "updated from" date is after the "updated to" date.');
  }
  return out;
}

/** Products with a photograph that match the filters, inside one organisation. */
function whereFor(organisationId: string, f: CatalogueExportFilters): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [
    { organisationId },
    { imageUrl: { not: null } },
    { NOT: { imageUrl: '' } },
  ];
  if (f.storeId) {
    // A design belongs to a branch either by being catalogued there or by
    // having pieces there — most synced designs are the second kind.
    and.push({ OR: [{ storeId: f.storeId }, { stockItems: { some: { storeId: f.storeId } } }] });
  }
  if (f.category) and.push({ category: f.category });
  if (f.code) {
    and.push({
      OR: [
        { sku: { contains: f.code, mode: 'insensitive' } },
        { styleNumber: { contains: f.code, mode: 'insensitive' } },
      ],
    });
  }
  if (f.updatedFrom || f.updatedTo) {
    and.push({
      updatedAt: {
        ...(f.updatedFrom ? { gte: new Date(`${f.updatedFrom}T00:00:00.000Z`) } : {}),
        // Inclusive of the whole "to" day.
        ...(f.updatedTo ? { lt: new Date(Date.parse(`${f.updatedTo}T00:00:00.000Z`) + DAY_MS) } : {}),
      },
    });
  }
  if (f.availability) and.push({ availability: f.availability });
  if (f.stockClass) and.push({ stockClass: f.stockClass });
  return { AND: and };
}

/**
 * A name that is safe to write as an archive entry on any operating system.
 *
 * The SKU is somebody else's text. `../../etc/x`, `C:\evil`, `/abs` and `CON`
 * are all things a supplier's code column can contain, and an unzip tool that
 * honours them writes outside the folder the person chose. So separators, drive
 * colons and the characters Windows refuses become `_`, runs of dots collapse,
 * leading and trailing dots and spaces go, reserved device names are prefixed —
 * and a name already used (compared case-insensitively, as Windows and macOS
 * would) gets a `-2`, `-3`, rather than overwriting the first on extraction.
 */
export function safeEntryName(stem: string, ext: string, taken: Set<string>): string {
  let base = String(stem ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100);
  if (!base) base = 'photo';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`;
  const suffix = ext ? `.${ext}` : '';
  let name = `${base}${suffix}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}${suffix}`;
  taken.add(name.toLowerCase());
  return name;
}

/** The extension off the stored path, only when it is an image one. */
function extensionOf(url: string): string {
  const path = url.split(/[?#]/)[0];
  const ext = /\.([a-z0-9]{2,5})$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext) ? ext : '';
}

/**
 * One CSV cell. A value starting with = + - @ is prefixed with a quote so a
 * spreadsheet shows it as text instead of running it as a formula — a product
 * name is somebody else's text too.
 */
function csvCell(value: string): string {
  const s = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${bytes} bytes`
    : `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}
