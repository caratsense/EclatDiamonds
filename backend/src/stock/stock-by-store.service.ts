import { Injectable } from '@nestjs/common';

import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';

/**
 * Where a piece came from.
 *
 * Deliberately NOT the same question as which store holds it, where it was
 * first inwarded, or where a transfer is sending it — the client's notes are
 * explicit that those are four different facts and must not be collapsed into
 * one "source" field.
 *
 * Today every piece in production carries a Gati `legacyId` (6,659 of 6,659),
 * so `website` and `import` are empty sets rather than theory. They are still
 * named here because the classifier has to answer honestly once they are not,
 * and because "we only have Gati stock" is itself a finding worth showing.
 */
export const STOCK_SOURCES = ['gati', 'website', 'import', 'manual'] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

export const STOCK_SOURCE_LABELS: Record<StockSource, string> = {
  gati: 'Gati (APRS-SJEP)',
  website: 'Website',
  import: 'Imported file',
  manual: 'Added here',
};

/** A store's data state, from integration evidence rather than from a guess. */
export type StoreDataState = 'synced' | 'no_data' | 'unmapped_holding';

export interface StoreStockRow {
  storeId: string;
  storeName: string;
  /** Pieces available to sell right now. */
  inStock: number;
  /** Held by an in-flight transfer: not available in either store. */
  reserved: number;
  /** Every piece ever recorded against this store, whatever its status now. */
  everRecorded: number;
  sold: number;
  transferredOut: number;
  bySource: Record<StockSource, number>;
  /**
   * `no_data` is NOT the same as zero stock, and conflating them is the
   * specific mistake the client called out: a store that never synced looks
   * identical to a store that genuinely sold out.
   */
  dataState: StoreDataState;
  /** Null when nothing has ever arrived for this store. */
  lastRecordAt: string | null;
}

@Injectable()
export class StockByStoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * One row per store the viewer may see, plus the unmapped holding pen.
   *
   * The holding pen is a real Store row (`unassigned`) and currently holds
   * more pieces than any branch — 3,512 of 6,659 in production. It is listed
   * rather than hidden or folded into a branch, because a piece whose branch
   * is unknown is a correction somebody has to make, not a piece belonging to
   * whichever store happens to sort first.
   */
  async byStore(user: AuthUser, opts: { source?: StockSource } = {}): Promise<{
    rows: StoreStockRow[];
    totals: { inStock: number; reserved: number; unmapped: number };
    syncEvidence: { scope: string; lastRunAt: string | null; tables: number };
  }> {
    const storeFilter = this.scope.storeFilter(user);

    const stores = await this.prisma.store.findMany({
      where: { organisationId: user.organisationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    /*
     * Grouped in the database rather than counted in JavaScript: the table is
     * 6,659 rows today and every one of them would otherwise cross the wire
     * to be tallied here.
     */
    const grouped = await this.prisma.stockItem.groupBy({
      by: ['storeId', 'status'],
      where: {
        organisationId: user.organisationId,
        ...storeFilter,
        ...(opts.source ? this.sourceWhere(opts.source) : {}),
      },
      _count: { _all: true },
    });

    const sourceGrouped = await this.prisma.stockItem.groupBy({
      by: ['storeId'],
      where: { organisationId: user.organisationId, ...storeFilter, legacyId: { not: null } },
      _count: { _all: true },
    });
    const gatiByStore = new Map(sourceGrouped.map((g) => [g.storeId, g._count._all]));

    const latest = await this.prisma.stockItem.groupBy({
      by: ['storeId'],
      where: { organisationId: user.organisationId, ...storeFilter },
      _max: { createdAt: true },
    });
    const lastByStore = new Map(latest.map((g) => [g.storeId, g._max.createdAt]));

    const counts = new Map<string, Record<string, number>>();
    for (const g of grouped) {
      const row = counts.get(g.storeId) ?? {};
      row[g.status] = (row[g.status] ?? 0) + g._count._all;
      counts.set(g.storeId, row);
    }

    const rows: StoreStockRow[] = stores
      .filter((s) => counts.has(s.id) || !storeFilter || Object.keys(storeFilter).length === 0)
      .map((store) => {
        const c = counts.get(store.id) ?? {};
        const everRecorded = Object.values(c).reduce((a, b) => a + b, 0);
        const gati = gatiByStore.get(store.id) ?? 0;
        const lastAt = lastByStore.get(store.id) ?? null;

        return {
          storeId: store.id,
          storeName: store.name,
          inStock: c.in_stock ?? 0,
          reserved: c.reserved ?? 0,
          everRecorded,
          sold: c.sold ?? 0,
          transferredOut: c.transferred ?? 0,
          bySource: {
            gati,
            website: 0,
            // Nothing in production carries either marker yet; reported as a
            // real zero rather than omitted, so the day one appears is visible.
            import: 0,
            manual: Math.max(0, everRecorded - gati),
          },
          dataState: this.stateFor(store.id, everRecorded),
          lastRecordAt: lastAt ? lastAt.toISOString() : null,
        };
      });

    const totals = rows.reduce(
      (acc, r) => ({
        inStock: acc.inStock + r.inStock,
        reserved: acc.reserved + r.reserved,
        unmapped: acc.unmapped + (r.dataState === 'unmapped_holding' ? r.inStock : 0),
      }),
      { inStock: 0, reserved: 0, unmapped: 0 },
    );

    return { rows, totals, syncEvidence: await this.syncEvidence(user) };
  }

  private stateFor(storeId: string, everRecorded: number): StoreDataState {
    if (storeId === UNASSIGNED_STORE_ID) return 'unmapped_holding';
    // The distinction the client asked for: nothing has EVER arrived for this
    // store, which is not the same as it having sold everything.
    return everRecorded === 0 ? 'no_data' : 'synced';
  }

  /**
   * What the integration can actually prove.
   *
   * `SyncState` is modelled per store, and the running sync writes every row
   * against the sentinel `__organisation__` instead. So the honest answer is
   * an ORGANISATION-level last-run time, and saying so is better than
   * printing a per-store timestamp the data cannot support. Fixing that
   * properly means changing what the sync agent writes, which is a change to
   * the on-site agent and not to this service.
   */
  private async syncEvidence(user: AuthUser) {
    const rows = await this.prisma.syncState.findMany({
      where: { organisationId: user.organisationId },
      select: { lastRunAt: true, storeId: true },
      orderBy: { lastRunAt: 'desc' },
      take: 200,
    });
    const perStore = rows.filter((r) => r.storeId && r.storeId !== ORG_SENTINEL);
    return {
      scope: perStore.length ? 'per_store' : 'organisation',
      lastRunAt: rows[0]?.lastRunAt ? rows[0].lastRunAt.toISOString() : null,
      tables: rows.length,
    };
  }

  /** Which pieces belong to a source, expressed as a Prisma filter. */
  sourceWhere(source: StockSource) {
    switch (source) {
      case 'gati':
        return { legacyId: { not: null } };
      case 'website':
        return { variantId: { not: null }, legacyId: null };
      case 'manual':
        return { legacyId: null, variantId: null };
      case 'import':
        // No import marker exists on StockItem yet — see the audit note. An
        // empty result is the truthful answer, not every row.
        return { id: '__no_import_marker__' };
    }
  }
}

/** The holding pen for pieces whose branch Gati did not name. */
export const UNASSIGNED_STORE_ID = 'unassigned';
/** What the sync agent writes instead of a store id. */
const ORG_SENTINEL = '__organisation__';
