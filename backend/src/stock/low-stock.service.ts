import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma, Role } from '@prisma/client';

import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { businessDate, dateOnly, resolveTz } from '../common/tz.util';
import { tenantAllows } from '../config/entitlements';
import { updateOrgSettings } from '../config/org-settings';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ON_HAND, stockClassWhere } from './stock-class';

/**
 * Low stock: telling a branch, once, that a design it sells has run short.
 *
 * ── What "stock" means here ─────────────────────────────────────────────────
 *
 * Exactly what the catalogue card means by it: pieces `in_stock` / `aging` /
 * `dead_stock`, and only standard merchandise (a customised piece is somebody's
 * order and a display piece is not for sale). Both halves are imported from
 * `stock-class.ts` rather than restated here, because two different stock
 * numbers on two screens is worse than no alert at all.
 *
 * ── Which (design × branch) pairs are considered ────────────────────────────
 *
 * A branch hears about a design it is in the business of selling: one it has
 * SOLD from that counter, or one it is holding now. A piece that merely passed
 * through on a transfer proves no demand, and in production that distinction is
 * the difference between 1,349 pairs and 752 — the rest being branches that
 * once forwarded a piece and were never going to restock it.
 *
 * A piece whose branch Gati never named sits in the `unassigned` holding pen
 * (`Store.isHolding`). It counts toward NO branch's shelf: nobody works that
 * counter, so an alert there would be addressed to nobody — and counting it for
 * a real branch would be inventing stock that branch does not have. The "All
 * Stores" aggregate and attendance-only locations (Head Office) are left out
 * for the same reason.
 *
 * ── The default level ───────────────────────────────────────────────────────
 *
 * One. In production 1,310 of 1,368 (design × branch) pairs hold exactly one
 * piece; a default of two would call 2,364 of 2,402 pairs low, which is a list
 * nobody reads. At one, the alert says the honest thing — this branch has run
 * out of a design it sells — and a design worth holding deeper carries its own
 * `Product.reorderLevel`.
 */

/** What a tenant that has configured nothing gets. See the note above. */
export const DEFAULT_LOW_STOCK_LEVEL = 1;

const SETTINGS_KEY = 'lowStockAlerts';
const MIN_LEVEL = 1;
const MAX_LEVEL = 999;

/** The module this belongs to; a tenant without inventory is never swept. */
const INVENTORY_CAPABILITY = 'inventory';

/**
 * How many designs one branch's notification names.
 *
 * The rest are a count with the full list one tap away. A bell with 223 rows in
 * it — Udaipur's day-one figure — is not information, and naming the first few
 * plus "and 218 more" is both shorter and truer.
 */
const NAMED_IN_NOTIFICATION = 5;

/** The screen's page, and the hard cap behind it. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export interface LowStockSettings {
  /** Pieces a branch should hold of any design without its own level. */
  defaultLevel: number;
}

/** One design, short at one branch. */
export interface LowStockRow {
  productId: string;
  sku: string;
  name: string;
  styleNumber: string | null;
  storeId: string;
  storeName: string;
  onHand: number;
  level: number;
  /** Whose number this is — the design's own override, or the tenant default. */
  levelSource: 'design' | 'default';
  /** Pieces at the OTHER branches in view: a transfer rather than a reorder. */
  elsewhere: number;
  /** When somebody was first told, or null when the sweep has not run on it yet. */
  alertedSince: string | null;
}

/** A pair the sweep and the screen both work from, so they cannot disagree. */
interface Shortfall {
  productId: string;
  storeId: string;
  onHand: number;
  level: number;
  levelSource: 'design' | 'default';
}

/** One design × one branch, as a map key. */
export function pairKey(productId: string, storeId: string): string {
  return `${productId}|${storeId}`;
}

/** The design's own level when it has one, otherwise the tenant's. */
export function levelFor(reorderLevel: number | null | undefined, defaultLevel: number): number {
  return reorderLevel != null && reorderLevel >= MIN_LEVEL ? reorderLevel : defaultLevel;
}

/**
 * What changed since the last sweep.
 *
 * `opened` is told to somebody; `resolved` is not. Nobody needs a notification
 * saying a shelf is back to normal — they restocked it, they know — but the row
 * has to close, because closing it is what allows the same design to alert again
 * the next time it runs out.
 */
