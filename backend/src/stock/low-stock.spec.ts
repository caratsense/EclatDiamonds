import {
  DEFAULT_LOW_STOCK_LEVEL,
  describeShortfall,
  levelFor,
  pairKey,
  shortfallDiff,
} from './low-stock.service';

/**
 * The three decisions a low-stock alert is made of: which number applies, what
 * has changed since yesterday, and what the branch is actually told.
 *
 * Asserted against the real exported functions, without a database. The
 * counting itself is a groupBy and is checked against production data in the
 * report, not mocked here.
 */

describe('which level applies', () => {
  it('falls back to the tenant default when the design has none', () => {
    expect(levelFor(null, 2)).toBe(2);
    expect(levelFor(undefined, DEFAULT_LOW_STOCK_LEVEL)).toBe(1);
  });

  it("uses the design's own level when it has one", () => {
    // The whole point of the override: a bridal set worth holding three deep
    // must not inherit the one-piece default the other 1,414 designs use.
    expect(levelFor(3, 1)).toBe(3);
  });

  it('ignores a level below one, which would mean never alerting', () => {
    expect(levelFor(0, 2)).toBe(2);
  });
});

describe('what changed since the last sweep', () => {
  const key = pairKey;

  it('opens only pairs that are not already open', () => {
    // The de-duplication rule in one assertion: a design already reported short
    // yesterday is NOT reported again today, which is what stops the bell
    // repeating every morning about a shelf nobody has restocked.
    const short = new Set([key('p1', 'bandra'), key('p2', 'bandra')]);
    const open = new Set([key('p1', 'bandra')]);
    expect(shortfallDiff(short, open)).toEqual({
      opened: [key('p2', 'bandra')],
      resolved: [],
    });
  });

  it('is per branch, not per design', () => {
    // Out at Bandra, in stock at Borivali: only Bandra's pair opens.
    const short = new Set([key('p1', 'bandra')]);
    const open = new Set<string>();
    expect(shortfallDiff(short, open).opened).toEqual([key('p1', 'bandra')]);
    expect(shortfallDiff(short, open).opened).not.toContain(key('p1', 'borivali'));
  });

  it('resolves a pair that is no longer short, so it can alert again later', () => {
    const short = new Set<string>();
    const open = new Set([key('p1', 'bandra')]);
    expect(shortfallDiff(short, open)).toEqual({ opened: [], resolved: [key('p1', 'bandra')] });
  });
});

describe('what the branch is told', () => {
  it('names one design in the title when there is only one', () => {
    const { title } = describeShortfall('MUMBAI BANDRA', [{ name: 'NR-1042', elsewhere: 0 }]);
    expect(title).toBe('NR-1042 has run low at MUMBAI BANDRA');
  });

  it('counts the ones it cannot name rather than listing 223 of them', () => {
    // Udaipur's day-one figure. A bell with every design in it is not read.
    const designs = Array.from({ length: 223 }, (_, i) => ({ name: `D-${i}`, elsewhere: 0 }));
    const { title, body } = describeShortfall('UDAIPUR ASHOK NAGAR', designs);
    expect(title).toBe('223 designs are below their reorder level at UDAIPUR ASHOK NAGAR');
    expect(body).toContain('D-0, D-1, D-2, D-3, D-4, and 218 more');
  });

  it('says when pieces are sitting at another branch, because that is a transfer', () => {
    const { body } = describeShortfall('MUMBAI BANDRA', [
      { name: 'NR-1042', elsewhere: 2 },
      { name: 'ER-77', elsewhere: 0 },
    ]);
    expect(body).toContain('1 of them has pieces at another branch');
  });

  it('says it of a single design too', () => {
    const { body } = describeShortfall('MUMBAI BANDRA', [{ name: 'NR-1042', elsewhere: 2 }]);
    expect(body).toBe('NR-1042. There are pieces of it at another branch.');
  });

  it('says nothing about other branches when no branch has any', () => {
    // The honest reorder case: nobody can supply it, so there is nothing to
    // suggest beyond ordering more.
    const { body } = describeShortfall('MUMBAI BANDRA', [{ name: 'NR-1042', elsewhere: 0 }]);
    expect(body).toBe('NR-1042.');
  });
});
