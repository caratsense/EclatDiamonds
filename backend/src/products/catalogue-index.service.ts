import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { JobContext, JobsService } from '../jobs/jobs.service';
import { StorageService } from '../storage/storage.service';
import { applyImageOrder, orderImages } from '../catalogue/image-order';
import { fetchImage, ImageFetchError } from './image-fetch.util';
import { InferenceVersions, MlInferenceService } from './ml-inference.service';

export const EMBED_JOB = 'catalogue.embed_image';
/** Bump when anything on THIS side changes what a stored vector means. */
export const INDEX_PIPELINE = 'idx1';
export const EMBED_MAX_ATTEMPTS = 5;
export const THUMB_JOB = 'catalogue.thumb_image';
const THUMB_PX = 400;
/** Where the Eclat website keeps its product pictures; website listings point here. */
const WEBSITE_IMAGE_HOST = 'eclat-assets.s3.ap-south-1.amazonaws.com';
const CHUNK = 500;

/** The version an indexed picture is stamped with, or null when it cannot be told. */
export function versionKey(v: InferenceVersions): string | null {
  if (!v.dino || !v.siglip || !v.preprocessing) return null;
  return `${INDEX_PIPELINE}|${v.dino}|${v.siglip}|${v.preprocessing}`;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export interface IndexCounts {
  pending: number;
  queued: number;
  running: number;
  indexed: number;
  failed: number;
  dead: number;
  skipped: number;
}

/**
 * Durable image indexing for visual search: one idempotent JobTask per
 * (picture, its bytes-or-URL, pipeline version). See
 * docs/modules/05-catalogue-sources.md ("Index + search").
 *
 * `ProductImage.embeddingStatus` is the truth about progress — not memory, not
 * a request that happens to still be open. A restart loses nothing: the queue's
 * lease hands an abandoned job to the next worker.
 */
@Injectable()
export class CatalogueIndexService implements OnModuleInit {
  private readonly logger = new Logger(CatalogueIndexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
    private readonly inference: MlInferenceService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.jobs.register(EMBED_JOB, (payload, ctx) => this.embedOne(payload as { imageId: string }, ctx));
    this.jobs.register(THUMB_JOB, (payload, ctx) => this.thumbOne(payload as { imageId: string }, ctx));
  }

  // ------------------------------------------------------------------ enqueue
  /**
   * Queue these images of `organisationId` for embedding. Returns how many
   * were newly queued (an image already queued, or already indexed at the
   * current version, is not queued again). A tombstoned image passed here has
   * its vectors removed instead.
   */
  async enqueue(organisationId: string, imageIds: string[], opts: { force?: boolean } = {}): Promise<number> {
    if (!imageIds.length) return 0;
    // Never a live /health call here: enqueue runs inside uploads and sync
    // commits. The last known version keys the job; the worker stamps the real
    // one, and the sweep re-queues anything a stale guess let through.
    const version = versionKey(this.inference.cachedVersions()) ?? 'unknown';
    let queued = 0;
    for (let i = 0; i < imageIds.length; i += CHUNK) {
      const images = await this.prisma.productImage.findMany({
        // The organisation filter is the tenant guard: an id from elsewhere is ignored.
        where: { id: { in: imageIds.slice(i, i + CHUNK) }, organisationId },
        select: { id: true, url: true, status: true, contentHash: true, embeddingStatus: true, embeddingVersion: true, thumbUrl: true },
      });
      const gone = images.filter((m) => m.status !== 'active').map((m) => m.id);
      if (gone.length) await this.purge(organisationId, gone);

      await this.queueThumbs(images.filter((m) => m.status === 'active' && !m.thumbUrl).map((m) => ({ ...m, organisationId })));

      const todo = images.filter(
        (m) => m.status === 'active' && (opts.force || m.embeddingStatus !== 'indexed' || m.embeddingVersion !== version),
      );
      if (!todo.length) continue;
      const keyOf = (m: (typeof todo)[number]) =>
        `${EMBED_JOB}:${organisationId}:${m.id}:${m.contentHash ?? `url-${sha256(m.url).slice(0, 16)}`}:${version}`;
      const keys = new Map(todo.map((m) => [keyOf(m), m.id]));

      // ponytail: writes JobTask directly (batched) rather than one
      // JobsService.enqueue round trip per picture — a rebuild is thousands.
      const existing = await this.prisma.jobTask.findMany({
        where: { idempotencyKey: { in: [...keys.keys()] } },
        select: { id: true, idempotencyKey: true, status: true },
      });
      const known = new Set(existing.map((j) => j.idempotencyKey));
      const fresh = [...keys.entries()].filter(([k]) => !known.has(k));
      const created = await this.prisma.jobTask.createMany({
        data: fresh.map(([k, imageId]) => ({
          kind: EMBED_JOB,
          organisationId,
          payload: { imageId },
          idempotencyKey: k,
          priority: -2, // behind imports, messages and grid thumbnails: indexing is never urgent
          runAt: new Date(),
          maxAttempts: EMBED_MAX_ATTEMPTS,
        })),
        skipDuplicates: true,
      });
      // A finished job with the same key means the same work was done (or
      // given up on) before, yet the picture is not current now: run it again.
      const revive = existing.filter((j) => j.status === 'succeeded' || j.status === 'dead');
      if (revive.length) {
        await this.prisma.jobTask.updateMany({
          where: { id: { in: revive.map((j) => j.id) }, organisationId },
          data: { status: 'pending', attempts: 0, runAt: new Date(), lastError: null, finishedAt: null, startedAt: null },
        });
      }
      const touched = [...fresh.map(([, id]) => id), ...revive.map((j) => keys.get(j.idempotencyKey!)!)];
      if (touched.length) {
        await this.prisma.productImage.updateMany({
          where: { id: { in: touched }, embeddingStatus: { not: 'running' } },
          // The last error stays visible until a run succeeds.
          data: { embeddingStatus: 'queued' },
        });
      }
      queued += created.count + revive.length;
    }
    return queued;
  }

  /**
   * The syncs tombstone pictures directly (status = 'tombstoned') without
   * telling the index. Search already ignores them; this removes their rows,
   * across every organisation, so nothing depends on a caller remembering.
   */
  async purgeTombstoned(): Promise<number> {
    const stale = await this.prisma.productImage.findMany({
      where: { status: { not: 'active' }, embeddings: { some: {} } },
      select: { id: true, organisationId: true },
      take: 5000,
    });
    let n = 0;
    for (const org of new Set(stale.map((s) => s.organisationId))) {
      n += await this.purge(org, stale.filter((s) => s.organisationId === org).map((s) => s.id));
    }
    return n;
  }

  /** Drop the vectors of pictures that are no longer shown. */
  async purge(organisationId: string, imageIds: string[]): Promise<number> {
    if (!imageIds.length) return 0;
    const res = await this.prisma.productEmbedding.deleteMany({
      where: { organisationId, productImageId: { in: imageIds } },
    });
    await this.prisma.productImage.updateMany({
      where: { organisationId, id: { in: imageIds }, status: { not: 'active' } },
      data: { embeddingStatus: 'skipped' },
    });
    return res.count;
  }

  /**
   * Queue every active picture of the organisation (or of one design) that is
   * not indexed at the current version — `force` queues them all. A design
   * whose only picture is the legacy `Product.imageUrl` first gets that picture
   * as a ProductImage, so the indexer has exactly one kind of input.
   */
  async rebuild(
    organisationId: string,
    opts: { productId?: string; force?: boolean; productWhere?: Prisma.ProductWhereInput } = {},
  ): Promise<{ queued: number; total: number; purged: number }> {
    const productWhere: Prisma.ProductWhereInput = {
      ...(opts.productWhere ?? {}),
      organisationId,
      ...(opts.productId ? { id: opts.productId } : {}),
    };
    const coverOnly = await this.prisma.product.findMany({
      where: { ...productWhere, imageUrl: { not: null }, images: { none: {} } },
      select: { id: true, imageUrl: true },
    });
    if (coverOnly.length) {
      await this.prisma.productImage.createMany({
        data: coverOnly.map((p) => ({
          organisationId,
          productId: p.id,
          url: p.imageUrl!,
          source: 'other',
          isPrimary: true,
        })),
      });
    }

    // Vectors of pictures that were tombstoned or deleted without telling us.
    const orphans = await this.prisma.productEmbedding.findMany({
      where: {
        organisationId,
        product: productWhere,
        OR: [{ productImageId: null }, { productImage: { status: { not: 'active' } } }],
      },
      select: { id: true },
    });
    if (orphans.length) {
      await this.prisma.productEmbedding.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
    }

    let queued = 0;
    let total = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.productImage.findMany({
        where: { organisationId, status: 'active', product: productWhere },
        orderBy: { id: 'asc' },
        take: CHUNK,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true },
      });
      if (!page.length) break;
      total += page.length;
      queued += await this.enqueue(organisationId, page.map((p) => p.id), { force: opts.force });
      cursor = page[page.length - 1].id;
    }
    return { queued, total, purged: orphans.length };
  }

  /** Counts by embedding status over the organisation's active pictures. */
  async counts(organisationId: string): Promise<IndexCounts & { total: number }> {
    const grouped = await this.prisma.productImage.groupBy({
      by: ['embeddingStatus'],
      where: { organisationId, status: 'active' },
      _count: { _all: true },
    });
    const c: IndexCounts = { pending: 0, queued: 0, running: 0, indexed: 0, failed: 0, dead: 0, skipped: 0 };
    for (const g of grouped) c[g.embeddingStatus as keyof IndexCounts] = g._count._all;
    return { ...c, total: grouped.reduce((n, g) => n + g._count._all, 0) };
  }

  /** The served version, asking the inference service (up to its /health timeout). */
  async currentVersion(): Promise<string | null> {
    return versionKey(await this.inference.currentVersions());
  }

  /** The last version seen, without a network call. */
  cachedVersion(): string | null {
    return versionKey(this.inference.cachedVersions());
  }

  /**
   * Self-healing sweep: pictures nobody queued (still `pending`), and pictures
   * indexed under an older model or pipeline, get queued. This is what makes a
   * model upgrade re-index the catalogue without anyone pressing a button.
   */
  /**
   * The grid's thumbnail does not wait for indexing: a job per picture, ahead of
   * the indexing jobs (-1 > -2) but behind everything at the default 0 — a
   * website import's thousands of thumbnails must not hold up a customer's
   * WhatsApp message. Keyed per picture and URL, so asking twice queues once.
   */
  private async queueThumbs(images: { id: string; url: string; organisationId: string }[]): Promise<void> {
    if (!images.length) return;
    await this.prisma.jobTask.createMany({
      data: images.map((m) => ({
        kind: THUMB_JOB,
        organisationId: m.organisationId,
        payload: { imageId: m.id },
        idempotencyKey: `${THUMB_JOB}:${m.organisationId}:${m.id}:${sha256(m.url).slice(0, 16)}`,
        priority: -1,
        runAt: new Date(),
        maxAttempts: 3,
      })),
      skipDuplicates: true,
    });
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'catalogue.index.sweep' })
  async sweep(): Promise<void> {
    if ((this.config.get<string>('SCHEDULER_ENABLED') ?? 'true') === 'false') return;
    await this.purgeTombstoned();
    // Thumbnails need no inference service, so they are swept regardless.
    // ponytail: 5000 per sweep, primaries first; a picture that can never be
    // fetched keeps its place in that window. Page past them if that ever bites.
    await this.queueThumbs(
      await this.prisma.productImage.findMany({
        where: { status: 'active', thumbUrl: null },
        select: { id: true, url: true, organisationId: true },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: 5000,
      }),
    );
    if (!this.inference.available) return;
    const version = await this.currentVersion();
    if (!version) return;
    const orgs = await this.prisma.productImage.groupBy({
      by: ['organisationId'],
      where: {
        status: 'active',
        OR: [{ embeddingStatus: 'pending' }, { embeddingStatus: 'indexed', embeddingVersion: { not: version } }],
      },
    });
    for (const { organisationId } of orgs) {
      try {
        const r = await this.rebuild(organisationId);
        if (r.queued) this.logger.log(`index sweep ${organisationId}: queued ${r.queued} of ${r.total}`);
      } catch (e) {
        this.logger.warn(`index sweep ${organisationId} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // ------------------------------------------------------------------- worker
  private fetchOptions() {
    const hosts = (this.config.get<string>('CATALOGUE_IMAGE_ALLOWED_HOSTS') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    // Our own object storage is always allowed: it is where uploads live.
    for (const base of [this.config.get<string>('R2_PUBLIC_BASE_URL')]) {
      try {
        if (base) hosts.push(new URL(base).host);
      } catch {
        /* a malformed base simply adds nothing */
      }
    }
    if (this.config.get<string>('CLOUDINARY_CLOUD_NAME')) hosts.push('res.cloudinary.com');
    hosts.push(WEBSITE_IMAGE_HOST);
    const max = Number(this.config.get<string>('CATALOGUE_IMAGE_MAX_BYTES'));
    return {
      baseDir: this.storage.baseDir,
      publicPrefix: this.storage.publicPrefix,
      allowedHosts: hosts,
      maxBytes: Number.isFinite(max) && max > 0 ? max : 15 * 1024 * 1024,
    };
  }

  /**
   * A 400 px WebP for the grid, made here rather than by the inference service:
   * a website original is a 3000 px PNG of several MB — about 10 s per card on
   * shop wifi — and indexing, the other source of thumbnails, can lag by hours.
   */
  async thumbOne(payload: { imageId: string }, ctx: JobContext): Promise<Record<string, unknown>> {
    const img = await this.prisma.productImage.findFirst({
      where: { id: String(payload?.imageId ?? ''), organisationId: ctx.organisationId ?? '' },
      select: { id: true, url: true, status: true, thumbUrl: true, organisationId: true },
    });
    if (!img || img.status !== 'active') return { skipped: 'image gone' };
    if (img.thumbUrl) return { skipped: 'already has one' };
    let buffer: Buffer;
    try {
      ({ buffer } = await fetchImage(img.url, this.fetchOptions()));
    } catch (e) {
      if (e instanceof ImageFetchError && e.permanent) return { skipped: e.message };
      throw e;
    }
    let thumb: Buffer;
    try {
      thumb = await sharp(buffer, { failOn: 'none', limitInputPixels: 100_000_000 })
        .rotate()
        .resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (e) {
      // The same bytes will not decode on a retry; the card keeps the original.
      return { skipped: `cannot decode: ${e instanceof Error ? e.message : e}` };
    }
    const url = await this.storage.save(img.organisationId, 'catalogue-thumbs', `${img.id}-grid.webp`, thumb);
    // Indexing may have stored its own meanwhile; either is fine, keep the first.
    await this.prisma.productImage.updateMany({ where: { id: img.id, thumbUrl: null }, data: { thumbUrl: url } });
    return { thumbUrl: url };
  }

  /**
   * Index one picture. Idempotent: running it twice writes the same rows.
   * A permanent failure (404, not an image) marks the picture `dead` at once;
   * a transient one is thrown so the queue retries with backoff, and the last
   * attempt marks it `dead` too, with the reason.
   */
  async embedOne(payload: { imageId: string }, ctx: JobContext): Promise<Record<string, unknown>> {
    const img = await this.prisma.productImage.findFirst({
      where: { id: String(payload?.imageId ?? ''), organisationId: ctx.organisationId ?? '' },
    });
    if (!img) return { skipped: 'image gone' };
    const org = img.organisationId;
    if (img.status !== 'active') {
      await this.purge(org, [img.id]);
      return { skipped: 'tombstoned' };
    }
    if (!this.inference.available) {
      // Nothing to embed with. Leave it pending for the sweep once configured.
      await this.prisma.productImage.update({ where: { id: img.id }, data: { embeddingStatus: 'pending' } });
      return { skipped: 'inference not configured' };
    }
    const failedBefore = img.embeddingError != null;
    await this.prisma.productImage.update({
      where: { id: img.id },
      data: { embeddingStatus: 'running', embeddingAttempts: ctx.attempt },
    });

    try {
      const { buffer, mime } = await fetchImage(img.url, this.fetchOptions());
      const hash = sha256(buffer);

      // The same bytes twice in one design are one picture.
      const twin = await this.prisma.productImage.findFirst({
        where: { productId: img.productId, contentHash: hash, status: 'active', id: { not: img.id } },
      });
      if (twin) {
        const [keep, drop] = orderImages([img, twin]);
        await this.mergeDuplicate(keep.id, drop.id);
        if (drop.id === img.id) {
          await applyImageOrder(this.prisma, img.productId);
          return { duplicateOf: keep.id };
        }
      }

      const versions = await this.inference.currentVersions();
      const version = versionKey(versions);
      if (!version) throw new ImageFetchError('inference health unavailable', false);
      let res;
      try {
        res = await this.inference.embedBatch([{ id: img.id, bytes: buffer, mime }], { thumbnailPx: THUMB_PX });
      } catch (e) {
        throw new ImageFetchError(`inference failed: ${e instanceof Error ? e.message : e}`, false);
      }
      const r = res.results[0];
      if (!r) throw new ImageFetchError(`decode failed: ${res.errors[0]?.error ?? 'no vector returned'}`, true);

      let thumbUrl = img.contentHash === hash ? img.thumbUrl : null;
      if (!thumbUrl && r.thumb?.bytes.length) {
        const ext = r.thumb.mime.includes('webp') ? 'webp' : r.thumb.mime.includes('png') ? 'png' : 'jpg';
        thumbUrl = await this.storage.save(org, 'catalogue-thumbs', `${img.id}-${hash.slice(0, 12)}.${ext}`, r.thumb.bytes);
      }

      const product = await this.prisma.product.findUniqueOrThrow({ where: { id: img.productId }, select: { storeId: true } });
      const preproc = versions.preprocessing!;
      const rows = [r, ...r.views].map((v, n) => ({
        organisationId: org,
        productId: img.productId,
        productImageId: img.id,
        storeId: product.storeId,
        dinoEmbedding: v.dino,
        siglipEmbedding: v.siglip,
        dinoModelVersion: versions.dino!,
        siglipModelVersion: versions.siglip!,
        preprocessingVersion: preproc,
        imageHash: n === 0 ? hash : `${hash}#v${n}`,
      }));
      await this.prisma.$transaction([
        // Replace, not merge: a detector that finds fewer pieces this time, or a
        // version bump, must not leave the old rows behind.
        this.prisma.productEmbedding.deleteMany({
          where: {
            OR: [
              { productImageId: img.id },
              // Legacy cover vectors (pre-gallery rows) of this design.
              { productId: img.productId, productImageId: null },
              { productId: img.productId, preprocessingVersion: preproc, imageHash: { in: rows.map((x) => x.imageHash) } },
            ],
          },
        }),
        this.prisma.productEmbedding.createMany({ data: rows }),
        this.prisma.productImage.update({
          where: { id: img.id },
          data: {
            contentHash: hash,
            thumbUrl,
            ...(r.width && r.height ? { width: r.width, height: r.height } : {}),
            embeddingStatus: 'indexed',
            embeddingVersion: version,
            embeddingError: null,
            embeddedAt: new Date(),
          },
        }),
      ]);
      if (failedBefore || twin) await applyImageOrder(this.prisma, img.productId);
      return { indexed: img.id, rows: rows.length };
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const permanent = e instanceof ImageFetchError && e.permanent;
      const dead = permanent || ctx.attempt >= EMBED_MAX_ATTEMPTS;
      await this.prisma.productImage.update({
        where: { id: img.id },
        data: { embeddingStatus: dead ? 'dead' : 'failed', embeddingError: reason },
      });
      // A dead CAD stops being the cover; the first good website photo takes over.
      if (dead) await applyImageOrder(this.prisma, img.productId);
      if (permanent) return { dead: reason };
      throw e;
    }
  }

  /** Fold `dropId` into `keepId`: its placements move over, it is tombstoned. */
  private async mergeDuplicate(keepId: string, dropId: string) {
    const assocs = await this.prisma.productImageAssociation.findMany({ where: { imageId: dropId }, select: { id: true } });
    for (const a of assocs) {
      try {
        await this.prisma.productImageAssociation.update({ where: { id: a.id }, data: { imageId: keepId } });
      } catch (e) {
        // The survivor already has this exact placement.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          await this.prisma.productImageAssociation.delete({ where: { id: a.id } });
        } else throw e;
      }
    }
    await this.prisma.productEmbedding.deleteMany({ where: { productImageId: dropId } });
    await this.prisma.productImage.update({
      where: { id: dropId },
      data: {
        status: 'tombstoned',
        tombstonedAt: new Date(),
        isPrimary: false,
        embeddingStatus: 'skipped',
        embeddingError: `duplicate of ${keepId}`,
      },
    });
  }
}