export function shortfallDiff(
  short: ReadonlySet<string>,
  open: ReadonlySet<string>,
): { opened: string[]; resolved: string[] } {
  return {
    opened: [...short].filter((k) => !open.has(k)),
    resolved: [...open].filter((k) => !short.has(k)),
  };
}

/**
 * What one branch's notification says.
 *
 * Named designs first, then the count that did not fit, then — when it applies
 * — the fact that pieces are sitting at another branch, because that turns a
 * reorder into a transfer and is the cheaper answer.
 */
export function describeShortfall(
  storeName: string,
  designs: { name: string; elsewhere: number }[],
  named = NAMED_IN_NOTIFICATION,
): { title: string; body: string } {
  const title =
    designs.length === 1
      ? `${designs[0].name} has run low at ${storeName}`
      : `${designs.length} designs are below their reorder level at ${storeName}`;

  const shown = designs.slice(0, named).map((d) => d.name);
  const rest = designs.length - shown.length;
  const list = shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');

  const atOthers = designs.filter((d) => d.elsewhere > 0).length;
  const transferable =
    atOthers === 0
      ? ''
      : designs.length === 1
        ? ' There are pieces of it at another branch.'
        : atOthers === designs.length
          ? ' All of them have pieces at another branch.'
          : ` ${atOthers} of them ${atOthers === 1 ? 'has' : 'have'} pieces at another branch.`;
  return { title, body: `${list}.${transferable}` };
}

@Injectable()
export class LowStockService {
  private readonly log = new Logger(LowStockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  // ==========================================================================
  // The level
  // ==========================================================================

  async settings(organisationId: string): Promise<LowStockSettings> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const raw = asObject(asObject(org?.settings)[SETTINGS_KEY]);
    const level = Number(raw.defaultLevel);
    return {
      defaultLevel:
        Number.isInteger(level) && level >= MIN_LEVEL && level <= MAX_LEVEL
          ? level
          : DEFAULT_LOW_STOCK_LEVEL,
    };
  }

  async saveSettings(user: AuthUser, input: LowStockSettings): Promise<LowStockSettings> {
    const next: LowStockSettings = { defaultLevel: this.parseLevel(input.defaultLevel) };
    await updateOrgSettings(this.prisma, user.organisationId, (s) => ({ ...s, [SETTINGS_KEY]: next }));
    await this.audit.record(user, {
      action: 'stock.low_stock_level_changed',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: `A branch should hold at least ${next.defaultLevel} piece(s) of a design it sells`,
      metadata: next,
    });
    return next;
  }

