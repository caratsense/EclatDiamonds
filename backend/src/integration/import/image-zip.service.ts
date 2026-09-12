import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import JSZip from 'jszip';

import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { StoreScopeService } from '../../common/store-scope.service';

/**
 * A folder of product photographs, matched to the catalogue by filename.
 *
 * The supplier sends a spreadsheet and a folder of images named after the design
 * code. The spreadsheet half has been importable for a while; the images were
 * uploaded one at a time, which for a few thousand designs is not a workflow.
 *
 * ── Matching is declared, never guessed ──────────────────────────────────────
 *
 * `matchBy` says which product field the filename is: the SKU, the source
 * system's own id, or the product name. Nothing here tries each in turn until
 * something hits — a filename that matches a SKU under one rule and a name under
 * another would attach a photograph to the wrong ring, and the person who
 * uploaded it would have no way to see that it happened.
 *
 * ── Nothing is written until somebody has seen the preview ───────────────────
 *
 * `preview` reads the archive and reports every entry's fate — matched,
 * unmatched, ambiguous, not an image, too large — without touching storage or
 * the catalogue. `run` does the same work and then uploads. Unmatched entries
 * are REPORTED, never dropped quietly: "1,412 of 1,500 uploaded" with no list of
 * the other 88 is a number nobody can act on.
 */

/** One archive. Beyond this the upload is refused rather than half-processed. */
export const MAX_ZIP_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5_000;
/** One image. A 12MB product photograph is a mistake, not a requirement. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * Total decompressed bytes across the archive.
 *
 * The zip-bomb guard: entry sizes are read from the archive's own metadata,
 * which a crafted file can understate, so the running total of what has ACTUALLY
 * been decompressed is checked as well.
 */
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff']);

export type MatchBy = 'sku' | 'legacyId' | 'name';
export const MATCH_BY: MatchBy[] = ['sku', 'legacyId', 'name'];

export interface ImageZipOptions {
  /** Which product field the filename is. Declared, never inferred. */
  matchBy: MatchBy;
  /** Trimmed from the start of the filename stem before matching, if present. */
  stripPrefix?: string;
  /** Trimmed from the end of the stem, e.g. the "_main" a DAM export appends. */
  stripSuffix?: string;
  /**
   * Treat `RING-101-2.jpg` as a second photo of `RING-101` rather than as a
   * different product. Off by default: a tenant whose codes genuinely end in
   * `-2` would otherwise have every one of them silently merged.
   */
  stripNumericSuffix?: boolean;
  /** Only touch products in this branch. Narrows; never widens. */
  storeId?: string;
  /**
   * Replace an image a product already has. Off by default — an import that
   * overwrites curated photography with a supplier's catalogue shot is the kind
   * of thing discovered a week later.
   */
  overwriteExisting?: boolean;
}

export interface ImageZipEntryResult {
  filename: string;
  /** The key actually matched on, after stripping. */
  key: string;
  status:
    | 'matched'
    | 'uploaded'
    | 'unmatched'
    | 'ambiguous'
    | 'skipped_has_image'
    | 'not_an_image'
    | 'too_large'
    | 'failed';
  productId?: string;
  productSku?: string;
  detail?: string;
}

export interface ImageZipOutcome {
  entries: number;
  matched: number;
  uploaded: number;
  unmatched: number;
  ambiguous: number;
  skipped: number;
  ignored: number;
  failed: number;
  /** Every entry, so an unmatched file is a name somebody can look up. */
  results: ImageZipEntryResult[];
  batchId?: string;
}

