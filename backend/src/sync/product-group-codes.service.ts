import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ProductCategory } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { updateOrgSettings } from '../config/org-settings';
import { JobContext, JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PRODUCT_GROUP_CODES_KEY,
  ProductGroupCode,
  changedGroupCodes,
  groupCodesFor,
  normaliseGroupCodes,
  resolveGroupCodes,
} from './product-group-codes';
import { categoryFromRow } from './sync.service';
import { CODE_GROUP, tokenCode } from './sync.util';

/**
 * Re-read the catalogue under a changed product-group map.
 *
 * Queued rather than done in the request because it rewrites every design and
 * every piece carrying the codes that changed — 8,000 rows on the client's live
 * data — and because the answer head office needs ("saved") is not the same
 * question as "has every row been re-read yet".
 */
export const RECLASSIFY_GROUPS_JOB = 'catalogue.reclassify_groups';

/** How many rows to re-read per page. Nothing here is urgent; memory is. */
const PAGE = 500;

/** One code as the screen shows it: what it means, and what still carries it. */
export interface ProductGroupCodeUsage {
  code: string;
  /** What this code is read as today, or null when nobody has said. */
  category: ProductCategory | null;
  /** Where that reading comes from. `unmapped` is the question for head office. */
  source: 'tenant' | 'built_in' | 'unmapped';
  label: string | null;
  /** Designs and pieces whose code reads as this. */
  products: number;
  pieces: number;
  /** Of those, how many are still filed under `other` — the cost of not knowing. */
  productsUnclassified: number;
  piecesUnclassified: number;
  /** Real codes off the shelf, so "what is CR?" can be answered by looking. */
  examples: string[];
}

/** The stored columns a re-read needs: the codes, and what they say today. */
export interface CodedRow {
  id: string;
  sku: string | null;
  styleNumber: string | null;
  name: string | null;
  description?: string | null;
  category: ProductCategory;
}

/**
 * Head office's own reading of Gati's product-group codes, and the screen that
 * collects it.
 *
 * The map itself and why it lives in `Organisation.settings` are in
 * product-group-codes.ts. This is the part that makes it usable: what each
 * unknown code currently costs, a save, and a re-read of what is already stored.
 */
@Injectable()
export class ProductGroupCodesService implements OnModuleInit {
  private readonly logger = new Logger(ProductGroupCodesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(RECLASSIFY_GROUPS_JOB, (payload, ctx) =>
      this.reclassify(payload as { codes?: unknown }, ctx),
    );
  }

  /** The tenant's own entries, as stored. */
  async list(organisationId: string): Promise<ProductGroupCode[]> {
    const organisation = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const settings = (organisation?.settings ?? {}) as Record<string, unknown>;
    return normaliseGroupCodes(settings[PRODUCT_GROUP_CODES_KEY]);
  }

  /**
   * Every code the catalogue actually carries, biggest first, unanswered ones
   * ahead of the rest.
   *
   * This is the whole point of the screen. Head office cannot fill in an empty
   * form from memory, but they can work down a list that says "144 pieces say
   * LR" — and the ones with the most behind them are the ones worth asking
   * about first.
   */
  async usage(organisationId: string): Promise<ProductGroupCodeUsage[]> {
    const entries = await this.list(organisationId);
    const tenant = new Map(entries.map((e) => [e.code, e]));
    const tally = new Map<string, ProductGroupCodeUsage>();

    const seen = (code: string): ProductGroupCodeUsage => {
      let row = tally.get(code);
      if (!row) {
        const own = tenant.get(code);
        const built = CODE_GROUP[code];
        row = {
          code,
          category: (own?.category ?? built ?? null) as ProductCategory | null,
          source: own ? 'tenant' : built ? 'built_in' : 'unmapped',
          label: own?.label ?? null,
          products: 0,
          pieces: 0,
          productsUnclassified: 0,
          piecesUnclassified: 0,
          examples: [],
        };
        tally.set(code, row);
      }
      return row;
    };

    for await (const row of this.pages('product', organisationId)) {
      const code = codeOfProduct(row);
      if (!code) continue;
      const entry = seen(code);
      entry.products++;
      if (row.category === 'other') entry.productsUnclassified++;
      pushExample(entry, row);
    }
    for await (const row of this.pages('stockItem', organisationId)) {
      const code = codeOfStockItem(row);
      if (!code) continue;
      const entry = seen(code);
      entry.pieces++;
      if (row.category === 'other') entry.piecesUnclassified++;
      pushExample(entry, row);
    }

    // Entries head office has answered that nothing carries still belong on the
    // screen — otherwise a correction to a code no longer in stock would look
    // like it had been thrown away.
    for (const e of entries) seen(e.code);

    return [...tally.values()].sort((a, b) => {
      const unanswered = Number(b.source === 'unmapped') - Number(a.source === 'unmapped');
      if (unanswered) return unanswered;
      return b.products + b.pieces - (a.products + a.pieces);
    });
  }