  /** The design's own level. Null puts it back on the tenant's default. */
  async setLevel(user: AuthUser, productId: string, level: number | null) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organisationId: user.organisationId },
      select: { id: true, name: true, sku: true },
    });
    if (!product) throw new NotFoundException('Design not found');

    const reorderLevel = level == null ? null : this.parseLevel(level);
    await this.prisma.product.update({ where: { id: product.id }, data: { reorderLevel } });
    await this.audit.record(user, {
      action: 'stock.reorder_level_changed',
      entityType: 'Product',
      entityId: product.id,
      summary:
        reorderLevel == null
          ? `${product.name} follows the default reorder level`
          : `${product.name}: every branch that sells it should hold ${reorderLevel}`,
      metadata: { sku: product.sku, reorderLevel },
    });
    return { productId: product.id, reorderLevel };
  }

  private parseLevel(value: number): number {
    if (!Number.isInteger(value) || value < MIN_LEVEL || value > MAX_LEVEL) {
      throw new BadRequestException(
        `A reorder level must be a whole number between ${MIN_LEVEL} and ${MAX_LEVEL}.`,
      );
    }
    return value;
  }

  // ==========================================================================
  // The screen
  // ==========================================================================

  /**
   * What is below its level right now, worst first.
   *
   * Computed live rather than read from `LowStockAlert`, because the alert row
   * records what the sweep SAID and this screen has to show what is true: a
   * piece inwarded an hour ago must not still be listed as missing. The rows are
   * joined to the alert only for "told since", so somebody can see how long a
   * gap has been open.
   */
  async list(user: AuthUser, opts: { storeId?: string; limit?: number } = {}) {
    const { defaultLevel } = await this.settings(user.organisationId);
    const stores = await this.tradingStores(
      user.organisationId,
      this.scope.effectiveStoreIds(user, opts.storeId),
    );
    const take = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    if (!stores.length) {
      return { defaultLevel, rows: [] as LowStockRow[], total: 0, truncated: false };
    }

    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    const { short, onHandByProduct } = await this.shortfalls(
      user.organisationId,
      stores.map((s) => s.id),
      defaultLevel,
    );
    if (!short.length) {
      return { defaultLevel, rows: [] as LowStockRow[], total: 0, truncated: false };
    }

    const productIds = [...new Set(short.map((s) => s.productId))];
    const [products, alerts] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, name: true, styleNumber: true },
      }),
      this.prisma.lowStockAlert.findMany({
        where: { organisationId: user.organisationId, productId: { in: productIds }, resolvedAt: null },
        select: { productId: true, storeId: true, firstAlertedAt: true },
      }),
    ]);
    const productOf = new Map(products.map((p) => [p.id, p]));
    const alertedSince = new Map(
      alerts.map((a) => [pairKey(a.productId, a.storeId), a.firstAlertedAt.toISOString()]),
    );

    const rows: LowStockRow[] = short.map((s) => {
      const p = productOf.get(s.productId);
      return {
        productId: s.productId,
        sku: p?.sku ?? '',
        name: p?.name ?? s.productId,
        styleNumber: p?.styleNumber ?? null,
        storeId: s.storeId,
        storeName: storeName.get(s.storeId) ?? s.storeId,
        onHand: s.onHand,
        level: s.level,
        levelSource: s.levelSource,
        elsewhere: Math.max(0, (onHandByProduct.get(s.productId) ?? 0) - s.onHand),
        alertedSince: alertedSince.get(pairKey(s.productId, s.storeId)) ?? null,
      };
    });

    /*
     * Worst first means the deepest shortfall, and within that the design
     * nobody else can supply: a design missing everywhere has to be ordered,
     * while one sitting at another branch is a transfer somebody can do today.
     */
    rows.sort(
      (a, b) =>
        b.level - b.onHand - (a.level - a.onHand) ||
        a.elsewhere - b.elsewhere ||
        a.name.localeCompare(b.name),
    );

    return {
      defaultLevel,
      rows: rows.slice(0, take),
      total: rows.length,
      truncated: rows.length > take,
    };
  }

  // ==========================================================================
  // The sweep
  // ==========================================================================

  /**
   * Once a day, in the branches' own morning.
   *
   * A sweep rather than a check on every stock write: the Gati sync rewrites
   * thousands of pieces every cycle, so a write-triggered check would fire all
   * day and would fire mid-sync, on a half-written picture of the shelf. 10:30
   * is after the shop has opened and while somebody can still act on it.
   */
  @Cron('0 30 10 * * *', { name: 'stock.low-stock.sweep', timeZone: 'Asia/Kolkata' })
  async scheduledSweep(): Promise<void> {
    if ((this.config.get<string>('SCHEDULER_ENABLED') ?? 'true') === 'false') return;
    try {
      const res = await this.sweep();
      if (res.opened || res.resolved) {
        this.log.log(
          `Low stock: ${res.opened} opened, ${res.resolved} recovered, ${res.notified} branch(es) told`,
        );
      }
    } catch (e) {
      this.log.error(`Low-stock sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async sweep(now = new Date()) {
    const orgs = await this.prisma.organisation.findMany({
      where: { status: { in: ['active', 'onboarding'] } },
      select: { id: true, industryPackCode: true, disabledCapabilities: true },
    });

    const totals = { organisations: 0, opened: 0, resolved: 0, notified: 0 };
    for (const org of orgs) {
      // A tenant whose industry has no inventory module has no shelf to be
      // short of — the same gate the API applies to /stock.
      if (!tenantAllows(org.industryPackCode, org.disabledCapabilities, INVENTORY_CAPABILITY)) {
        continue;
      }
      try {
        const res = await this.sweepOrganisation(org.id, now);
        totals.organisations++;
        totals.opened += res.opened;
        totals.resolved += res.resolved;
        totals.notified += res.notified;
      } catch (e) {
        // One tenant's bad data must not stop the others being swept.
        this.log.warn(
          `Low-stock sweep for ${org.id} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return totals;
  }

  private async sweepOrganisation(organisationId: string, now: Date) {
    const { defaultLevel } = await this.settings(organisationId);
    const stores = await this.tradingStores(organisationId);
    if (!stores.length) return { opened: 0, resolved: 0, notified: 0 };

    const { short, onHandByProduct } = await this.shortfalls(
      organisationId,
      stores.map((s) => s.id),
      defaultLevel,
    );
    const shortByKey = new Map(short.map((s) => [pairKey(s.productId, s.storeId), s]));

    /*
     * Every row this tenant has, open or closed — not only the open ones. A pair
     * that recovered last month and has run out again has to be REOPENED, and
     * `(productId, storeId)` is unique, so a blind create would fail on it.
     */
    const rows = await this.prisma.lowStockAlert.findMany({
      where: { organisationId },
      select: { id: true, productId: true, storeId: true, resolvedAt: true },
    });
    const existing = new Map(rows.map((r) => [pairKey(r.productId, r.storeId), r]));
    const open = new Set(rows.filter((r) => !r.resolvedAt).map((r) => pairKey(r.productId, r.storeId)));

    const { opened, resolved } = shortfallDiff(new Set(shortByKey.keys()), open);

    const toCreate = opened.filter((k) => !existing.has(k));
    const toReopen = opened.filter((k) => existing.has(k));

    if (toCreate.length) {
      await this.prisma.lowStockAlert.createMany({
        data: toCreate.map((k) => {
          const s = shortByKey.get(k)!;
          return {
            organisationId,
            productId: s.productId,
            storeId: s.storeId,
            level: s.level,
            onHand: s.onHand,
            firstAlertedAt: now,
          };
        }),
        // A second replica sweeping the same minute loses the insert rather than
        // the run; the notification's dedupe key collapses its bell entry too.
        skipDuplicates: true,
      });
    }
    for (const k of toReopen) {
      const s = shortByKey.get(k)!;
      await this.prisma.lowStockAlert.updateMany({
        // Conditional on it still being closed, so a concurrent sweep reopening
        // the same pair does not reset a date that is already correct.
        where: { productId: s.productId, storeId: s.storeId, resolvedAt: { not: null } },
        data: { level: s.level, onHand: s.onHand, firstAlertedAt: now, resolvedAt: null },
      });
    }
    if (resolved.length) {
      await this.prisma.lowStockAlert.updateMany({
        where: { id: { in: resolved.map((k) => existing.get(k)!.id) }, resolvedAt: null },
        data: { resolvedAt: now },
      });
    }

    const notified = await this.notifyBranches(
      organisationId,
      stores,
      opened.map((k) => shortByKey.get(k)!),
      onHandByProduct,
      now,
    );
    return { opened: opened.length, resolved: resolved.length, notified };
  }

  /**
   * Tell each branch about its own shelf, once.
   *
   * Recipients are resolved the way the follow-up reminder resolves them:
   * `recipientsFor(storeId, store_manager)` reaches the managers attached to
   * THIS branch and head office, and nobody else — the manager at Borivali is
   * not told that Bandra is short, because it is not their shelf and they
   * cannot act on it.
   *
   * One notification per branch, not one per design: Udaipur's first sweep opens
   * 223 of them, and 223 separate bells is how somebody turns the bell off. The
   * row-per-pair above is still the de-duplication, so a design is named (or
   * counted) exactly once until it recovers.
   */
  private async notifyBranches(
    organisationId: string,
    stores: { id: string; name: string; timezone: string }[],
    opened: Shortfall[],
    onHandByProduct: Map<string, number>,
    now: Date,
  ): Promise<number> {
    if (!opened.length) return 0;

    const products = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(opened.map((s) => s.productId))] } },
      select: { id: true, name: true, styleNumber: true },
    });
    const nameOf = new Map(products.map((p) => [p.id, p.styleNumber ?? p.name]));

    let notified = 0;
    for (const store of stores) {
      const mine = opened.filter((s) => s.storeId === store.id);
      if (!mine.length) continue;

      const told = await this.notifications.recipientsFor(
        store.id,
        Role.store_manager,
        undefined,
        organisationId,
      );
      if (!told.length) {
        // A branch with no manager and no head office behind it: the screen
        // still shows the shortfall, and the row still stops it being re-asked.
        this.log.warn(`Low stock at ${store.name}: nobody to tell`);
        continue;
      }

      const designs = mine.map((s) => ({
        name: nameOf.get(s.productId) ?? s.productId,
        elsewhere: Math.max(0, (onHandByProduct.get(s.productId) ?? 0) - s.onHand),
      }));
      const { title, body } = describeShortfall(store.name, designs);
      await this.notifications.emit(told, {
        kind: 'low_stock',
        title,
        body,
        // The Reorder tab, where the list and the request to fix it live together.
        href: '/inventory#reorder',
        storeId: store.id,
        entityType: 'Store',
        entityId: store.id,
        // Deliberately not `high`: a gap on the shelf is work for today, not an
        // interruption, and an alert that shouts every morning stops being read.
        priority: 'normal',
        // Per branch per branch-local day, so a re-run (a restart, a second
        // replica) refreshes the one entry instead of stacking copies.
        dedupeKey: `low-stock:${store.id}:${dateOnly(businessDate(now, resolveTz(store.timezone)))}`,
      });
      notified++;
    }
    return notified;
  }

  // ==========================================================================
  // Counting
  // ==========================================================================

  /**
   * The branches a shelf alert can be about.
   *
   * The holding pen (`isHolding`) is where pieces Gati gave no branch for land —
   * 3,512 of them in production. Nobody stands at that counter, so it is never
   * alerted on and its pieces count toward no branch's shelf; they are a
   * mapping correction, not stock. The "All Stores" aggregate is not a place,
   * and Head Office is attendance-only — it sells nothing.
   */
  private async tradingStores(organisationId: string, within?: string[]) {
    return this.prisma.store.findMany({
      where: {
        organisationId,
        isActive: true,
        isAggregate: false,
        isHolding: false,
        attendanceOnly: false,
        ...(within ? { id: { in: within } } : {}),
      },
      select: { id: true, name: true, timezone: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Every (design × branch) pair below its level, in three queries.
   *
   * Grouped in the database rather than counted here: 6,583 pieces would
   * otherwise cross the wire on every sweep and every time the screen opens.
   */
  private async shortfalls(
    organisationId: string,
    storeIds: string[],
    defaultLevel: number,
  ): Promise<{ short: Shortfall[]; onHandByProduct: Map<string, number> }> {
    const merchandise: Prisma.StockItemWhereInput = {
      organisationId,
      storeId: { in: storeIds },
      productId: { not: null },
      // The catalogue's definition of sellable stock, not a second one.
      ...stockClassWhere('standard'),
    };

    const [onHand, soldHere, overrides] = await Promise.all([
      this.prisma.stockItem.groupBy({
        by: ['productId', 'storeId'],
        where: { ...merchandise, status: { in: ON_HAND } },
        _count: { _all: true },
      }),
      // Demand at THIS counter. A design a branch has sold is one it is in the
      // business of selling; one that only passed through on a transfer is not.
      this.prisma.stockItem.groupBy({
        by: ['productId', 'storeId'],
        where: { ...merchandise, status: 'sold' },
        _count: { _all: true },
      }),
      this.prisma.product.findMany({
        where: { organisationId, reorderLevel: { not: null } },
        select: { id: true, reorderLevel: true },
      }),
    ]);

    const onHandByPair = new Map<string, number>();
    const onHandByProduct = new Map<string, number>();
    for (const g of onHand) {
      if (!g.productId) continue;
      onHandByPair.set(pairKey(g.productId, g.storeId), g._count._all);
      onHandByProduct.set(g.productId, (onHandByProduct.get(g.productId) ?? 0) + g._count._all);
    }
    const levelOf = new Map(overrides.map((p) => [p.id, p.reorderLevel]));

    // Considered: sold here at least once, or on the shelf here now. Nothing
    // else — a design this branch has never had and never sold is not a gap.
    const pairs = new Map<string, { productId: string; storeId: string }>();
    for (const g of [...onHand, ...soldHere]) {
      if (!g.productId) continue;
      pairs.set(pairKey(g.productId, g.storeId), { productId: g.productId, storeId: g.storeId });
    }

    const short: Shortfall[] = [];
    for (const [key, pair] of pairs) {
      const override = levelOf.get(pair.productId) ?? null;
      const level = levelFor(override, defaultLevel);
      const held = onHandByPair.get(key) ?? 0;
      if (held >= level) continue;
      short.push({
        ...pair,
        onHand: held,
        level,
        levelSource: override != null ? 'design' : 'default',
      });
    }
    return { short, onHandByProduct };
  }
}

/** The settings bag, as `Organisation.settings` can honestly hold it. */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