@Injectable()
export class ImageZipService {
  private readonly log = new Logger(ImageZipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  preview(user: AuthUser, file: { buffer?: Buffer }, opts: ImageZipOptions) {
    return this.process(user, file, opts, false);
  }

  run(user: AuthUser, file: { buffer?: Buffer }, opts: ImageZipOptions) {
    return this.process(user, file, opts, true);
  }

  private async process(
    user: AuthUser,
    file: { buffer?: Buffer },
    opts: ImageZipOptions,
    commit: boolean,
  ): Promise<ImageZipOutcome> {
    if (!file?.buffer?.length) throw new BadRequestException('Attach a ZIP of images.');
    if (file.buffer.length > MAX_ZIP_BYTES) {
      throw new BadRequestException(
        `That archive is ${mb(file.buffer.length)}MB, over the ${mb(MAX_ZIP_BYTES)}MB limit. Split it.`,
      );
    }
    if (!MATCH_BY.includes(opts.matchBy)) {
      throw new BadRequestException(`matchBy must be one of: ${MATCH_BY.join(', ')}.`);
    }
    if (opts.storeId) this.scope.assertStoreAllowed(user, opts.storeId);

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(file.buffer);
    } catch {
      throw new BadRequestException('That file is not a readable ZIP archive.');
    }

    // Directory entries and the junk a Mac puts in every archive are not files
    // anybody meant to upload, and counting them as "ignored" would make the
    // summary read as though something went wrong.
    const files = Object.values(zip.files).filter(
      (f) => !f.dir && !f.name.startsWith('__MACOSX/') && !baseName(f.name).startsWith('.'),
    );
    if (files.length === 0) throw new BadRequestException('That archive has no files in it.');
    if (files.length > MAX_ZIP_ENTRIES) {
      throw new BadRequestException(
        `That archive has ${files.length} files, over the ${MAX_ZIP_ENTRIES} limit for one import.`,
      );
    }

    const results: ImageZipEntryResult[] = [];
    const candidates: { entry: JSZip.JSZipObject; filename: string; key: string }[] = [];

    for (const entry of files) {
      const filename = baseName(entry.name);
      const ext = filename.toLowerCase().split('.').pop() ?? '';
      if (!IMAGE_EXTENSIONS.has(ext)) {
        results.push({
          filename,
          key: '',
          status: 'not_an_image',
          detail: `.${ext || 'no extension'} is not an image this import reads.`,
        });
        continue;
      }
      candidates.push({ entry, filename, key: this.keyFor(filename, opts) });
    }

    /*
     * One query for every key, not one per file.
     *
     * A 1,500-image archive was otherwise 1,500 round trips, and the obvious fix
     * — matching in JavaScript against every product in the tenant — is worse at
     * the size where it matters.
     */
    const keys = [...new Set(candidates.map((c) => c.key).filter(Boolean))];
    const index = await this.indexFor(user, keys, opts);

    let expanded = 0;
    let uploaded = 0;

    for (const c of candidates) {
      const hits = index.get(normaliseKey(c.key)) ?? [];
      if (hits.length === 0) {
        results.push({
          filename: c.filename,
          key: c.key,
          status: 'unmatched',
          detail: `No product with that ${labelFor(opts.matchBy)}.`,
        });
        continue;
      }
      if (hits.length > 1) {
        // Two products answer to this name. Guessing would attach the photo to
        // one of them and leave nothing to say which.
        results.push({
          filename: c.filename,
          key: c.key,
          status: 'ambiguous',
          detail: `${hits.length} products share that ${labelFor(opts.matchBy)}: ${hits
            .slice(0, 3)
            .map((h) => h.sku)
            .join(', ')}.`,
        });
        continue;
      }
      const product = hits[0];

      if (product.imageUrl && !opts.overwriteExisting) {
        results.push({
          filename: c.filename,
          key: c.key,
          status: 'skipped_has_image',
          productId: product.id,
          productSku: product.sku,
          detail: 'It already has a photograph. Tick "replace existing" to change it.',
        });
        continue;
      }

      // Declared size first: it costs nothing and catches the honest big file
      // before it is decompressed.
      const declared = declaredSize(c.entry);
      if (declared != null && declared > MAX_IMAGE_BYTES) {
        results.push({
          filename: c.filename,
          key: c.key,
          status: 'too_large',
          detail: `${mb(declared)}MB, over the ${mb(MAX_IMAGE_BYTES)}MB limit for one image.`,
        });
        continue;
      }

      if (!commit) {
        results.push({
          filename: c.filename,
          key: c.key,
          status: 'matched',
          productId: product.id,
          productSku: product.sku,
        });
        continue;
      }

      try {
        const bytes = Buffer.from(await c.entry.async('nodebuffer'));
        // Checked AFTER decompressing as well: the declared size is metadata a
        // crafted archive controls, and this is the number that is actually true.
        if (bytes.length > MAX_IMAGE_BYTES) {
          results.push({
            filename: c.filename,
            key: c.key,
            status: 'too_large',
            detail: `${mb(bytes.length)}MB once decompressed.`,
          });
          continue;
        }
        expanded += bytes.length;
        if (expanded > MAX_EXPANDED_BYTES) {
          throw new BadRequestException(
            `That archive expands to more than ${mb(MAX_EXPANDED_BYTES)}MB. Split it.`,
          );
        }

        /*
         * The key is derived from the PRODUCT id, not the source filename. Two
         * consequences, both wanted: re-running the same import overwrites in
         * place instead of accumulating copies, and a supplier's filename never
         * becomes part of a public URL.
         */
        const ext = c.filename.toLowerCase().split('.').pop() ?? 'jpg';
        const url = await this.storage.save(
          user.organisationId,
          'catalogue',
          `${product.id}.${ext}`,
          bytes,
        );
        await this.prisma.product.update({
          where: { id: product.id },
          data: { imageUrl: url },
        });
        uploaded++;
        results.push({
          filename: c.filename,
          key: c.key,
          status: 'uploaded',
          productId: product.id,
          productSku: product.sku,
        });
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        const message = err instanceof Error ? err.message : String(err);
        // One bad image must not abandon the other 1,499.
        this.log.error(`Image import failed for ${c.filename}: ${message}`);
        results.push({
          filename: c.filename,
          key: c.key,
          status: 'failed',
          productId: product.id,
          productSku: product.sku,
          detail: message.slice(0, 200),
        });
      }
    }

    const outcome = summarise(results, uploaded);

    if (commit) {
      const batch = await this.prisma.importBatch.create({
        data: {
          organisationId: user.organisationId,
          targetStoreId: opts.storeId ?? null,
          sourceSystem: 'zip',
          entity: 'product-images',
          status: outcome.failed > 0 ? 'needs_review' : 'completed',
          discovered: outcome.entries,
          imported: outcome.uploaded,
          updated: 0,
          skipped: outcome.skipped + outcome.ignored,
          failed: outcome.failed,
          duplicate: outcome.ambiguous,
          createdById: user.id,
        },
        select: { id: true },
      });
      outcome.batchId = batch.id;

      await this.audit.record(user, {
        action: 'imports.product_images',
        entityType: 'ImportBatch',
        entityId: batch.id,
        storeId: opts.storeId ?? null,
        summary: `Imported ${outcome.uploaded} product image(s) from a ZIP`,
        metadata: {
          matchBy: opts.matchBy,
          entries: outcome.entries,
          unmatched: outcome.unmatched,
          ambiguous: outcome.ambiguous,
          failed: outcome.failed,
          overwriteExisting: Boolean(opts.overwriteExisting),
        },
      });
    }
    return outcome;
  }

