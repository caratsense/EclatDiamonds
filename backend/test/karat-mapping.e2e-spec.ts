import {
  karatFromRow,
  metalFromRow,
  karatFromMetal,
  stockStatusFromInward,
} from '../src/sync/sync.util';

/**
 * Gati extraction (validated against the real APRSSJEP database):
 *  - karat is carried in the piece code as a `-14KT-`/`-18KT-`/`-9KT-` token
 *    (this is a 14K/18K/9K lab-grown-diamond business — never a silent 22K);
 *  - the metal enum buckets by that karat, with PG/pink → rose gold;
 *  - `Inward.Status` (not `SaleId`) is the authoritative stock status — `SaleId`
 *    is also set on branch-transfer vouchers, so it must not flip a transfer to
 *    "sold".
 */
describe('Gati tone/karat/status extraction', () => {
  it('karat is read from the -NNKT- token in the SKU/code', () => {
    expect(karatFromRow({ InwardSKUNo: '12483BRG-G-14KT-PG-LG-VVS' })).toBe(14);
    expect(karatFromRow({ StyleSKUNo: 'SDNK01033-G-18KT-YG' })).toBe(18);
    expect(karatFromRow({ StyleSKUNo: 'X-G-9KT-YG' })).toBe(9);
    expect(karatFromRow({ Karat: 22 })).toBe(22); // explicit wins
    expect(karatFromRow({ StyleCode: '10880RG' })).toBeNull(); // no token
  });

  it('metal buckets by karat; pink/PG → rose gold; unknown → gold_unspecified', () => {
    expect(metalFromRow({ StyleSKUNo: '25ACG-G-14KT-YG' })).toBe('gold_14k');
    expect(metalFromRow({ StyleSKUNo: 'SDNK01033-G-18KT-YG' })).toBe('gold_18k');
    expect(metalFromRow({ StyleSKUNo: 'X-G-9KT-YG' })).toBe('gold_9k');
    expect(metalFromRow({ StyleSKUNo: '12483BRG-G-14KT-PG-LG', ToneCode: 'PG' })).toBe('rose_gold_18k');
    expect(metalFromRow({ StyleCode: '10880RG' })).toBe('gold_unspecified'); // no karat token
  });

  it('karatFromMetal covers the low-karat buckets', () => {
    expect(karatFromMetal('gold_14k')).toBe(14);
    expect(karatFromMetal('gold_9k')).toBe(9);
    expect(karatFromMetal('gold_10k')).toBe(10);
    expect(karatFromMetal('gold_18k')).toBe(18);
    expect(karatFromMetal('gold_unspecified')).toBeNull();
  });

  it('Status is authoritative; SaleId does NOT flip a transfer to sold', () => {
    expect(stockStatusFromInward({ Status: 'A' })).toBe('in_stock');
    expect(stockStatusFromInward({ Status: 'X' })).toBe('sold');
    // The bug: a branch-transfer (V) row carries a SaleId — it must stay transferred.
    expect(stockStatusFromInward({ Status: 'V', SaleId: 12345 })).toBe('transferred');
    expect(stockStatusFromInward({ Status: 'C' })).toBe('reserved');
    // SaleId only decides when there is no status letter at all.
    expect(stockStatusFromInward({ Status: '', SaleId: 1 })).toBe('sold');
    expect(stockStatusFromInward({ Status: '' })).toBe('in_stock');
  });
});
