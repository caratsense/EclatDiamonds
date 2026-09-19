import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth-user';
import { CredentialCrypto } from '../../integration/framework/credential-crypto';
import { JobContext, JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CatalogueIndexService } from '../../products/catalogue-index.service';
import { categoryFromRow } from '../../sync/sync.service';
import { WebsiteCatalogueClient, WebsiteClientError, WebsitePage } from './website-catalogue.client';
import { normalizeWebsiteProduct } from './website-normalizer';
import {
  PersistContext,
  PersistResult,
  WEBSITE,
  persistWebsiteProduct,
  reconcileRemovals,
  recordFailedSnapshot,
  tombstoneGone,
} from './website-persister';
import { WebsiteRawDto } from './website.dto';

export const WEBSITE_SYNC_JOB = 'catalogue.website_sync';
export const WEBSITE_PROVIDER = 'website_catalogue';
export const WEBSITE_CREDENTIAL_KIND = 'service_token';
/** A running run whose heartbeat is older than this may be taken over. */
export const STALE_RUN_MS = 10 * 60_000;
const PREVIEW_LIMIT = 500;

type Db = Prisma.TransactionClient;

/**
 * What the connection row's `config` holds. `productsEndpoint` is the one
 * canonical address (…/products). `baseUrl` is how rows saved before
 * 2026-09-19 stored it; it is read, canonicalised, and never written again.
 * `lastProbe` is the most recent connection check, passed or failed — a failed
 * check of a new address is recorded here without replacing a working one.
 */
interface WebsiteConfig {
  productsEndpoint?: string;
  baseUrl?: string;
  lastProbe?: { at: string; ok: boolean; endpoint: string; latencyMs?: number; sourceTotal?: number | null; error?: string };
}

export type WebsiteConnectionState = 'not_configured' | 'connected' | 'sync_running' | 'needs_attention' | 'failed';
type Counters = { created: number; updated: number; unchanged: number; conflicted: number; failed: number; imagesExpected: number; imagesReceived: number; imagesQueued: number };

class DryRunRollback extends Error {
  constructor(readonly result: unknown) {
    super('dry run');
  }
}
class LostRun extends Error {}

/**
 * The website catalogue connector: credential, runs (with receipts, dry-run
 * preview and resume), the shop-PC raw ingest, the conflict queue and health.
 * See docs/modules/05-catalogue-sources.md. Never logs a payload or the token.
 */
@Injectable()
export class WebsiteCatalogueService implements OnModuleInit {
  private readonly log = new Logger(WebsiteCatalogueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly crypto: CredentialCrypto,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly index: CatalogueIndexService,
    readonly client: WebsiteCatalogueClient,
  ) {}

  onModuleInit(): void {
    this.jobs.register(WEBSITE_SYNC_JOB, (payload, ctx) => this.runJob(payload as { runId?: string; claim?: string }, ctx));
  }

  private ctx(runId: string): PersistContext {
    return { runId, now: new Date(), categoryOf: categoryFromRow };
  }

  // ── credential ──────────────────────────────────────────────────────────
  private endpointOf(config: unknown): string | null {
    const c = (config ?? {}) as WebsiteConfig;
    const raw = c.productsEndpoint ?? c.baseUrl;
    if (!raw) return null;
    try {
      return this.client.productsEndpoint(raw).toString();
    } catch {
      return null;
    }
  }

  private findIntegration(organisationId: string) {
    return this.prisma.integration.findFirst({
      where: { organisationId, providerCode: WEBSITE_PROVIDER },
      include: { credentials: { where: { kind: WEBSITE_CREDENTIAL_KIND, organisationId } } },
    });
  }

  private storedToken(integration: { id: string; organisationId: string; credentials: { ciphertext: string; iv: string; authTag: string; keyVersion: number }[] }): string | null {
    const row = integration.credentials[0];
    return row
      ? this.crypto.decrypt(row, { organisationId: integration.organisationId, integrationId: integration.id, kind: WEBSITE_CREDENTIAL_KIND })
      : null;
  }

