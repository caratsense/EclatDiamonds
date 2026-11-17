import { categoryFromRow } from './sync.service';

/**
 * The group code is read from whichever field actually carries it.
 *
 * Reported as "the filters are not working". The filters were fine; 996 of
 * 1,428 pieces in production (70%) were classified `other`, so picking Rings
 * returned 177 of the pieces that are rings and the rest were filed under
 * Other. An empty-looking facet is indistinguishable from a broken one.
 *
 * The cause was `StyleCode ?? StyleSKUNo ?? JewelCode ?? InwardSKUNo` — first
 * field PRESENT, not first field readable. Inward rows carry no StyleCode, so
 * `JewelCode` won, and on this install JewelCode is an inward serial (`A01225`)
 * rather than a design code.
 *
 * Every SKU below is a real row read from production.
 */

/** An Inward (stock) row as the agent sends it: a serial, plus the real SKU. */
const inward = (InwardSKUNo: string, JewelCode = 'A01225') => ({ InwardSKUNo, JewelCode });

describe('a stock row is categorised from its SKU, not its inward serial', () => {
  const cases: [string, string][] = [
    ['APD00004-G-14KT-YG-LG-VVS-E-F', 'pendant'],
    ['30059ER-G-14KT-YG-LG-VVS-VS-E-F', 'earrings'],
    ['12037ARG-G-14KT-WG-LS-VVS 2-E-I-26', 'ring'],
    ['11225BR-G-14KT-YG-LG-VVS-VS-E-F-7.00 inch', 'bracelet'],
    ['10954NK-G-14KT-YG-LG-VVS-VS-E-F', 'necklace'],
    ['12619RG-G-14KT-WG-LG-VVS-VS-E-F-I-14', 'ring'],
    ['12544PD-G-14KT-YG-LG-VVS-VS-E-F', 'pendant'],
  ];

  for (const [sku, expected] of cases) {
    it(`${sku.split('-')[0]} is a ${expected}`, () => {
      expect(categoryFromRow(inward(sku))).toBe(expected);
    });
  }

  it('reads past the serial even though the serial is present', () => {
    // The exact shape of the bug: JewelCode present and useless, SKU readable.
    expect(categoryFromRow(inward('30059ER-G-14KT-YG-LG-VVS-VS-E-F', 'A01376'))).toBe('earrings');
  });

  it('classifies none of the real production SKUs as other', () => {
    for (const [sku] of cases) expect(categoryFromRow(inward(sku))).not.toBe('other');
  });
});

describe('a variant letter before the group code is ignored', () => {
  // `12037ARG` is design 12037, variant A, group RG. The group is the last two
  // letters of the leading token, which is why a variant letter cannot hide it.
  const variants: [string, string][] = [
    ['10976AER-G-14KT-YG-LS-VVS 2-E', 'earrings'],
    ['10952BER-G-14KT-YG-LG-VVS-VS-E-F', 'earrings'],
    ['11227DER-G-14KT-YG-LS-VVS-E-F', 'earrings'],
    ['12037ARG-G-14KT-WG-LS-VVS 2-E-I-26', 'ring'],
  ];
  for (const [sku, expected] of variants) {
    it(`${sku.split('-')[0]} is a ${expected}`, () => {
      expect(categoryFromRow(inward(sku))).toBe(expected);
    });
  }
});

describe('the fields that may carry the code', () => {
  it('prefers a design code when the row has one', () => {
    expect(categoryFromRow({ StyleCode: '10880RG', JewelCode: 'A01225' })).toBe('ring');
  });

  it('falls through a field that carries no readable group', () => {
    // StyleCode present but unreadable must not stop the search.
    expect(categoryFromRow({ StyleCode: 'A01225', InwardSKUNo: '12544PD-G-14KT' })).toBe('pendant');
  });

  it('still reads a style SKU', () => {
    expect(categoryFromRow({ StyleSKUNo: 'SDNK01033' })).toBe('necklace');
  });
});

describe('what is genuinely uncategorisable', () => {
  it('is other when no field carries a known group', () => {
    expect(categoryFromRow({ JewelCode: 'A01225', InwardSKUNo: 'A01225' })).toBe('other');
  });

  it('is other for an empty row rather than guessing', () => {
    expect(categoryFromRow({})).toBe('other');
  });

  it('still reads an English description, for website imports', () => {
    // The word scan is kept for rows that carry real text instead of a code.
    expect(categoryFromRow({ name: 'Diamond Mangalsutra' })).toBe('necklace');
  });
});
