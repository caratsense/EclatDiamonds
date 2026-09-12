import { BadRequestException, Injectable } from '@nestjs/common';
import { ProductCategory } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { SequenceService } from '../common/sequence.service';

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
   * Pieces that are past their category's threshold, oldest first.
   *
   * Grouped by the rule that condemned them, because "these 40 rings are dead at
   * 90 days and these 12 bridal sets at 365" is actionable and "52 dead pieces"
   * is not.
   */
  async list(
    user: AuthUser,
    opts: { storeId?: string; category?: string; limit?: number; includeWarning?: boolean } = {},
  ) {
    const rule = await this.resolverFor(user.organisationId);
    const category = opts.category ? this.parseCategory(opts.category) : null;

    const rows = await this.prisma.stockItem.findMany({
      where: {
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user, opts.storeId),
        status: { in: ['in_stock', 'aging', 'dead_stock', 'reserved'] },
        ...(category ? { category } : {}),
      },
      orderBy: { inwardDate: 'asc' },
      // Bounded: this is a screen, and a tenant whose whole shelf is dead does
      // not need every row to learn that.
      take: Math.min(Math.max(opts.limit ?? 200, 1), 500),
      select: {
        id: true, sku: true, name: true, vin: true, styleNumber: true,
        category: true, inwardDate: true, ageDays: true, tagPrice: true,
        storeId: true, store: { select: { name: true } },
        product: { select: { category: true, styleNumber: true } },
      },
    });

    const now = Date.now();
    const out = rows
      .map((r) => {
        const cat = r.category && r.category !== 'other' ? r.category : (r.product?.category ?? r.category);
        const applied = rule(cat);
        const age = liveAgeDays(r, now);
        const state =
          age > applied.thresholdDays
            ? ('dead' as const)
            : applied.warnAfterDays != null && age > applied.warnAfterDays
              ? ('ageing' as const)
              : ('fresh' as const);
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
        };
      })
      .filter((r) => (opts.includeWarning ? r.state !== 'fresh' : r.state === 'dead'))
      .sort((a, b) => b.daysOver - a.daysOver);

    return {
      items: out,
      /*
       * Counted from the SAME pass that produced the list, so the headline and
       * the rows cannot disagree. A count computed separately over a different
       * filter is how a screen ends up saying 52 above a table of 40.
       */
      dead: out.filter((r) => r.state === 'dead').length,
      ageing: out.filter((r) => r.state === 'ageing').length,
      value: Math.round(out.reduce((sum, r) => sum + r.tagPrice, 0)),
      truncated: rows.length >= Math.min(Math.max(opts.limit ?? 200, 1), 500),
    };
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