  /**
   * Save an address (the API base or the exact products endpoint) and, with it,
   * an optional token — but only once a read-only probe through the sync's own
   * client has read a product from it. A failed probe persists nothing new: a
   * working address stays, with the failed attempt recorded beside it.
   */
  async setCredential(user: AuthUser, token: string | undefined, address: string) {
    let candidate: string;
    try {
      candidate = this.client.productsEndpoint(address).toString();
    } catch (e) {
      throw new BadRequestException(errText(e));
    }
    const newToken = token?.trim() || null;
    if (newToken) this.crypto.assertConfigured();
    const org = user.organisationId;
    const existing = await this.findIntegration(org);
    const at = new Date();
    let probe;
    try {
      probe = await this.client.probe(candidate, newToken ?? (existing ? this.storedToken(existing) : null));
    } catch (e) {
      if (existing) {
        const config: WebsiteConfig = {
          ...((existing.config ?? {}) as WebsiteConfig),
          lastProbe: { at: at.toISOString(), ok: false, endpoint: candidate, error: errText(e) },
        };
        await this.prisma.integration.update({ where: { id: existing.id }, data: { config: config as Prisma.InputJsonValue } });
      }
      await this.audit.record(user, {
        action: 'integration.connection_failed',
        entityType: 'Integration',
        entityId: existing?.id ?? 'website_catalogue',
        summary: 'A website catalogue address failed its connection test and was not saved',
        metadata: { host: new URL(candidate).hostname, error: errText(e) },
      });
      throw upstreamError(e);
    }
    const config: WebsiteConfig = {
      productsEndpoint: probe.productsEndpoint,
      lastProbe: { at: at.toISOString(), ok: true, endpoint: probe.productsEndpoint, latencyMs: probe.latencyMs, sourceTotal: probe.sourceTotal },
    };
    const integration = await this.prisma.integration.upsert({
      where: { organisationId_providerCode_name: { organisationId: org, providerCode: WEBSITE_PROVIDER, name: 'Website catalogue' } },
      create: {
        organisationId: org,
        providerCode: WEBSITE_PROVIDER,
        name: 'Website catalogue',
        status: 'connected',
        config: config as Prisma.InputJsonValue,
        lastHealthAt: at,
        createdById: user.id,
      },
      update: { config: config as Prisma.InputJsonValue, status: 'connected', lastHealthAt: at, lastError: null },
    });
    if (newToken) {
      const ctx = { organisationId: org, integrationId: integration.id, kind: WEBSITE_CREDENTIAL_KIND };
      const sealed = this.crypto.encrypt(newToken, ctx);
      const secret = { ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.authTag, keyVersion: sealed.keyVersion };
      await this.prisma.integrationCredential.upsert({
        where: { integrationId_kind: { integrationId: integration.id, kind: WEBSITE_CREDENTIAL_KIND } },
        create: { organisationId: org, integrationId: integration.id, kind: WEBSITE_CREDENTIAL_KIND, ...secret },
        update: { organisationId: org, ...secret, rotatedAt: new Date() },
      });
    }
    const host = new URL(probe.productsEndpoint).hostname;
    await this.audit.record(user, {
      action: 'integration.credential_set',
      entityType: 'Integration',
      entityId: integration.id,
      summary: newToken ? 'Updated the website catalogue service token' : 'Connected the website catalogue',
      metadata: { kind: WEBSITE_CREDENTIAL_KIND, host, token: !!newToken, sourceTotal: probe.sourceTotal },
    });
    return { configured: true, verified: true, host, productsEndpoint: probe.productsEndpoint, sourceTotal: probe.sourceTotal, checkedAt: at };
  }

  /** Re-check the saved address with the same read-only probe. Starts no sync and writes no catalogue row. */
  async testConnection(user: AuthUser) {
    const integration = await this.findIntegration(user.organisationId);
    const endpoint = integration && this.endpointOf(integration.config);
    if (!integration || !endpoint) throw new BadRequestException('The website catalogue connection is not configured.');
    const at = new Date();
    const prior = (integration.config ?? {}) as WebsiteConfig;
    try {
      const probe = await this.client.probe(endpoint, this.storedToken(integration));
      const config: WebsiteConfig = {
        productsEndpoint: probe.productsEndpoint,
        lastProbe: { at: at.toISOString(), ok: true, endpoint: probe.productsEndpoint, latencyMs: probe.latencyMs, sourceTotal: probe.sourceTotal },
      };
      await this.prisma.integration.update({
        where: { id: integration.id },
        data: { status: 'connected', lastHealthAt: at, lastError: null, config: config as Prisma.InputJsonValue },
      });
      await this.audit.record(user, {
        action: 'integration.connection_tested',
        entityType: 'Integration',
        entityId: integration.id,
        summary: 'Website catalogue connection test passed',
        metadata: { sourceTotal: probe.sourceTotal, latencyMs: probe.latencyMs },
      });
      return { verified: true, productsEndpoint: probe.productsEndpoint, sourceTotal: probe.sourceTotal, latencyMs: probe.latencyMs, checkedAt: at };
    } catch (e) {
      const config: WebsiteConfig = { ...prior, productsEndpoint: endpoint, lastProbe: { at: at.toISOString(), ok: false, endpoint, error: errText(e) } };
      await this.prisma.integration.update({
        where: { id: integration.id },
        data: { status: 'error', lastError: errText(e), config: config as Prisma.InputJsonValue },
      });
      await this.audit.record(user, {
        action: 'integration.connection_tested',
        entityType: 'Integration',
        entityId: integration.id,
        summary: 'Website catalogue connection test failed',
        metadata: { error: errText(e) },
      });
      throw upstreamError(e);
    }
  }