  /**
   * Replace the tenant's entries and re-read what the change affects.
   *
   * A replace rather than add/edit/remove, like the ad-set rules: the screen
   * holds the whole list, so two people editing converge on a state instead of
   * racing to append. `updateOrgSettings` takes the row lock, so saving these
   * cannot clobber a neighbouring key in the same settings bag.
   */
  async replace(
    user: AuthUser,
    input: unknown,
  ): Promise<{ codes: ProductGroupCode[]; reclassifying: string[] }> {
    const codes = normaliseGroupCodes(input);
    const before = await this.list(user.organisationId);
    const changed = changedGroupCodes(before, codes);

    await updateOrgSettings(this.prisma, user.organisationId, (settings) => ({
      ...settings,
      [PRODUCT_GROUP_CODES_KEY]: codes as unknown as Record<string, unknown>,
    }));
    await this.audit.record(user, {
      action: 'catalogue.product_group_codes_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `Product-group codes: ${codes.length} entered, ${changed.length} changed`,
      metadata: { codes: codes.map((c) => `${c.code}=${c.category}`), changed },
    });

    if (changed.length) {
      await this.jobs.enqueue({
        kind: RECLASSIFY_GROUPS_JOB,
        organisationId: user.organisationId,
        payload: { codes: changed },
        createdById: user.id,
        /*
         * Keyed on the OUTCOME, not on the codes alone.
         *
         * Saving the same change twice — a double-click, a reload and a
         * re-save — is one piece of work and collapses onto one pass. Changing
         * LR to something else later is different work and must run: a key of
         * just the code would collide with the finished job and be answered
         * "already done", leaving the correction stored but never applied.
         */
        idempotencyKey: `${RECLASSIFY_GROUPS_JOB}:${user.organisationId}:${reclassifyKey(changed, codes)}`,
      });
    }
    return { codes, reclassifying: changed };
  }

  /**
   * Re-read every design and piece carrying the codes that changed.
   *
   * Scoped to those codes on purpose. A blanket re-classification would also
   * rewrite rows whose code nobody touched — including anything a person set by
   * hand — so a row is only moved when the meaning of its OWN code changed.
   *
   * Idempotent, as every job here must be: it compares against what is stored
   * and writes only the difference, so a retried pass is a no-op.
   */
  private async reclassify(
    payload: { codes?: unknown },
    ctx: JobContext,
  ): Promise<{ products: number; pieces: number }> {
    const organisationId = ctx.organisationId;
    if (!organisationId) return { products: 0, pieces: 0 };
    const codes = Array.isArray(payload?.codes)
      ? new Set(payload.codes.filter((c): c is string => typeof c === 'string'))
      : new Set<string>();
    if (!codes.size) return { products: 0, pieces: 0 };

    const map = await groupCodesFor(this.prisma, organisationId);
    const products = await this.remap('product', organisationId, codes, (row) =>
      // Exactly the product sync's reading: StyleCode, then StyleSKUNo, then
      // the English-word scan. A re-read that used its own rule would move a
      // design the next Gati batch would move straight back.
      categoryFromRow(
        { StyleCode: row.styleNumber, StyleSKUNo: row.sku, name: row.name, description: row.description },
        map,
      ),
    );
    const pieces = await this.remap('stockItem', organisationId, codes, (row) => {
      // And exactly the stock sync's: the piece's own SKU, and only when that
      // names no group, its design's code.
      const own = categoryFromRow({ InwardSKUNo: row.sku, name: row.name }, map);
      return own !== 'other' ? own : categoryFromRow({ StyleCode: row.styleNumber }, map);
    });
    this.logger.log(`Re-read ${products} design(s) and ${pieces} piece(s) for ${[...codes].join(', ')}`);
    return { products, pieces };
  }

