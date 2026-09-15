import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ProductCategory, StockClass } from '@prisma/client';
import { Workbook } from 'exceljs';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { SequenceService } from '../common/sequence.service';
import { effectiveStockClass, STOCK_CLASS_LABEL, STOCK_CLASSES } from './stock-class';

/**
 * When a piece counts as dead, and how a piece is identified.
 *
 * ── The threshold ───────────────────────────────────────────────────────────
 *
 * 180 days was a constant in two files and wrong for everybody. A chain moves in
 * weeks; a bridal set is expected to sit for a season. Counting both against one
 * number produces a figure that either alarms about normal inventory or says
 * nothing at all, and either way nobody acts on it.
 *
 * The resolution order is category rule → tenant default → platform default.
 * A tenant that configures nothing keeps exactly today's behaviour, which is what
 * makes this safe to deploy before anybody has decided their numbers.
 *
 * ── The VIN ─────────────────────────────────────────────────────────────────
 *
 * Every other code on a piece belongs to somebody else. The SKU is the DESIGN and
 * is shared across identical pieces; the HUID is BIS's and only exists once
 * hallmarked; the certificate number is the lab's; the legacy id is the old
 * ERP's. So "which piece is this" had no answer we control, and a shop with four
 * identical rings could not tell them apart in the system at all.
 *
 * Issued on demand rather than backfilled: a number in the database that is not
 * on the physical tag is worse than no number, because it reads as authoritative.
 */

/** What everybody got before this existed. Unchanged, so nothing moves on deploy. */
export const DEFAULT_DEAD_STOCK_DAYS = 180;

const MIN_DAYS = 1;
const MAX_DAYS = 3650;

/** One VIN check character, so a mistyped code is rejected rather than mis-looked-up. */
const CHECK_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export type DeadStockView = 'stock' | 'customised' | 'remake' | 'excluded' | 'all';
export const DEAD_STOCK_VIEWS: DeadStockView[] = ['stock', 'customised', 'remake', 'excluded', 'all'];

/** dead = past the threshold; ageing = past the warning too; all = every piece in scope. */
export type DeadStockState = 'dead' | 'ageing' | 'all';
export const DEAD_STOCK_STATES: DeadStockState[] = ['dead', 'ageing', 'all'];

export interface DeadStockListOptions {
  storeId?: string;
  category?: string;
  limit?: number;
  /** Kept for callers from before `state`; `true` is `state: 'ageing'`. */
  includeWarning?: boolean;
  state?: DeadStockState;
  view?: DeadStockView;
  /** Internal: the export may return more rows than a screen. */
  maxLimit?: number;
}

/** A workbook, not a screen — but still bounded, and says so when it is cut. */
const EXPORT_MAX_ROWS = 10_000;

export type DeadStockSuggestion = 'sell' | 'remake' | 'contact_customer';

const SUGGESTION_LABEL: Record<DeadStockSuggestion, string> = {
  sell: 'Sell / promote',
  remake: 'Remake or customise',
  contact_customer: 'Contact the customer',
};

/**
 * What to do with an ageing piece — and, as much as anything, what NOT to.
 *
 * "Sell" goes only to ordinary stock. A customised piece is somebody's order:
 * the action is the customer, never a discount to a stranger. A display piece
 * gets nothing, because it is not for sale. A remake flag was set by a person
 * and wins over both, except on a display piece.
 */
function suggestionFor(
  state: 'dead' | 'ageing' | 'fresh',
  cls: StockClass,
  remakeSuitable: boolean,
): DeadStockSuggestion | null {
  if (state === 'fresh' || cls === 'non_stock') return null;
  if (remakeSuitable) return 'remake';
  return cls === 'customised' ? 'contact_customer' : 'sell';
}