  /** The filename, reduced to the key the tenant says it is. */
  private keyFor(filename: string, opts: ImageZipOptions): string {
    let stem = filename.replace(/\.[^.]+$/, '').trim();
    if (opts.stripPrefix && stem.toLowerCase().startsWith(opts.stripPrefix.toLowerCase())) {
      stem = stem.slice(opts.stripPrefix.length);
    }

    const trimSuffix = (s: string) =>
      opts.stripSuffix && s.toLowerCase().endsWith(opts.stripSuffix.toLowerCase())
        ? s.slice(0, s.length - opts.stripSuffix.length)
        : s;

    /*
     * The named suffix sits on either side of a DAM's index depending on the
     * export: "CODE_main-2" and "CODE-2_main" are both real. So the suffix is
     * trimmed, then at most ONE numeric index, then the suffix again.
     *
     * Once, deliberately. Trimming numbers repeatedly would take "RING-10-20"
     * down to "RING", quietly merging two genuinely different codes.
     */
    stem = trimSuffix(stem);
    if (opts.stripNumericSuffix) {
      // "RING-101-2" and "RING-101_02" → "RING-101". Only when asked: a tenant
      // whose codes genuinely end in -2 would otherwise see them all merged.
      stem = stem.replace(/[-_ ]\d{1,2}$/, '');
    }
    stem = trimSuffix(stem);
    return stem.trim();
  }

