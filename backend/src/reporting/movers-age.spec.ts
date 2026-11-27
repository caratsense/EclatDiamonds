import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ReportingService } from './reporting.service';

/**
 * Fast vs Slow Movers has to be able to call something slow.
 *
 * On 27 Nov it reported 0 days of stock for all eight categories and labelled
 * every one of them "Fast" — including Bangles & Kadas, which had sold nothing
 * in thirty days. The average age came from the stored `ageDays` column, which
 * the Gati sync has never written, so every piece counted as zero days old.
 *
 * Age is now counted from `inwardDate`, the way Stock and Dead Stock have
 * always counted it. These fix "now" so the boundary is a fact and not the day
 * the suite happens to run.
 */

const NOW = new Date('2026-11-27T06:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function moversFrom(
  stock: { category: string; ageDays: number | null; inwardDate: Date | null }[],
  soldCategories: string[],
) {
  const prisma = {
    saleLine: {
      findMany: async () =>
        soldCategories.map((category) => ({ product: { category }, stockItem: null })),
    },
    stockItem: { findMany: async () => stock },
  };
  const scope = {
    effectiveStoreIds: () => ['mumbai-bandra'],
    resolveTimezone: async () => 'Asia/Kolkata',
  } as unknown as StoreScopeService;
  const unused = undefined as never;
  return new ReportingService(prisma as never, scope, unused, unused, unused).movers(user);
}

const user: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: 'org_eclat',
  storeIds: ['mumbai-bandra'],
  allStores: true,
};

describe('fast and slow movers', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(NOW));
  afterAll(() => jest.useRealTimers());

  it('ages stock from the inward date when ageDays was never written', async () => {
    const rows = await moversFrom(
      [
        { category: 'ring', ageDays: null, inwardDate: daysAgo(100) },
        { category: 'ring', ageDays: null, inwardDate: daysAgo(200) },
      ],
      ['ring', 'ring', 'ring'],
    );
    const ring = rows.find((r) => r.category === 'Rings');
    // The bug returned 0 here, for every category, always.
    expect(ring?.daysOfStock).toBe(150);
  });

  it('calls a category slow once its stock has sat past sixty days', async () => {
    const rows = await moversFrom(
      [{ category: 'bangle', ageDays: null, inwardDate: daysAgo(180) }],
      ['bangle', 'bangle', 'bangle'],
    );
    expect(rows.find((r) => r.category === 'Bangles & Kadas')?.trend).toBe('slow');
  });

  it('still calls fresh, selling stock fast', async () => {
    const rows = await moversFrom(
      [{ category: 'earrings', ageDays: null, inwardDate: daysAgo(10) }],
      ['earrings', 'earrings', 'earrings'],
    );
    const row = rows.find((r) => r.category === 'Earrings');
    expect(row?.daysOfStock).toBe(10);
    expect(row?.trend).toBe('fast');
  });

  it('falls back to the stored age for a piece with no inward date', async () => {
    const rows = await moversFrom(
      [{ category: 'chain', ageDays: 45, inwardDate: null }],
      ['chain', 'chain'],
    );
    expect(rows.find((r) => r.category === 'Chains')?.daysOfStock).toBe(45);
  });
});