function inDeadStockView(
  view: DeadStockView,
  r: { stockClass: StockClass; remakeSuitable: boolean },
): boolean {
  switch (view) {
    case 'stock':
      return r.stockClass === 'standard';
    case 'customised':
      return r.stockClass === 'customised';
    case 'remake':
      return r.remakeSuitable && r.stockClass !== 'non_stock';
    case 'excluded':
      return r.stockClass === 'non_stock';
    default:
      return true;
  }
}

export interface DeadStockRule {
  category: ProductCategory | null;
  thresholdDays: number;
  warnAfterDays: number | null;
}

export interface ResolvedPolicy {
  /** Every configured rule, plus the effective default. */
  rules: DeadStockRule[];
  defaultThresholdDays: number;
  defaultWarnAfterDays: number | null;
  /** True when the tenant has configured nothing and the platform default applies. */
  usingPlatformDefault: boolean;
}

@Injectable()
export class DeadStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly sequence: SequenceService,
    private readonly audit: AuditService,
  ) {}

  // ==========================================================================
  // Policy
  // ==========================================================================

  async policyFor(organisationId: string): Promise<ResolvedPolicy> {
    const rows = await this.prisma.deadStockPolicy.findMany({
      where: { organisationId },
      orderBy: [{ category: 'asc' }],
    });
    const fallback = rows.find((r) => r.category == null);
    return {
      rules: rows.map((r) => ({
        category: r.category,
        thresholdDays: r.thresholdDays,
        warnAfterDays: r.warnAfterDays,
      })),
      defaultThresholdDays: fallback?.thresholdDays ?? DEFAULT_DEAD_STOCK_DAYS,
      defaultWarnAfterDays: fallback?.warnAfterDays ?? null,
      usingPlatformDefault: rows.length === 0,
    };
  }

  /**
   * A lookup function rather than a map, because the caller is inside a loop over
   * every piece in the branch and must not do a query per row.
   */
  async resolverFor(
    organisationId: string,
  ): Promise<(category: ProductCategory | null | undefined) => DeadStockRule> {
    const policy = await this.policyFor(organisationId);
    const byCategory = new Map(
      policy.rules.filter((r) => r.category != null).map((r) => [r.category!, r]),
    );
    const fallback: DeadStockRule = {
      category: null,
      thresholdDays: policy.defaultThresholdDays,
      warnAfterDays: policy.defaultWarnAfterDays,
    };
    return (category) => (category ? (byCategory.get(category) ?? fallback) : fallback);
  }

  async setRule(
    user: AuthUser,
    input: { category?: string | null; thresholdDays: number; warnAfterDays?: number | null },
  ) {
    const category = this.parseCategory(input.category);
    if (
      !Number.isInteger(input.thresholdDays) ||
      input.thresholdDays < MIN_DAYS ||
      input.thresholdDays > MAX_DAYS
    ) {
      throw new BadRequestException(
        `The dead-stock threshold must be between ${MIN_DAYS} and ${MAX_DAYS} days.`,
      );
    }
    const warn = input.warnAfterDays ?? null;
    if (warn != null) {
      if (!Number.isInteger(warn) || warn < MIN_DAYS) {
        throw new BadRequestException('The warning band must be a whole number of days.');
      }
      // A warning that fires after the piece is already dead is not a warning.
      if (warn >= input.thresholdDays) {
        throw new BadRequestException(
          `The warning must come BEFORE the ${input.thresholdDays}-day threshold, not after it.`,
        );
      }
    }

    /*
     * findFirst-then-write rather than upsert.
     *
     * Prisma's compound-unique input will not take a null for `category`, and
     * the tenant default IS the null row. The database still holds the line: the
     * partial unique index on (organisationId) WHERE category IS NULL means a
     * simultaneous second create loses with P2002 rather than producing two
     * contradictory defaults.
     */
    const existing = await this.prisma.deadStockPolicy.findFirst({
      where: { organisationId: user.organisationId, category },
      select: { id: true },
    });
    const data = {
      thresholdDays: input.thresholdDays,
      warnAfterDays: warn,
      updatedById: user.id,
    };
    const row = existing
      ? await this.prisma.deadStockPolicy.update({ where: { id: existing.id }, data })
      : await this.prisma.deadStockPolicy.create({
          data: { organisationId: user.organisationId, category, ...data },
        });

    await this.audit.record(user, {
      action: 'stock.dead_stock_policy_changed',
      entityType: 'DeadStockPolicy',
      entityId: row.id,
      summary: `${category ?? 'Everything else'} counts as dead after ${row.thresholdDays} days`,
      metadata: { category, thresholdDays: row.thresholdDays, warnAfterDays: row.warnAfterDays },
    });
    return this.policyFor(user.organisationId);
  }

  async clearRule(user: AuthUser, category?: string | null) {
    const parsed = this.parseCategory(category);
    await this.prisma.deadStockPolicy.deleteMany({
      where: { organisationId: user.organisationId, category: parsed },
    });
    await this.audit.record(user, {
      action: 'stock.dead_stock_policy_cleared',
      entityType: 'DeadStockPolicy',
      entityId: user.organisationId,
      summary: `Removed the dead-stock rule for ${parsed ?? 'everything else'}`,
    });
    return this.policyFor(user.organisationId);
  }

  private parseCategory(value?: string | null): ProductCategory | null {
    if (value == null || value === '' || value === 'default') return null;
    if (!(Object.values(ProductCategory) as string[]).includes(value)) {
      throw new BadRequestException(`"${value}" is not a category.`);
    }
    return value as ProductCategory;
  }

  // ==========================================================================
  // The dead-stock list
  // ==========================================================================

  /**
   * Pieces that are past their category's threshold, worst first.
   *
   * Grouped by the rule that condemned them, because "these 40 rings are dead at
   * 90 days and these 12 bridal sets at 365" is actionable and "52 dead pieces"
   * is not.
   *
   * ── Views (Block 9) ─────────────────────────────────────────────────────────
   *
   * `stock` (the default) is ordinary merchandise — the list a manager discounts
   * from, and the only one whose count is "dead stock" on the summary card.
   * `customised` is made-to-order and customer pieces: old, but not the shop's to
   * sell to somebody else. `remake` is whatever a person has marked worth
   * remaking. `excluded` is display and sample pieces, which are not stock at
   * all. The four bucket counts come back with every view, so switching views
   * never hides that the others exist.
   */
  async list(user: AuthUser, opts: DeadStockListOptions = {}) {
    const rule = await this.resolverFor(user.organisationId);
    const category = opts.category ? this.parseCategory(opts.category) : null;
    const view = opts.view ?? 'stock';
    if (!DEAD_STOCK_VIEWS.includes(view)) {
      throw new BadRequestException(`view must be one of: ${DEAD_STOCK_VIEWS.join(', ')}.`);
    }
    const stateFilter = opts.state ?? (opts.includeWarning ? 'ageing' : 'dead');
    if (!DEAD_STOCK_STATES.includes(stateFilter)) {
      throw new BadRequestException(`state must be one of: ${DEAD_STOCK_STATES.join(', ')}.`);
    }
    const take = Math.min(Math.max(opts.limit ?? 200, 1), opts.maxLimit ?? 500);

    /*
     * The whole scope in one slim pass, not the oldest N.
     *
     * With a threshold per category, the oldest piece is not the most overdue
     * one: a 100-day chain at 45 is further gone than a 300-day necklace at 365.
     * Reading the oldest 500 and sorting those was the right shortcut with one
     * threshold and is the wrong one with several. The stock summary already
     * reads the same set, so this costs nothing that screen does not.
     */
    const rows = await this.prisma.stockItem.findMany({
      where: {
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user, opts.storeId),
        status: { in: ['in_stock', 'aging', 'dead_stock', 'reserved'] },
        ...(category ? { category } : {}),
      },
      select: {
        id: true, sku: true, name: true, vin: true, styleNumber: true,
        category: true, inwardDate: true, ageDays: true, tagPrice: true,
        stockClass: true, remakeSuitable: true,
        storeId: true, store: { select: { name: true } },
        product: { select: { category: true, styleNumber: true, stockClass: true } },
      },
    });

    const now = Date.now();
    const all = rows.map((r) => {
      const cat = r.category && r.category !== 'other' ? r.category : (r.product?.category ?? r.category);
      const applied = rule(cat);
      const age = liveAgeDays(r, now);
      const state =
        age > applied.thresholdDays
          ? ('dead' as const)
          : applied.warnAfterDays != null && age > applied.warnAfterDays
            ? ('ageing' as const)
            : ('fresh' as const);
      const stockClass = effectiveStockClass(r);
      return {
        id: r.id,
        sku: r.sku ?? '',
        vin: r.vin,
        styleNumber: r.styleNumber ?? r.product?.styleNumber ?? null,
        name: r.name ?? '',
        category: cat,
        storeId: r.storeId,
        storeName: r.store?.name ?? '',
        ageDays: age,
        thresholdDays: applied.thresholdDays,
        warnAfterDays: applied.warnAfterDays,
        /** How far past the line, so a list can be sorted by "worst first". */
        daysOver: Math.max(0, age - applied.thresholdDays),
        state,
        tagPrice: r.tagPrice != null ? Number(r.tagPrice) : 0,
        stockClass,
        /** Whether the piece says so itself, or inherits it from its design. */
        stockClassSource: r.stockClass ? ('piece' as const) : ('design' as const),
        remakeSuitable: r.remakeSuitable,
        suggestion: suggestionFor(state, stockClass, r.remakeSuitable),
      };
    });

    const dead = all.filter((r) => r.state === 'dead');
    const inView = all
      .filter((r) => inDeadStockView(view, r))
      .filter((r) =>
        stateFilter === 'all' ? true : stateFilter === 'ageing' ? r.state !== 'fresh' : r.state === 'dead',
      )
      .sort((a, b) => b.daysOver - a.daysOver || b.ageDays - a.ageDays);

    return {
      view,
      items: inView.slice(0, take),
      /*
       * Counted from the SAME pass that produced the list, over the whole view
       * rather than the page shown, so the headline agrees with the summary
       * card even when the table is truncated — and `truncated` says it is.
       */
      dead: inView.filter((r) => r.state === 'dead').length,
      ageing: inView.filter((r) => r.state === 'ageing').length,
      value: Math.round(inView.reduce((sum, r) => sum + r.tagPrice, 0)),
      total: inView.length,
      truncated: inView.length > take,
      /** Dead pieces per view, whichever view is open. */
      buckets: {
        stock: dead.filter((r) => inDeadStockView('stock', r)).length,
        customised: dead.filter((r) => inDeadStockView('customised', r)).length,
        remake: dead.filter((r) => inDeadStockView('remake', r)).length,
        excluded: dead.filter((r) => inDeadStockView('excluded', r)).length,
      },
    };
  }

  /**
   * The dead-stock list as a workbook, classification and all.
   *
   * Same list, same view, same numbers — a report that recomputed "dead" its own
   * way would eventually disagree with the screen it was exported from.
   */
  async exportWorkbook(user: AuthUser, opts: DeadStockListOptions = {}) {
    const res = await this.list(user, { ...opts, limit: EXPORT_MAX_ROWS, maxLimit: EXPORT_MAX_ROWS });

    const wb = new Workbook();
    wb.creator = 'CaratSense';
    wb.created = new Date();
    const ws = wb.addWorksheet('Dead stock', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Piece', key: 'name', width: 32 },
      { header: 'SKU', key: 'sku', width: 18 },
      { header: 'VIN', key: 'vin', width: 14 },
      { header: 'Style number', key: 'styleNumber', width: 16 },
      { header: 'Category', key: 'category', width: 12 },
      { header: 'Branch', key: 'storeName', width: 22 },
      { header: 'Classification', key: 'classification', width: 28 },
      { header: 'Classified on', key: 'source', width: 14 },
      { header: 'Suitable for remaking', key: 'remake', width: 12 },
      { header: 'Days in stock', key: 'ageDays', width: 12 },
      { header: 'Threshold (days)', key: 'thresholdDays', width: 12 },
      { header: 'Days over', key: 'daysOver', width: 10 },
      { header: 'State', key: 'state', width: 10 },
      { header: 'Suggested action', key: 'suggestion', width: 18 },
      { header: 'Tag price', key: 'tagPrice', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of res.items) {
      ws.addRow({
        ...r,
        vin: r.vin ?? '',
        styleNumber: r.styleNumber ?? '',
        classification: STOCK_CLASS_LABEL[r.stockClass],
        source: r.stockClassSource === 'piece' ? 'This piece' : 'Its design',
        remake: r.remakeSuitable ? 'Yes' : 'No',
        suggestion: r.suggestion ? SUGGESTION_LABEL[r.suggestion] : '',
      });
    }
    if (res.truncated) {
      // In the file itself, where the reader is: a short workbook that does not
      // say it is short reads as the whole answer.
      ws.addRow({
        name: `Only the worst ${res.items.length} of ${res.total} rows are in this file. Narrow by branch or category for the rest.`,
      });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    await this.audit.record(user, {
      action: 'stock.dead_stock_exported',
      entityType: 'dead_stock_export',
      entityId: `${user.organisationId}:${stamp}`,
      storeId: opts.storeId ?? null,
      summary: `Exported ${res.items.length} dead-stock row(s) (${res.view})`,
      metadata: { rows: res.items.length, truncated: res.truncated, view: res.view, state: opts.state ?? null },
    });

    return {
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      filename: `dead-stock-${res.view}-${stamp}.xlsx`,
      rows: res.items.length,
      truncated: res.truncated,
    };
  }

  // ==========================================================================
  // Classification
  // ==========================================================================

  /**
   * Classify one piece, or mark it worth remaking.
   *
   * `stockClass: null` returns the piece to whatever its design is. Only the
   * fields sent change: marking a piece for remaking must not quietly reset a
   * classification somebody else set.
   */
  async classifyPiece(
    user: AuthUser,
    stockItemId: string,
    input: { stockClass?: string | null; remakeSuitable?: boolean },
  ) {
    const item = await this.prisma.stockItem.findFirst({
      where: { id: stockItemId, ...this.scope.orgFilter(user) },
      select: { id: true, sku: true, storeId: true, stockClass: true, remakeSuitable: true },
    });
    // Not found for another tenant's id, and for a branch outside scope the
    // scope check below refuses it — the same two answers every piece route gives.
    if (!item) throw new NotFoundException('No such piece here.');
    this.scope.assertStoreAllowed(user, item.storeId);

    const data: { stockClass?: StockClass | null; remakeSuitable?: boolean } = {};
    if (input.stockClass !== undefined) data.stockClass = this.parseClass(input.stockClass, true);
    if (input.remakeSuitable !== undefined) data.remakeSuitable = input.remakeSuitable;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Send a stockClass, remakeSuitable, or both.');
    }

    const updated = await this.prisma.stockItem.update({
      where: { id: item.id },
      data,
      select: {
        id: true, stockClass: true, remakeSuitable: true,
        product: { select: { stockClass: true } },
      },
    });
    await this.audit.record(user, {
      action: 'stock.classified',
      entityType: 'StockItem',
      entityId: item.id,
      storeId: item.storeId,
      summary: `${item.sku ?? item.id}: ${STOCK_CLASS_LABEL[effectiveStockClass(updated)]}${
        updated.remakeSuitable ? ', suitable for remaking' : ''
      }`,
      metadata: {
        from: { stockClass: item.stockClass, remakeSuitable: item.remakeSuitable },
        to: { stockClass: updated.stockClass, remakeSuitable: updated.remakeSuitable },
      },
    });
    return {
      id: updated.id,
      stockClass: effectiveStockClass(updated),
      stockClassSource: updated.stockClass ? 'piece' : 'design',
      remakeSuitable: updated.remakeSuitable,
    };
  }

  /**
   * Classify a design. Every piece of it that has no classification of its own
   * follows. Head office only, because it changes what every branch may sell.
   */
  async classifyProduct(user: AuthUser, productId: string, stockClass: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organisationId: user.organisationId },
      select: { id: true, sku: true, stockClass: true },
    });
    if (!product) throw new NotFoundException('No such design here.');
    const to = this.parseClass(stockClass, false)!;
    await this.prisma.product.update({ where: { id: product.id }, data: { stockClass: to } });
    await this.audit.record(user, {
      action: 'catalogue.classified',
      entityType: 'Product',
      entityId: product.id,
      summary: `${product.sku}: ${STOCK_CLASS_LABEL[to]}`,
      metadata: { from: product.stockClass, to },
    });
    return { id: product.id, stockClass: to };
  }

  private parseClass(value: string | null, allowNull: boolean): StockClass | null {
    if (value == null || value === '') {
      if (allowNull) return null;
      throw new BadRequestException('Give a classification.');
    }
    if (!(STOCK_CLASSES as string[]).includes(value)) {
      throw new BadRequestException(`stockClass must be one of: ${STOCK_CLASSES.join(', ')}.`);
    }
    return value as StockClass;
  }

  // ==========================================================================
  // VIN
  // ==========================================================================

  /**
   * Issue a VIN for one piece.
   *
   * Idempotent: a piece that already has one keeps it. Re-issuing would make the
   * number on the physical tag point at nothing, which is the only way a piece
   * identifier can actually fail.
   */
  async issue(user: AuthUser, stockItemId: string) {
    const item = await this.prisma.stockItem.findFirst({
      where: { id: stockItemId, ...this.scope.orgFilter(user) },
      select: { id: true, vin: true, storeId: true, sku: true },
    });
    if (!item) throw new BadRequestException('No such piece here.');
    this.scope.assertStoreAllowed(user, item.storeId);
    if (item.vin) return { vin: item.vin, issued: false };

    const vin = await this.mint(user.organisationId);
    await this.prisma.stockItem.update({ where: { id: item.id }, data: { vin } });
    await this.audit.record(user, {
      action: 'stock.vin_issued',
      entityType: 'StockItem',
      entityId: item.id,
      storeId: item.storeId,
      summary: `Issued ${vin}`,
      metadata: { sku: item.sku },
    });
    return { vin, issued: true };
  }

  /**
   * Issue VINs for every piece in scope that has none.
   *
   * Bounded per call and reported honestly: a tenant with 40,000 untagged pieces
   * gets a number back and runs it again, rather than one request that either
   * times out or silently does a fraction of the job.
   */
  async issueMissing(user: AuthUser, opts: { storeId?: string; limit?: number } = {}) {
    const take = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
    const pending = await this.prisma.stockItem.findMany({
      where: {
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user, opts.storeId),
        vin: null,
      },
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true },
    });

    let issued = 0;
    for (const row of pending) {
      const vin = await this.mint(user.organisationId);
      /*
       * updateMany with `vin: null` in the WHERE, not update.
       *
       * Two managers pressing this at once would otherwise both write to the
       * same row and the second would overwrite a number the first had already
       * printed. This way the loser changes nothing and the piece keeps the VIN
       * that is on its tag.
       */
      const res = await this.prisma.stockItem.updateMany({
        where: { id: row.id, vin: null },
        data: { vin },
      });
      if (res.count === 1) issued++;
    }

    const remaining = await this.prisma.stockItem.count({
      where: {
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user, opts.storeId),
        vin: null,
      },
    });

    if (issued > 0) {
      await this.audit.record(user, {
        action: 'stock.vins_issued',
        entityType: 'StockItem',
        entityId: opts.storeId ?? user.organisationId,
        storeId: opts.storeId ?? null,
        summary: `Issued ${issued} piece identifier(s)`,
        metadata: { issued, remaining },
      });
    }
    return { issued, remaining, examined: pending.length };
  }

  /** Find a piece by the number on its tag. */
  async lookup(user: AuthUser, vin: string) {
    const normalised = normaliseVin(vin);
    if (!normalised) throw new BadRequestException('Give a piece identifier to look up.');

    const item = await this.prisma.stockItem.findFirst({
      where: { ...this.scope.orgFilter(user), vin: normalised },
      select: {
        id: true, vin: true, sku: true, name: true, styleNumber: true, status: true,
        storeId: true, store: { select: { name: true } },
        inwardDate: true, ageDays: true, tagPrice: true, huid: true,
        product: { select: { id: true, name: true, styleNumber: true, imageUrl: true } },
      },
    });
    if (!item) {
      // Said as a fact about this tenant's catalogue, not as a validation error:
      // the number may be perfectly well-formed and belong to a piece that was
      // sold, transferred, or never entered.
      return { found: false as const, vin: normalised };
    }
    // Deliberately AFTER the lookup: a piece in another branch of the same
    // tenant is found and named. A person holding the tag needs to be told where
    // it belongs, not that it does not exist.
    return {
      found: true as const,
      ...item,
      ageDays: liveAgeDays(item, Date.now()),
      tagPrice: item.tagPrice != null ? Number(item.tagPrice) : 0,
      inScope: user.storeIds.includes(item.storeId),
    };
  }

  /**
   * A new identifier.
   *
   * `<year><6-digit sequence><check>` — short enough to read off a tag aloud,
   * long enough not to collide, and carrying a check character so a digit
   * transposed at the counter is rejected rather than quietly looked up as a
   * different piece.
   *
   * The sequence is per TENANT, not per store: a piece transferred between
   * branches keeps its number, so a per-store series would either renumber it or
   * lie about where it came from.
   */
  private async mint(organisationId: string): Promise<string> {
    const year = new Date().getUTCFullYear() % 100;
    const n = await this.sequence.next(`vin:${organisationId}`);
    const body = `${String(year).padStart(2, '0')}${String(n).padStart(6, '0')}`;
    return `${body}${checkCharacter(body)}`;
  }
}

/**
 * Aging from inwardDate, computed live.
 *
 * The stored `ageDays` is a snapshot written at import time and goes stale the
 * next morning. It is the fallback only — for a piece with no inward date there
 * is nothing better.
 */
function liveAgeDays(
  s: { inwardDate: Date | null; ageDays: number | null },
  now: number,
): number {
  if (s.inwardDate) {
    const days = Math.floor((now - s.inwardDate.getTime()) / 86_400_000);
    return days > 0 ? days : 0;
  }
  return s.ageDays ?? 0;
}

/** Uppercase, and free of the separators a person adds when reading one out. */
export function normaliseVin(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Damm-style check character over the digits.
 *
 * A plain sequence would accept `25000124` when the tag says `25000142` and
 * silently return a different ring. A weighted modulus catches every single-digit
 * error and every adjacent transposition, which between them are almost all the
 * mistakes made typing a number off a label.
 */
export function checkCharacter(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[i]);
    // Alternating weights: what makes a transposition change the total.
    sum += Number.isFinite(digit) ? digit * (i % 2 === 0 ? 3 : 1) : 0;
  }
  return CHECK_ALPHABET[sum % CHECK_ALPHABET.length];
}
