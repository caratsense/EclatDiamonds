import type { Prisma, PrismaClient, SalesTarget } from '@prisma/client';

/**
 * Carry-forward resolution for sales targets (client, 9 Oct: a store's target
 * holds every month until it is changed).
 *
 * The effective target for a (store, staff, period) is the EXACT row for that
 * period when one exists, otherwise the MOST RECENT EARLIER row for the same
 * (store, staff) pair. Resolution happens at read time — no rows are copied
 * forward, so a newly typed row for a later month overrides from that month on
 * and the stored data stays exactly what somebody typed.
 *
 * Every reader of SalesTarget amounts (Targets page, achievement, dashboard
 * charts) goes through here so all screens agree on the same number.
 */
export interface EffectiveTarget {
  /** Id of the SOURCE row — the earlier month's row when `carriedFrom` is set. */
  id: string;
  storeId: string;
  staffId: string | null;
  /** The period asked about — NOT necessarily the source row's period. */
  period: string;
  amount: Prisma.Decimal;
  /**
   * The source row's period when no row exists for `period` and an earlier one
   * carries forward; null when a row was typed for `period` itself.
   */
  carriedFrom: string | null;
}

export async function resolveEffectiveTargets(
  prisma: Pick<PrismaClient, 'salesTarget'>,
  opts: {
    storeIds: string[];
    /** "YYYY-MM" periods to resolve (zero-padded, so string order = time order). */
    periods: string[];
    /** Include per-staff rows; default resolves whole-store rows (staffId null) only. */
    includeStaff?: boolean;
  },
): Promise<EffectiveTarget[]> {
  const { storeIds, periods, includeStaff = false } = opts;
  if (storeIds.length === 0 || periods.length === 0) return [];

  // One query covers every requested period: everything up to the latest one,
  // newest first, then each (store, staff, period) picks its first row at or
  // before the period. "YYYY-MM" compares correctly as a string.
  const maxPeriod = periods.reduce((a, b) => (a >= b ? a : b));
  const rows = await prisma.salesTarget.findMany({
    where: {
      storeId: { in: storeIds },
      period: { lte: maxPeriod },
      ...(includeStaff ? {} : { staffId: null }),
    },
    orderBy: { period: 'desc' },
  });

  const byKey = new Map<string, SalesTarget[]>();
  for (const r of rows) {
    const key = `${r.storeId}|${r.staffId ?? ''}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }

  const out: EffectiveTarget[] = [];
  for (const period of periods) {
    for (const list of byKey.values()) {
      // Lists are period-descending; the first row not after `period` is the
      // exact row or the latest earlier one. A pair whose rows all start later
      // than `period` has no effective target for it.
      const src = list.find((r) => r.period <= period);
      if (!src) continue;
      out.push({
        id: src.id,
        storeId: src.storeId,
        staffId: src.staffId ?? null,
        period,
        amount: src.amount,
        carriedFrom: src.period === period ? null : src.period,
      });
    }
  }
  return out;
}
