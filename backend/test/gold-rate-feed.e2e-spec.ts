import { fineGoldInrPerGramFromFeed } from '../src/integrations/gold-rate.service';

/**
 * The gold-rate feed parser — money-sensitive, so it earns a check. Pins the
 * shape handling and the troy-ounce → gram conversion for every provider the
 * service accepts, using the exact bodies the live endpoints return. A wrong
 * branch or a dropped /31.1035 silently misprices every quote.
 */
describe('fineGoldInrPerGramFromFeed', () => {
  const TROY = 31.1035;

  it('parses the built-in CoinGecko PAX Gold shape (INR per troy ounce → per gram)', () => {
    // Real body: GET .../simple/price?ids=pax-gold&vs_currencies=inr
    const out = fineGoldInrPerGramFromFeed({ 'pax-gold': { inr: 404024 } });
    expect(out).toBeCloseTo(404024 / TROY, 1);
  });

  it('takes goldapi.io price_gram_24k as-is (already per gram)', () => {
    expect(fineGoldInrPerGramFromFeed({ price_gram_24k: 12345.6 })).toBe(12345.6);
  });

  it('takes a generic inr_per_gram as-is', () => {
    expect(fineGoldInrPerGramFromFeed({ inr_per_gram: 6600 })).toBe(6600);
  });

  it('converts a per-troy-ounce { price } to per gram', () => {
    const out = fineGoldInrPerGramFromFeed({ price: 4248.6 });
    expect(out).toBeCloseTo(4248.6 / TROY, 1);
  });

  it('returns null for an unrecognised / empty shape', () => {
    expect(fineGoldInrPerGramFromFeed({})).toBeNull();
    expect(fineGoldInrPerGramFromFeed({ nonsense: 1 })).toBeNull();
    expect(fineGoldInrPerGramFromFeed(null)).toBeNull();
  });

  it('ignores a non-positive price rather than storing a zero rate', () => {
    expect(fineGoldInrPerGramFromFeed({ 'pax-gold': { inr: 0 } })).toBeNull();
    expect(fineGoldInrPerGramFromFeed({ price: -5 })).toBeNull();
  });
});