  /** The shared body of the two re-reads: page, decide, write the difference. */
  private async remap(
    model: 'product' | 'stockItem',
    organisationId: string,
    codes: Set<string>,
    categoryOf: (row: CodedRow) => string,
  ): Promise<number> {
    const moves = new Map<ProductCategory, string[]>();
    for await (const row of this.pages(model, organisationId)) {
      /*
       * Any code the row carries, not just the one it is counted under.
       *
       * The two are not the same question: the screen counts a row under the
       * first field that holds two letters, while the classifier takes the
       * first field that holds a code it KNOWS. A design whose style number
       * says LR and whose SKU says RG is counted under LR and classified as a
       * ring, so a selection that looked only at LR would miss it the moment
       * LR was explained. Selecting on either is a superset; the category
       * still comes from the classifier, so nothing is decided here.
       */
      if (!candidateCodes(row).some((code) => codes.has(code))) continue;
      const next = categoryOf(row) as ProductCategory;
      if (next === row.category) continue;
      const bucket = moves.get(next) ?? [];
      bucket.push(row.id);
      moves.set(next, bucket);
    }
    let moved = 0;
    for (const [category, ids] of moves) {
      for (let i = 0; i < ids.length; i += PAGE) {
        const where = { organisationId, id: { in: ids.slice(i, i + PAGE) } };
        const result =
          model === 'product'
            ? await this.prisma.product.updateMany({ where, data: { category } })
            : await this.prisma.stockItem.updateMany({ where, data: { category } });
        moved += result.count;
      }
    }
    return moved;
  }

  /** Designs or pieces, a page at a time: the whole catalogue never sits in memory. */
  private async *pages(
    model: 'product' | 'stockItem',
    organisationId: string,
  ): AsyncGenerator<CodedRow> {
    let cursor: string | undefined;
    for (;;) {
      const page = {
        where: { organisationId },
        orderBy: { id: 'asc' as const },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      };
      const rows: CodedRow[] =
        model === 'product'
          ? await this.prisma.product.findMany({
              ...page,
              select: { id: true, sku: true, styleNumber: true, name: true, description: true, category: true },
            })
          : await this.prisma.stockItem.findMany({
              ...page,
              select: { id: true, sku: true, styleNumber: true, name: true, category: true },
            });
      if (!rows.length) return;
      for (const row of rows) yield row;
      if (rows.length < PAGE) return;
      cursor = rows[rows.length - 1].id;
    }
  }
}

/**
 * The code a design carries: its StyleCode, else its StyleSKUNo.
 *
 * Same order as the product sync's `CODE_FIELDS`, so the screen counts rows
 * under the code the ingestion would classify them by rather than under a
 * second opinion.
 */
export function codeOfProduct(row: Pick<CodedRow, 'sku' | 'styleNumber'>): string {
  return tokenCode(row.styleNumber) || tokenCode(row.sku);
}

/** The code a piece carries: its own InwardSKUNo, else its design's. */
export function codeOfStockItem(row: Pick<CodedRow, 'sku' | 'styleNumber'>): string {
  return tokenCode(row.sku) || tokenCode(row.styleNumber);
}

/** What a re-classification is being asked to do: each changed code, and to what. */
export function reclassifyKey(changed: string[], after: ProductGroupCode[]): string {
  const map = resolveGroupCodes(after);
  return changed.map((code) => `${code}=${map[code] ?? '-'}`).join(',');
}

/** Every code a row carries, for deciding whether a change can reach it. */
export function candidateCodes(row: Pick<CodedRow, 'sku' | 'styleNumber'>): string[] {
  return [tokenCode(row.styleNumber), tokenCode(row.sku)].filter(Boolean);
}

function pushExample(entry: ProductGroupCodeUsage, row: CodedRow): void {
  if (entry.examples.length >= 4) return;
  const example = row.styleNumber || row.sku;
  if (example && !entry.examples.includes(example)) entry.examples.push(example);
}

