import { StockService } from './stock.service';
import type { AuthUser } from '../common/auth-user';

/**
 * Every inventory filter, asserted on the `where` it actually produces.
 *
 * Reported from the client: "the filters are not working". Each layer between
 * the dropdown and the database was read and found correct, which is exactly
 * the situation these tests exist for — once a chain has been verified by hand
 * and nothing is written down, the next edit breaks it silently.
 *
 * `GET /stock` never errors on a bad filter: an unrecognised status quietly
 * falls back to the whole ledger set, and the frontend holds the previous page
 * on screen while a request is in flight. So a filter that stops reaching the
 * database does not look like a failure. It looks like a filter that does
 * nothing, which is unfalsifiable from the UI and is why this is asserted here
 * rather than in the browser.
 *
 * `buildWhere` is private and reached by name. That is deliberate: the point is
 * to pin the clause, and routing through `list()` would require a database
 * without testing anything more.
 */

const user = { id: 'u1', organisationId: 'org1', storeIds: ['s1', 's2'] } as AuthUser;

/** Only the two scope methods `buildWhere` reaches. */
const scope = {
  storeFilter: (_u: AuthUser, requested?: string) =>
    requested && requested !== 'all'
      ? { storeId: requested }
      : { storeId: { in: user.storeIds } },
  assertStoreAllowed: (_u: AuthUser, storeId: string) => {
    if (!user.storeIds.includes(storeId)) throw new Error('Store not in your scope');
  },
};

const svc = new StockService(
  null as never,
  scope as never,
  null as never,
  null as never,
  null as never,
);

const where = (filters?: Record<string, unknown>, headerStore?: string) =>
  (svc as unknown as {
    buildWhere: (u: AuthUser, h?: string, f?: unknown) => Record<string, unknown>;
  }).buildWhere(user, headerStore, filters);

/** The AND clause `buildWhere` collects the narrowing filters into. */
const and = (w: Record<string, unknown>) => (w.AND as Record<string, unknown>[]) ?? [];

const LEDGER = ['in_stock', 'aging', 'dead_stock', 'reserved'];

describe('the stock ledger is always store-scoped and status-bounded', () => {
  it('bounds an unfiltered list to the caller stores and the ledger statuses', () => {
    const w = where();
    expect(w.storeId).toEqual({ in: ['s1', 's2'] });
    expect(w.status).toEqual({ in: LEDGER });
  });

  it('never widens past the caller stores, whatever is filtered', () => {
    // The organisation-isolation guarantee: no filter combination may remove it.
    for (const f of [
      { q: 'x' },
      { category: 'ring' },
      { metal: 'gold_22k' },
      { status: 'in_stock' },
      { ageBucket: '365+' },
      { storeId: 's1' },
      { q: 'x', category: 'ring', metal: 'gold_22k', status: 'reserved', ageBucket: '0-30' },
    ]) {
      expect(where(f).storeId).toBeDefined();
    }
  });
});

describe('each facet reaches the database', () => {
  it('category filters on the piece category', () => {
    expect(where({ category: 'ring' }).category).toBe('ring');
  });

  it('metal filters on the purity', () => {
    expect(where({ metal: 'gold_22k' }).metal).toBe('gold_22k');
  });

  it('a ledger status narrows to exactly that status', () => {
    expect(where({ status: 'reserved' }).status).toBe('reserved');
  });

  it('an age bucket becomes an inwardDate range', () => {
    const clause = and(where({ ageBucket: '0-30' })).find((c) => 'inwardDate' in c);
    expect(clause).toBeDefined();
  });

  it('a store facet is added on top of the scope, not instead of it', () => {
    const w = where({ storeId: 's1' });
    // Both must be present: the scope bound AND the chosen store. Replacing
    // one with the other is how a store facet turns into a scope escape.
    expect(w.storeId).toEqual({ in: ['s1', 's2'] });
    expect(and(w)).toContainEqual({ storeId: 's1' });
  });

  it('refuses a store outside the caller scope instead of filtering by it', () => {
    expect(() => where({ storeId: 'not-mine' })).toThrow();
  });

  it('search covers sku, name, style number and vin', () => {
    const clause = and(where({ q: 'ABC' })).find((c) => 'OR' in c) as {
      OR: Record<string, unknown>[];
    };
    expect(clause.OR.flatMap((o) => Object.keys(o)).sort()).toEqual([
      'name',
      'sku',
      'styleNumber',
      'vin',
    ]);
  });

  it('style number is exact, because it is a grouping and not a search', () => {
    const clause = and(where({ styleNumber: 'SD-1' })).find((c) => 'styleNumber' in c) as {
      styleNumber: { equals: string };
    };
    expect(clause.styleNumber.equals).toBe('SD-1');
  });
});

describe('facets combine rather than replace each other', () => {
  it('keeps every filter when several are applied at once', () => {
    const w = where({
      q: 'ABC',
      category: 'ring',
      metal: 'gold_22k',
      status: 'reserved',
      ageBucket: '0-30',
      storeId: 's2',
    });
    expect(w.category).toBe('ring');
    expect(w.metal).toBe('gold_22k');
    expect(w.status).toBe('reserved');
    const keys = and(w).flatMap((c) => Object.keys(c));
    expect(keys).toContain('OR'); // q
    expect(keys).toContain('inwardDate'); // ageBucket
    expect(keys).toContain('storeId'); // store facet
  });

  it('a header store and a store facet both apply', () => {
    const w = where({ storeId: 's1' }, 's1');
    expect(w.storeId).toBe('s1');
    expect(and(w)).toContainEqual({ storeId: 's1' });
  });
});

describe('a status outside the ledger set', () => {
  /*
   * `transferred`, `sold` and `melted` are deliberately not ledger statuses —
   * see INWARD_STATUS in sync.util.ts, where Gati's V/U/D/E/G/I/J/T/P/R letters
   * all mean "physically gone from this location". On the client install that
   * is the majority of synced pieces, so this fallback decides what the whole
   * screen counts. It is asserted here so the choice stays a choice.
   */
  it('falls back to the full ledger set rather than filtering by it', () => {
    for (const s of ['transferred', 'sold', 'melted', 'nonsense']) {
      expect(where({ status: s }).status).toEqual({ in: LEDGER });
    }
  });
});

describe('an empty filter is not a filter', () => {
  it('ignores undefined facets instead of matching nothing', () => {
    const w = where({ category: undefined, metal: undefined, q: undefined });
    expect(w.category).toBeUndefined();
    expect(w.metal).toBeUndefined();
    expect(and(w)).toEqual([]);
  });
});