  /**
   * Products for these keys, grouped by normalised key.
   *
   * A list per key rather than one product: two products CAN share a name, and
   * the caller has to be able to say so rather than take the first row the
   * database happened to return.
   */
  private async indexFor(
    user: AuthUser,
    keys: string[],
    opts: ImageZipOptions,
  ): Promise<Map<string, { id: string; sku: string; imageUrl: string | null }[]>> {
    const map = new Map<string, { id: string; sku: string; imageUrl: string | null }[]>();
    if (keys.length === 0) return map;

    /*
     * Matched in SQL on the NORMALISED value, not on the literal one.
     *
     * A supplier writes `BANGLE_300` in the spreadsheet and `bangle-300.png` on
     * the file. A Prisma `in` with `mode: 'insensitive'` handles the case and
     * misses the separator entirely, and normalising only on the JavaScript side
     * would mean loading every product in the tenant to compare them. Postgres
     * can do both in the filter, so it does.
     *
     * `column` is interpolated raw, which is safe for exactly one reason: it is
     * chosen from a three-value whitelist that `process` has already validated,
     * never from anything a caller sent.
     */
    const column =
      opts.matchBy === 'sku' ? '"sku"' : opts.matchBy === 'legacyId' ? '"legacyId"' : '"name"';

    // Chunked: a 5,000-file archive would otherwise build an IN list Postgres
    // has to parse in one statement.
    const CHUNK = 500;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK).map((k) => normaliseKey(k));
      const rows = await this.prisma.$queryRaw<
        { id: string; sku: string; matchValue: string | null; imageUrl: string | null }[]
      >(Prisma.sql`
        SELECT "id", "sku", ${Prisma.raw(column)} AS "matchValue", "imageUrl"
        FROM "Product"
        WHERE "organisationId" = ${user.organisationId}
          ${opts.storeId ? Prisma.sql`AND "storeId" = ${opts.storeId}` : Prisma.empty}
          AND lower(translate(${Prisma.raw(column)}, '-_ ', '')) IN (${Prisma.join(slice)})
      `);
      for (const row of rows) {
        if (!row.matchValue) continue;
        const k = normaliseKey(row.matchValue);
        const list = map.get(k) ?? [];
        list.push({ id: row.id, sku: row.sku, imageUrl: row.imageUrl });
        map.set(k, list);
      }
    }
    return map;
  }
}

function summarise(results: ImageZipEntryResult[], uploaded: number): ImageZipOutcome {
  const count = (s: ImageZipEntryResult['status']) => results.filter((r) => r.status === s).length;
  return {
    entries: results.length,
    matched: count('matched') + uploaded,
    uploaded,
    unmatched: count('unmatched'),
    ambiguous: count('ambiguous'),
    skipped: count('skipped_has_image'),
    ignored: count('not_an_image') + count('too_large'),
    failed: count('failed'),
    results,
  };
}

/** Zip entries carry their path; only the leaf is the product's name. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** Case- and separator-insensitive, so `RING_101` and `ring-101` are one key. */
function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

/** JSZip exposes the uncompressed size on an internal field; absent is fine. */
function declaredSize(entry: JSZip.JSZipObject): number | null {
  const meta = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof meta?.uncompressedSize === 'number' ? meta.uncompressedSize : null;
}

function labelFor(matchBy: MatchBy): string {
  return matchBy === 'sku' ? 'SKU' : matchBy === 'legacyId' ? 'source id' : 'name';
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