  /** The token is optional: the Eclat product feed is public. */
  private async connection(organisationId: string, opts: { requireVerified?: boolean } = {}): Promise<{ endpoint: string; token: string | null }> {
    const integration = await this.findIntegration(organisationId);
    const endpoint = integration && this.endpointOf(integration.config);
    if (!integration || !endpoint) throw new BadRequestException('The website catalogue connection is not configured.');
    // Rows saved before probes existed say 'connected' with no check time: not verified.
    if (opts.requireVerified && (integration.status !== 'connected' || !integration.lastHealthAt)) {
      throw new BadRequestException('The website connection has not passed its test. Test the connection first.');
    }
    const token = this.storedToken(integration);
    const row = integration.credentials[0];
    if (row) await this.prisma.integrationCredential.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { endpoint, token };
  }

  // ── runs ────────────────────────────────────────────────────────────────
  /** Create (full) or take over (resume) a run and queue it. Returns the run and its claim. */
  async startSync(user: AuthUser | null, organisationId: string, mode: 'full' | 'resume', dryRun = false) {
    const now = new Date();
    const stale = new Date(now.getTime() - STALE_RUN_MS);
    const running = await this.prisma.catalogueSyncRun.findFirst({
      where: { organisationId, source: WEBSITE, status: 'running' },
      orderBy: { startedAt: 'desc' },
    });
    if (running && running.heartbeatAt > stale) throw new ConflictException('A website catalogue sync is already running.');

    let run;
    if (mode === 'resume') {
      const last = await this.prisma.catalogueSyncRun.findFirst({
        where: { organisationId, source: WEBSITE, dryRun: false },
        orderBy: { startedAt: 'desc' },
      });
      if (!last || last.status === 'done') throw new BadRequestException('There is no unfinished website sync to resume.');
      const took = await this.prisma.catalogueSyncRun.updateMany({
        where: { id: last.id, heartbeatAt: last.heartbeatAt },
        data: { status: 'running', mode: 'resume', heartbeatAt: now, finishedAt: null, lastError: null },
      });
      if (!took.count) throw new ConflictException('Another worker took this run over first.');
      run = { ...last, status: 'running', heartbeatAt: now };
    } else {
      if (running) {
        // Stale: its worker is gone. Close it as partial; nothing it wrote is lost.
        await this.prisma.catalogueSyncRun.updateMany({
          where: { id: running.id, heartbeatAt: running.heartbeatAt },
          data: { status: 'partial', lastError: 'Taken over: the worker stopped reporting.', finishedAt: now },
        });
      }
      run = await this.prisma.catalogueSyncRun.create({
        data: { organisationId, source: WEBSITE, mode: 'full', dryRun, startedById: user?.id ?? null, heartbeatAt: now },
      });
    }
    if (user) {
      await this.audit.record(user, {
        action: 'catalogue.website_sync_started',
        entityType: 'CatalogueSyncRun',
        entityId: run.id,
        summary: `Started a ${dryRun ? 'dry-run ' : ''}${mode} website catalogue sync`,
        metadata: { mode, dryRun },
      });
    }
    return { run, claim: now };
  }

  async enqueueRun(organisationId: string, runId: string, claim: Date, createdById?: string) {
    return this.jobs.enqueue({
      kind: WEBSITE_SYNC_JOB,
      organisationId,
      payload: { runId, claim: claim.toISOString() },
      idempotencyKey: `${WEBSITE_SYNC_JOB}:${organisationId}:${runId}:${claim.getTime()}`,
      maxAttempts: 1,
      createdById,
    });
  }

  async requestSync(user: AuthUser, mode: 'full' | 'resume', dryRun = false) {
    await this.connection(user.organisationId, { requireVerified: true });
    const { run, claim } = await this.startSync(user, user.organisationId, mode, dryRun);
    const job = await this.enqueueRun(user.organisationId, run.id, claim, user.id);
    return { runId: run.id, jobId: job.id, status: 'queued', mode, dryRun: run.dryRun };
  }

  private async runJob(payload: { runId?: string; claim?: string }, ctx: JobContext) {
    const org = ctx.organisationId;
    if (!org) throw new Error('website sync job has no organisation');
    if (payload.runId && payload.claim) return this.execute(org, payload.runId, new Date(payload.claim));
    // The daily schedule: a full run unless one is already going.
    try {
      const { run, claim } = await this.startSync(null, org, 'full');
      return this.execute(org, run.id, claim);
    } catch (e) {
      if (e instanceof ConflictException) return { skipped: 'a website sync is already running' };
      throw e;
    }
  }

