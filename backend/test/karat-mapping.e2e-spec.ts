import { metalFromTone, karatFromMetal } from '../src/sync/sync.util';

/**
 * Karat honesty (Phase 5): the Gati pipeline has no per-piece purity source, so
 * plain gold must NOT be asserted as 22K. It maps to `gold_unspecified` with a
 * null karat; only a genuine rose/pink tone signal maps to a known purity.
 */
describe('Gati tone → metal/karat mapping', () => {
  it('plain gold (ToneFor=G) is gold_unspecified with unknown karat — never 22K', () => {
    const metal = metalFromTone('G', '');
    expect(metal).toBe('gold_unspecified');
    expect(metal).not.toBe('gold_22k');
    expect(karatFromMetal(metal)).toBeNull();
  });

  it('an unrecognised tone also resolves to gold_unspecified (no silent default purity)', () => {
    expect(metalFromTone('', 'XYZ')).toBe('gold_unspecified');
    expect(karatFromMetal('gold_unspecified')).toBeNull();
  });

  it('a rose/pink tone is the one genuine signal → rose_gold_18k (18K)', () => {
    expect(metalFromTone('G', 'PG')).toBe('rose_gold_18k');
    expect(metalFromTone('G', 'ROSE')).toBe('rose_gold_18k');
    expect(karatFromMetal('rose_gold_18k')).toBe(18);
  });

  it('explicitly-mapped karats still resolve correctly', () => {
    expect(karatFromMetal('gold_24k')).toBe(24);
    expect(karatFromMetal('gold_22k')).toBe(22);
    expect(karatFromMetal('gold_18k')).toBe(18);
    // Non-gold metals carry no karat.
    expect(karatFromMetal('platinum')).toBeNull();
    expect(karatFromMetal('silver')).toBeNull();
  });
});
