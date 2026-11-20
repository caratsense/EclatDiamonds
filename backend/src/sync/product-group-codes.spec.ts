import {
  changedGroupCodes,
  normaliseGroupCodes,
  resolveGroupCodes,
} from './product-group-codes';
import { candidateCodes, codeOfProduct, codeOfStockItem, reclassifyKey } from './product-group-codes.service';
import { categoryFromRow } from './sync.service';
import { tokenCode } from './sync.util';

/**
 * Head office's own reading of the product-group codes.
 *
 * Every code below is a real one read off the client's production catalogue on
 * 20 Nov 2026, where 154 of 1,415 designs and 447 of 6,583 pieces carry a code
 * the built-in map has never heard of and are therefore filed under Other. The
 * biggest is LR (64 designs, 144 pieces); the list is blocked on the client,
 * the mechanism is what these tests cover.
 */

const row = (styleNumber: string | null, sku: string | null = null) => ({ styleNumber, sku });

describe('reading what head office typed', () => {
  it('keeps a whole entry and upper-cases the code', () => {
    expect(normaliseGroupCodes([{ code: 'lr', category: 'ring', label: ' Ladies ring ' }])).toEqual([
      { code: 'LR', category: 'ring', label: 'Ladies ring' },
    ]);
  });

  it('drops an entry nobody could act on rather than guessing at it', () => {
    expect(
      normaliseGroupCodes([
        { code: 'LRX', category: 'ring' }, // three letters is not a group code
        { code: 'NP', category: 'nose_pin' }, // not a category this catalogue has
        { code: 'GS' }, // no answer at all
        'CR', // not an entry
        null,
      ]),
    ).toEqual([]);
  });

  it('is not an array', () => {
    expect(normaliseGroupCodes(undefined)).toEqual([]);
    expect(normaliseGroupCodes({ LR: 'ring' })).toEqual([]);
  });

  it('keeps the last word on a code, so a save cannot leave a stale duplicate', () => {
    expect(
      normaliseGroupCodes([
        { code: 'LR', category: 'bangle', label: null },
        { code: 'LR', category: 'ring', label: null },
      ]),
    ).toEqual([{ code: 'LR', category: 'ring', label: null }]);
  });
});

describe('the tenant map lies over the built-in one', () => {
  it('changes nothing when head office has entered nothing', () => {
    expect(resolveGroupCodes(undefined).RG).toBe('ring');
    expect(resolveGroupCodes([]).LR).toBeUndefined();
  });

  it("lets a tenant's entry win over the built-in reading", () => {
    const codes = resolveGroupCodes([{ code: 'CG', category: 'bangle', label: null }]);
    expect(codes.CG).toBe('bangle');
    expect(codes.RG).toBe('ring');
  });
});

describe('a code head office has explained classifies the catalogue', () => {
  const codes = resolveGroupCodes([
    { code: 'LR', category: 'ring', label: 'Ladies ring' },
    { code: 'IN', category: 'other', label: 'Coin' },
  ]);

  it('files ALR00059 as a ring once LR means one', () => {
    expect(categoryFromRow({ StyleCode: 'ALR00059' })).toBe('other');
    expect(categoryFromRow({ StyleCode: 'ALR00059' }, codes)).toBe('ring');
  });

  it('reads a piece from its own SKU', () => {
    expect(categoryFromRow({ InwardSKUNo: 'ALR001002-G-14KT-YG-LG-VVS-VS-E-F' }, codes)).toBe('ring');
  });

  it('treats a deliberate "other" as an answer, not as a blank', () => {
    // 174 pieces of COIN00001 are in stock. A coin is none of the catalogue's
    // groups, and saying so has to stop the English-word scan from guessing.
    expect(categoryFromRow({ StyleCode: 'COIN00001', name: 'Gold Coin' }, codes)).toBe('other');
  });

  it('leaves a code nobody has explained alone', () => {
    expect(categoryFromRow({ StyleCode: '12629NP' }, codes)).toBe('other');
  });
});

describe('the code a stored row carries', () => {
  it('reads the two letters off the leading token', () => {
    expect(tokenCode('ALR00059')).toBe('LR');
    expect(tokenCode('SJMGS0193')).toBe('GS');
    expect(tokenCode('ALR-00026')).toBe('LR');
    expect(tokenCode('A01225')).toBe('');
    expect(tokenCode(null)).toBe('');
  });

  it('reads a design from its style number first, as the product sync does', () => {
    expect(codeOfProduct(row('12629NP', 'A01225'))).toBe('NP');
    expect(codeOfProduct(row(null, 'SJPDS0029'))).toBe('DS');
  });

  it("reads a piece from its own SKU first, then its design's", () => {
    expect(codeOfStockItem({ sku: 'NP10A-G-14KT', styleNumber: '12629NP' })).toBe('PA');
    expect(codeOfStockItem({ sku: 'A01225', styleNumber: '12629NP' })).toBe('NP');
  });

  it('offers every code a row carries, so a change cannot miss it', () => {
    // Counted under PA; classified from NP the moment NP is explained.
    expect(candidateCodes({ sku: 'NP10A-G-14KT', styleNumber: '12629NP' })).toEqual(['NP', 'PA']);
    expect(candidateCodes({ sku: 'A01225', styleNumber: null })).toEqual([]);
  });
});

describe('what a re-classification is being asked to do', () => {
  it('is the same key when the same change is saved twice', () => {
    const codes = [{ code: 'LR', category: 'ring' as const, label: null }];
    expect(reclassifyKey(['LR'], codes)).toBe(reclassifyKey(['LR'], codes));
  });

  it('is a different key once the answer changes', () => {
    // Otherwise the correction collides with the finished job, is answered
    // "already done", and is stored but never applied.
    expect(reclassifyKey(['LR'], [{ code: 'LR', category: 'ring', label: null }])).not.toBe(
      reclassifyKey(['LR'], [{ code: 'LR', category: 'bangle', label: null }]),
    );
  });

  it('says so when a code has been withdrawn', () => {
    expect(reclassifyKey(['LR'], [])).toBe('LR=-');
  });
});

describe('which codes a save has to re-read', () => {
  const lrRing = [{ code: 'LR', category: 'ring' as const, label: null }];

  it('re-reads a code that has just been explained', () => {
    expect(changedGroupCodes([], lrRing)).toEqual(['LR']);
  });

  it('re-reads a code whose meaning was corrected', () => {
    expect(changedGroupCodes(lrRing, [{ code: 'LR', category: 'bangle', label: null }])).toEqual(['LR']);
  });

  it('re-reads a code head office has withdrawn', () => {
    expect(changedGroupCodes(lrRing, [])).toEqual(['LR']);
  });

  it('re-reads nothing when only the wording changed', () => {
    expect(changedGroupCodes(lrRing, [{ code: 'LR', category: 'ring', label: 'Ladies ring' }])).toEqual([]);
  });

  it('re-reads nothing when a built-in code is re-stated as what it already meant', () => {
    expect(changedGroupCodes([], [{ code: 'RG', category: 'ring', label: null }])).toEqual([]);
  });
});