  /**
   * Run (or continue) a run from its `nextPage`. Every write to the run row is
   * fenced on the heartbeat this worker last wrote, so a worker that has been
   * taken over stops at its next page instead of racing the new owner.
   */
  async execute(organisationId: string, runId: string, claim: Date) {
    let beat = claim;
    const fence = async (data: Prisma.CatalogueSyncRunUpdateManyMutationInput) => {
      const now = new Date();
      const r = await this.prisma.catalogueSyncRun.updateMany({
        where: { id: runId, organisationId, status: 'running', heartbeatAt: beat },
        data: { ...data, heartbeatAt: now },
      });
      if (!r.count) throw new LostRun();
      beat = now;
    };
    try {
      await fence({});
    } catch {
      return { skipped: 'run is owned by another worker' };
    }
    const run = await this.prisma.catalogueSyncRun.findUniqueOrThrow({ where: { id: runId } });
    const c: Counters = {
      created: run.created,
      updated: run.updated,
      unchanged: run.unchanged,
      conflicted: run.conflicted,
      failed: run.failed,
      imagesExpected: run.imagesExpected,
      imagesReceived: run.imagesReceived,
      imagesQueued: run.imagesQueued,
    };
    const detail = (run.detail ?? {}) as { preview?: unknown[]; failures?: unknown[] };
    const preview: unknown[] = detail.preview ?? [];
    const failures: unknown[] = detail.failures ?? [];
    const seen = new Set<string>();
    let expected = run.expected;
    const counters = () => ({ ...c, expected, detail: { ...detail, preview, failures } as Prisma.InputJsonValue });

    try {
      let conn: { endpoint: string; token: string | null };
      try {
        conn = await this.connection(organisationId);
      } catch (e) {
        await fence({ status: 'failed', lastError: errText(e), finishedAt: new Date() });
        return { status: 'failed' };
      }
      let page = run.nextPage;
      for (;;) {
        let res: WebsitePage;
        try {
          res = await this.client.fetchPage(conn.endpoint, conn.token, page, run.pageSize);
        } catch (e) {
          return this.stopPartial(fence, counters(), `Page ${page}: ${errText(e)}`, page);
        }
        if (res.total != null) expected = res.total;
        if (expected == null) {
          return this.stopPartial(fence, counters(), 'The website did not report a product total; completeness cannot be proven.', page);
        }
        const totalPages = res.totalPages ?? Math.max(1, Math.ceil(expected / run.pageSize));
        const isLast = page >= totalPages;
        const wanted = isLast ? expected - (totalPages - 1) * run.pageSize : run.pageSize;
        if (res.products.length < wanted) {
          // Process what arrived (it is real), but the run cannot be complete.
          await this.processBatch(organisationId, runId, run.dryRun, res.products, c, preview, failures, seen, () => fence({}));
          return this.stopPartial(fence, counters(), `Page ${page} returned ${res.products.length} of ${wanted} products.`, page);
        }
        await this.processBatch(organisationId, runId, run.dryRun, res.products, c, preview, failures, seen, () => fence({}));
        const received = run.dryRun ? seen.size : await this.receivedCount(organisationId, runId);
        await fence({ ...counters(), nextPage: page + 1, received });
        if (isLast) {
          if (received < expected) {
            return this.stopPartial(fence, counters(), `Received ${received} distinct products of ${expected}.`, page + 1);
          }
          break;
        }
        page++;
      }
      const removals = await this.finalize(organisationId, runId, run.dryRun, seen);
      await fence({
        ...counters(),
        status: 'done',
        tombstoned: removals.products,
        finishedAt: new Date(),
        detail: { ...detail, preview, failures, removals } as Prisma.InputJsonValue,
      });
      return { status: 'done' };
    } catch (e) {
      if (e instanceof LostRun) return { skipped: 'run was taken over' };
      await fence({ ...counters(), status: 'partial', lastError: errText(e), finishedAt: new Date() }).catch(() => undefined);
      throw e;
    }
  }

  private async stopPartial(
    fence: (d: Prisma.CatalogueSyncRunUpdateManyMutationInput) => Promise<void>,
    counters: Prisma.CatalogueSyncRunUpdateManyMutationInput,
    reason: string,
    nextPage: number,
  ) {
    this.log.warn(`website sync partial: ${reason}`);
    await fence({ ...counters, status: 'partial', lastError: reason.slice(0, 500), nextPage, finishedAt: new Date() });
    return { status: 'partial', reason };
  }

  private receivedCount(organisationId: string, runId: string) {
    return this.prisma.externalProductSnapshot.count({ where: { organisationId, source: WEBSITE, syncRunId: runId } });
  }

  private async processBatch(
    organisationId: string,
    runId: string,
    dryRun: boolean,
    products: unknown[],
    c: Counters,
    preview: unknown[],
    failures: unknown[],
    seen: Set<string>,
    heartbeat: () => Promise<void>,
  ) {
    const queue: string[] = [];
    for (const [i, payload] of products.entries()) {
      if (i && i % 25 === 0) await heartbeat();
      try {
        const r = dryRun
          ? await this.prisma
              .$transaction(async (tx) => {
                throw new DryRunRollback(await persistWebsiteProduct(tx, organisationId, this.ctx(runId), payload));
              }, { timeout: 60_000 })
              .catch((e) => {
                if (e instanceof DryRunRollback) return e.result as PersistResult;
                throw e;
              })
          : await this.prisma.$transaction((tx) => persistWebsiteProduct(tx, organisationId, this.ctx(runId), payload), { timeout: 60_000 });
        this.count(r, c, preview, seen);
        queue.push(...r.newImageIds);
      } catch (e) {
        c.failed++;
        const code = productCodeOf(payload);
        if (failures.length < PREVIEW_LIMIT) failures.push({ productCode: code, error: errText(e) });
        if (!dryRun) {
          const id = await recordFailedSnapshot(this.prisma, organisationId, this.ctx(runId), payload, errText(e));
          seen.add(id);
        } else seen.add(code ?? `#${seen.size}`);
      }
    }
    if (!dryRun && queue.length) c.imagesQueued += await this.enqueueImages(organisationId, queue);
  }

