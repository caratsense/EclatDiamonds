import { KNOWN_INWARD_STATUSES, stockStatusFromInward } from '../src/sync/sync.util';

/**
 * `Inward.Status` -> Eclat availability.
 *
 * The regression this exists for: the mapping was `row.SaleId ? 'sold' :
 * 'in_stock'`, and `SaleId` is not a column on this client's install — so every
 * piece imported as available. Measured on their data, only 46% are actually On
 * Hand. Eclat would have shown roughly twice the stock that exists, and a
 * salesperson would have promised a customer a ring that was sold last month.
 *
 * The letters are the legacy system's own `Const_InwardStatus` master, read off
 * the client's live database — not something we invented.
 */
describe('sync — what counts as stock a shop can actually sell', () => {
  /** The set the catalogue treats as available (ProductsService.stockPresence). */
  const AVAILABLE = new Set(['in_stock', 'aging', 'dead_stock']);
  const sellable = (status: string) => AVAILABLE.has(stockStatusFromInward({ Status: status }));

  it('On Hand is the ONLY sellable state', () => {
    expect(sellable('A')).toBe(true);
    for (const code of [...KNOWN_INWARD_STATUSES].filter((c) => c !== 'A')) {
      expect({ code, sellable: sellable(code) }).toEqual({ code, sellable: false });
    }
  });

  it('sold, gone and committed pieces each land in the right bucket', () => {
    expect(stockStatusFromInward({ Status: 'X' })).toBe('sold'); // Sold
    expect(stockStatusFromInward({ Status: 'V' })).toBe('transferred'); // Branch Issue
    expect(stockStatusFromInward({ Status: 'U' })).toBe('transferred'); // Branch Memo Issue
    expect(stockStatusFromInward({ Status: 'C' })).toBe('reserved'); // Memo (with a customer)
    expect(stockStatusFromInward({ Status: 'S' })).toBe('reserved'); // Tobe Sold
    expect(stockStatusFromInward({ Status: 'B' })).toBe('melted'); // Broken
    expect(stockStatusFromInward({ Status: 'L' })).toBe('melted'); // Lost
  });

  it('reproduces the real distribution instead of calling everything in stock', () => {
    // Counts measured on the client's data copy (2,690 Inward rows).
    const LIVE = { A: 1234, U: 692, V: 552, X: 116, R: 86, I: 10 };
    let available = 0;
    for (const [code, n] of Object.entries(LIVE)) {
      if (sellable(code)) available += n;
    }
    const total = Object.values(LIVE).reduce((a, b) => a + b, 0);
    expect(total).toBe(2690);
    // Only the On Hand pieces. The old mapping produced 2,690 — more than double.
    expect(available).toBe(1234);
  });

  it('is case- and whitespace-insensitive, because legacy text fields are not clean', () => {
    expect(stockStatusFromInward({ Status: 'a' })).toBe('in_stock');
    expect(stockStatusFromInward({ Status: ' A ' })).toBe('in_stock');
    expect(stockStatusFromInward({ Status: 'x' })).toBe('sold');
  });

  it('hides a piece whose status it does not recognise, rather than offering it', () => {
    // Wrongly hiding costs a sale the staff can see on the shelf. Wrongly showing
    // costs a promise to a customer that cannot be kept.
    expect(sellable('Z')).toBe(false);
    expect(sellable('QQ')).toBe(false);
  });

  it('still treats an install with no status column as before', () => {
    // Not every SJEP build has the column; those must keep working.
    expect(stockStatusFromInward({})).toBe('in_stock');
    expect(stockStatusFromInward({ Status: null })).toBe('in_stock');
    expect(stockStatusFromInward({ Status: '' })).toBe('in_stock');
  });

  it('the status letter is authoritative — SaleId does NOT override it', () => {
    // Validated on the real DB: Inward.SaleId is also set on branch-transfer (V)
    // vouchers, so trusting it first flipped ~550 transferred pieces to a phantom
    // "sold". Status wins; SaleId only decides when there is no status letter.
    expect(stockStatusFromInward({ SaleId: 42, Status: 'A' })).toBe('in_stock');
    expect(stockStatusFromInward({ SaleId: 42, Status: 'V' })).toBe('transferred');
    expect(stockStatusFromInward({ SaleId: 42, Status: '' })).toBe('sold'); // no letter → SaleId
  });
});