  private count(r: PersistResult, c: Counters, preview: unknown[], seen: Set<string>) {
    seen.add(r.externalId);
    c[r.action]++;
    if (r.conflicts) c.conflicted++;
    c.imagesExpected += r.imagesExpected;
    c.imagesReceived += r.imagesExpected;
    if (preview.length < PREVIEW_LIMIT) {
      preview.push({ productCode: r.productCode, externalId: r.externalId, action: r.action, match: r.match, changes: r.changes });
    }
  }

  async enqueueImages(organisationId: string, imageIds: string[]): Promise<number> {
    if (!imageIds.length) return 0;
    try {
      return await this.index.enqueue(organisationId, [...new Set(imageIds)]);
    } catch (e) {
      // The pictures are stored; the index sweep will pick them up.
      this.log.warn(`could not queue ${imageIds.length} picture(s) for indexing: ${errText(e)}`);
      return 0;
    }
  }

  /**
   * After a COMPLETE run: designs the website no longer lists are tombstoned,
   * and within every design it still lists, whatever it stopped publishing.
   * A dry run only counts what would go.
   */
  private async finalize(organisationId: string, runId: string, dryRun: boolean, seen: Set<string>, inTx?: Db) {
    const now = new Date();
    const db = inTx ?? this.prisma;
    const run = <T>(fn: (tx: Db) => Promise<T>) => (inTx ? fn(inTx) : this.prisma.$transaction(fn, { timeout: 60_000 }));
    const gone = await db.externalProductSnapshot.findMany({
      where: {
        organisationId,
        source: WEBSITE,
        goneAt: null,
        ...(dryRun ? { externalId: { notIn: [...seen] } } : { OR: [{ syncRunId: { not: runId } }, { syncRunId: null }] }),
      },
      select: { id: true, productId: true },
    });
    const out = { products: 0, variants: 0, sizes: 0, prices: 0, images: 0, placements: 0, imagesPurged: 0 };
    if (dryRun) return { ...out, products: gone.length, purgeImageIds: undefined as string[] | undefined };
    const purge: string[] = [];
    for (const g of gone) {
      if (g.productId) {
        purge.push(
          ...(await db.productImage.findMany({ where: { productId: g.productId, source: WEBSITE, status: 'active' }, select: { id: true } })).map((i) => i.id),
        );
      }
      out.products += await run((tx) => tombstoneGone(tx, g.id, g.productId, now));
    }
    const present = await db.externalProductSnapshot.findMany({
      where: { organisationId, source: WEBSITE, syncRunId: runId, goneAt: null, productId: { not: null }, normalizationStatus: { not: 'error' } },
      select: { productId: true, payload: true },
    });
    for (const s of present) {
      const r = await run((tx) => reconcileRemovals(tx, s.productId!, normalizeWebsiteProduct(s.payload), now));
      out.variants += r.variants;
      out.sizes += r.sizes;
      out.prices += r.prices;
      out.images += r.images;
      out.placements += r.placements;
      purge.push(...r.imageIds);
    }
    // Tombstoned pictures leave the search index (enqueue purges them). Inside a
    // caller's transaction that has to wait for the commit.
    out.imagesPurged = purge.length;
    if (!inTx && purge.length) await this.enqueueImages(organisationId, purge);
    return { ...out, purgeImageIds: inTx ? purge : undefined };
  }

  // ── shop-PC path: POST /sync/website/raw ────────────────────────────────
  /**
   * One batch of raw website payloads pushed by the on-site agent, written
   * inside the Gati ingestion transaction `db`. Each product has its own
   * savepoint, so one bad product fails alone. The first batch opens a run;
   * the `final` call closes it — as done (with tombstones) only when the agent
   * says it read everything AND the distinct count reaches the source total.
   */
  async ingestRawBatch(db: Db, organisationId: string, body: WebsiteRawDto) {
    const now = new Date();
    let run = body.runId
      ? await db.catalogueSyncRun.findFirst({ where: { id: body.runId, organisationId, source: WEBSITE } })
      : await db.catalogueSyncRun.create({
          data: { organisationId, source: WEBSITE, mode: 'full', expected: body.expected ?? null, detail: { via: 'shop_pc' } },
        });
    if (!run) throw new NotFoundException('Website sync run not found.');
    if (run.status !== 'running') throw new ConflictException(`Website sync run is ${run.status}; start a new one.`);

    const c = { created: 0, updated: 0, unchanged: 0, conflicted: 0, failed: 0, imagesExpected: 0, imagesReceived: 0, imagesQueued: 0 };
    const queue: string[] = [];
    for (const payload of body.products) {
      await db.$executeRawUnsafe('SAVEPOINT website_item');
      try {
        const r = await persistWebsiteProduct(db, organisationId, this.ctx(run.id), payload);
        await db.$executeRawUnsafe('RELEASE SAVEPOINT website_item');
        this.count(r, c, [], new Set());
        queue.push(...r.newImageIds);
      } catch (e) {
        await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT website_item');
        c.failed++;
        await recordFailedSnapshot(db, organisationId, this.ctx(run.id), payload, errText(e));
      }
    }
    const received = await db.externalProductSnapshot.count({ where: { organisationId, source: WEBSITE, syncRunId: run.id } });
    const expected = body.expected ?? run.expected;
    const increments = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { increment: v }]));
    let status = 'running';
    let removals: Awaited<ReturnType<WebsiteCatalogueService['finalize']>> | null = null;
    let lastError: string | null = null;
    if (body.final) {
      if (body.complete && expected != null && received >= expected) {
        removals = await this.finalize(organisationId, run.id, false, new Set(), db);
        status = 'done';
      } else {
        status = 'partial';
        lastError = body.complete
          ? `Received ${received} distinct products of ${expected ?? 'an unknown total'}.`
          : 'The agent did not read every page; nothing was tombstoned.';
      }
    }
    run = await db.catalogueSyncRun.update({
      where: { id: run.id },
      data: {
        ...increments,
        received,
        expected,
        heartbeatAt: now,
        status,
        lastError,
        ...(body.final ? { finishedAt: now, tombstoned: removals?.products ?? 0 } : {}),
        ...(removals ? { detail: { via: 'shop_pc', removals: { ...removals, purgeImageIds: undefined } } as Prisma.InputJsonValue } : {}),
      },
    });
    const n = body.products.length;
    return {
      entity: 'website-raw',
      runId: run.id,
      status,
      received: n,
      upserted: n - c.failed,
      skipped: c.failed,
      created: c.created,
      updated: c.updated,
      unchanged: c.unchanged,
      conflicted: c.conflicted,
      failed: c.failed,
      runReceived: received,
      expected,
      tombstoned: removals?.products ?? 0,
      /** Queued by the controller after the transaction commits; stripped from the response. */
      queueImageIds: [...queue, ...(removals?.purgeImageIds ?? [])],
    };
  }

  // ── receipts, conflicts, health ─────────────────────────────────────────
  listRuns(organisationId: string) {
    return this.prisma.catalogueSyncRun.findMany({
      where: { organisationId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }

  listConflicts(organisationId: string, status = 'open', kind?: string) {
    return this.prisma.catalogueConflict.findMany({
      where: { organisationId, status, ...(kind ? { kind } : {}) },
      orderBy: [{ lastSeenAt: 'desc' }],
      take: 500,
    });
  }

  async updateConflict(user: AuthUser, id: string, status: 'open' | 'resolved' | 'ignored', resolution?: Record<string, unknown>) {
    const org = user.organisationId;
    const conflict = await this.prisma.catalogueConflict.findFirst({ where: { id, organisationId: org } });
    if (!conflict) throw new NotFoundException('Conflict not found.');
    const linkTo = typeof resolution?.productId === 'string' ? resolution.productId : null;
    if (linkTo) {
      if (conflict.kind !== 'gati_match_ambiguous' || status !== 'resolved') {
        throw new BadRequestException('Only an ambiguous Gati match can be resolved by linking a product.');
      }
      const target = await this.prisma.product.findFirst({ where: { id: linkTo, organisationId: org }, select: { legacyId: true } });
      if (!target || !target.legacyId || target.legacyId.startsWith('WEB-')) {
        throw new BadRequestException('Link to a Gati design of this organisation.');
      }
    }
    const updated = await this.prisma.catalogueConflict.update({
      where: { id },
      data: {
        status,
        resolution: (resolution ?? undefined) as Prisma.InputJsonValue | undefined,
        resolvedById: status === 'open' ? null : user.id,
        resolvedAt: status === 'open' ? null : new Date(),
      },
    });
    await this.audit.record(user, {
      action: 'catalogue.conflict_updated',
      entityType: 'CatalogueConflict',
      entityId: id,
      summary: `Marked ${conflict.kind} ${status}${linkTo ? ' and linked a Gati design' : ''}`,
      metadata: { kind: conflict.kind, status, linked: !!linkTo },
    });
    // A link takes effect now, from the stored payload — no website call.
    if (linkTo && conflict.externalId) {
      const snap = await this.prisma.externalProductSnapshot.findFirst({
        where: { organisationId: org, source: WEBSITE, externalId: conflict.externalId },
      });
      if (snap) {
        const r = await this.prisma.$transaction(
          (tx) => persistWebsiteProduct(tx, org, this.ctx(snap.syncRunId ?? 'link'), snap.payload),
          { timeout: 60_000 },
        );
        await this.enqueueImages(org, r.newImageIds);
      }
    }
    return updated;
  }

  /**
   * The integration board's facts, each measuring one thing. "Connected" means
   * the last read-only probe of the saved address passed — not that an address
   * is stored. Products, website designs, variants and pictures are counted
   * separately because they are different things: a website design matched to
   * a Gati design enriches that one Product rather than adding another.
   */
  async health(organisationId: string) {
    const org = organisationId;
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId: org, providerCode: WEBSITE_PROVIDER },
      select: {
        status: true,
        config: true,
        lastHealthAt: true,
        lastError: true,
        credentials: { where: { kind: WEBSITE_CREDENTIAL_KIND }, select: { lastUsedAt: true, rotatedAt: true } },
      },
    });
    const cfg = (integration?.config ?? {}) as WebsiteConfig;
    const endpoint = integration ? this.endpointOf(cfg) : null;
    const activeImage = { organisationId: org, status: 'active' };
    const [
      lastRun,
      lastSuccess,
      listingsActive,
      listingsUnpublished,
      listingsTombstoned,
      syncStates,
      products,
      websiteLinked,
      websiteOnly,
      variants,
      imagesBySource,
      conflicts,
      missingCad,
      imagesBySourceStatus,
      productsWithIndexedImage,
      productsWithoutImage,
      versions,
    ] = await Promise.all([
      this.prisma.catalogueSyncRun.findFirst({ where: { organisationId: org, source: WEBSITE }, orderBy: { startedAt: 'desc' } }),
      this.prisma.catalogueSyncRun.findFirst({ where: { organisationId: org, source: WEBSITE, status: 'done', dryRun: false }, orderBy: { startedAt: 'desc' } }),
      this.prisma.productWebsiteListing.count({ where: { organisationId: org, tombstonedAt: null, isActive: true, isDeleted: false } }),
      // Still in the feed (and in its total) but switched off or deleted there.
      this.prisma.productWebsiteListing.count({
        where: { organisationId: org, tombstonedAt: null, OR: [{ isActive: false }, { isDeleted: true }] },
      }),
      this.prisma.productWebsiteListing.count({ where: { organisationId: org, tombstonedAt: { not: null } } }),
      this.prisma.syncState.findMany({ where: { organisationId: org, sourceTable: { in: ['StyleMst', 'Inward', 'GatiMediaFiles'] } }, select: { sourceTable: true, lastRunAt: true } }),
      this.prisma.product.count({ where: { organisationId: org } }),
      this.prisma.product.count({ where: { organisationId: org, websiteCode: { not: null } } }),
      this.prisma.product.count({ where: { organisationId: org, legacyId: { startsWith: 'WEB-' } } }),
      this.prisma.productVariant.count({ where: { organisationId: org, status: 'active', source: WEBSITE } }),
      this.prisma.productImage.groupBy({ by: ['source'], where: activeImage, _count: { _all: true } }),
      this.prisma.catalogueConflict.groupBy({ by: ['kind'], where: { organisationId: org, status: 'open' }, _count: { _all: true } }),
      this.prisma.product.count({
        where: {
          organisationId: org,
          legacyId: { not: null },
          NOT: { legacyId: { startsWith: 'WEB-' } },
          images: { none: { source: 'gati_cad', status: 'active' } },
        },
      }),
      this.prisma.productImage.groupBy({ by: ['source', 'embeddingStatus'], where: activeImage, _count: { _all: true } }),
      this.prisma.product.count({ where: { organisationId: org, images: { some: { status: 'active', embeddingStatus: 'indexed' } } } }),
      this.prisma.product.count({ where: { organisationId: org, images: { none: { status: 'active' } } } }),
      this.prisma.productEmbedding.findFirst({
        where: { organisationId: org },
        orderBy: { updatedAt: 'desc' },
        select: { dinoModelVersion: true, siglipModelVersion: true, preprocessingVersion: true },
      }),
    ]);
    const latest = (table: string) =>
      syncStates.filter((s) => s.sourceTable === table).reduce<Date | null>((m, s) => (s.lastRunAt && (!m || s.lastRunAt > m) ? s.lastRunAt : m), null);
    const byKey = <T extends { _count: { _all: number } }>(rows: T[], key: keyof T) =>
      Object.fromEntries(rows.map((r) => [String(r[key]), r._count._all]));

    // A probe that passed sets lastHealthAt; a row saved before probes existed
    // says 'connected' without one, and is not verified.
    const verified = !!endpoint && integration?.status === 'connected' && !!integration.lastHealthAt;
    const running = lastRun?.status === 'running' && lastRun.heartbeatAt.getTime() > Date.now() - STALE_RUN_MS;
    const connectionState: WebsiteConnectionState = !endpoint
      ? 'not_configured'
      : running
        ? 'sync_running'
        : integration?.status === 'error'
          ? 'failed'
          : !verified || (lastRun && (lastRun.status === 'partial' || lastRun.status === 'failed'))
            ? 'needs_attention'
            : 'connected';

    const byStatus: Record<string, number> = {};
    const bySource: Record<string, Record<string, number>> = {};
    for (const r of imagesBySourceStatus) {
      byStatus[r.embeddingStatus] = (byStatus[r.embeddingStatus] ?? 0) + r._count._all;
      (bySource[r.source] ??= {})[r.embeddingStatus] = r._count._all;
    }
    const imagesActive = imagesBySource.reduce((t, r) => t + r._count._all, 0);

    return {
      website: {
        configured: !!endpoint,
        verified,
        connectionState,
        productsEndpoint: endpoint,
        host: endpoint ? new URL(endpoint).hostname : null,
        tokenStored: !!integration?.credentials.length,
        credentialLastUsedAt: integration?.credentials[0]?.lastUsedAt ?? null,
        lastHealthAt: integration?.lastHealthAt ?? null,
        lastError: integration?.lastError ?? null,
        lastProbe: cfg.lastProbe ?? null,
        schedule: 'weekly',
        lastRun: lastRun && {
          id: lastRun.id,
          status: lastRun.status,
          mode: lastRun.mode,
          dryRun: lastRun.dryRun,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          heartbeatAt: lastRun.heartbeatAt,
          nextPage: lastRun.nextPage,
          expected: lastRun.expected,
          received: lastRun.received,
          created: lastRun.created,
          updated: lastRun.updated,
          unchanged: lastRun.unchanged,
          failed: lastRun.failed,
          conflicted: lastRun.conflicted,
          tombstoned: lastRun.tombstoned,
          imagesReceived: lastRun.imagesReceived,
          imagesQueued: lastRun.imagesQueued,
          lastError: lastRun.lastError,
        },
        lastSuccessAt: lastSuccess?.finishedAt ?? null,
        sourceTotal: lastSuccess?.expected ?? lastRun?.expected ?? cfg.lastProbe?.sourceTotal ?? null,
        listingsActive,
        listingsUnpublished,
        listingsTombstoned,
        variants,
      },
      // Queued jobs (a sync, picture indexing) run only where the scheduler
      // drains the queue; with it off they wait forever, so say so.
      scheduler: { enabled: (this.config.get<string>('SCHEDULER_ENABLED') ?? 'true') !== 'false' },
      gati: {
        productsSyncedAt: latest('StyleMst'),
        stockSyncedAt: latest('Inward'),
        imagesSyncedAt: latest('GatiMediaFiles'),
      },
      catalogue: {
        products,
        websiteLinked,
        websiteOnly,
        variants,
        imagesActive,
        imagesBySource: byKey(imagesBySource, 'source'),
        missingCad,
      },
      conflictsOpen: byKey(conflicts, 'kind'),
      embeddings: {
        imagesActive,
        byStatus,
        bySource,
        productsWithIndexedImage,
        productsWithoutImage,
        latestVersions: versions ?? null,
      },
    };
  }

  // ── schedule ────────────────────────────────────────────────────────────
  /**
   * Saturday 21:30 UTC = Sunday 03:00 IST: once a week per organisation whose
   * connection is configured and has passed its test, which picks up designs
   * added to the website. A connection that failed its last test is skipped
   * (health shows it as failed); one already running is skipped by startSync.
   */
  @Cron('0 30 21 * * 6', { name: WEBSITE_SYNC_JOB })
  async scheduleWeekly(): Promise<number> {
    if ((this.config.get<string>('SCHEDULER_ENABLED') ?? 'true') === 'false') return 0;
    const day = new Date().toISOString().slice(0, 10);
    const orgs = (
      await this.prisma.integration.findMany({
        where: { providerCode: WEBSITE_PROVIDER, status: 'connected', lastHealthAt: { not: null } },
        select: { organisationId: true, config: true },
      })
    ).filter((i) => this.endpointOf(i.config));
    let queued = 0;
    for (const { organisationId } of orgs) {
      try {
        await this.jobs.enqueue({
          kind: WEBSITE_SYNC_JOB,
          organisationId,
          payload: {},
          idempotencyKey: `${WEBSITE_SYNC_JOB}:${organisationId}:weekly-${day}`,
          maxAttempts: 1,
        });
        queued++;
      } catch (e) {
        this.log.warn(`website sync could not be queued for an organisation: ${errText(e)}`);
      }
    }
    return queued;
  }
}

function productCodeOf(payload: unknown): string | null {
  const c = (payload as { productCode?: unknown } | null)?.productCode;
  return typeof c === 'string' ? c.trim() : null;
}

/** A failed probe as an HTTP error: 502 when the website could not be reached, 400 when its answer was wrong. */
function upstreamError(e: unknown) {
  return e instanceof WebsiteClientError && e.retryable ? new BadGatewayException(errText(e)) : new BadRequestException(errText(e));
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
