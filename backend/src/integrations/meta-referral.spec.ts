import {
  adCardFrom,
  extractMetaReferral,
  platformFromSourceUrl,
  routingContextFrom,
} from './meta-referral';

/**
 * The first half of the ads flow: what a Click-to-WhatsApp click actually
 * tells us, and what it does NOT.
 *
 * Fast by construction — these are pure functions over a raw webhook payload.
 * Nothing here boots Nest, touches Postgres or calls Meta, so the whole file
 * runs in milliseconds and can be run on every change. The e2e suites that
 * cover the same ground end-to-end each take tens of minutes.
 *
 * The invariant being defended throughout: a referral carries the AD id and
 * nothing else. Every richer field (ad set, campaign) is RESOLVED afterwards
 * from that id, and anything this layer claims to know beyond the ad id would
 * be an invention that fires the wrong branch rule.
 */
describe('CTWA referral extraction', () => {
  const referralMessage = (referral: Record<string, unknown>) => ({
    from: '919000000001',
    id: 'wamid.TEST',
    referral,
  });

  it('pulls the ad id out of source_id', () => {
    const r = extractMetaReferral(
      referralMessage({ source_id: '120254176320150226', source_type: 'ad' }),
    );
    expect(r?.adId).toBe('120254176320150226');
  });

  it('leaves ad set and campaign NULL, because Meta does not send them', () => {
    const r = extractMetaReferral(
      referralMessage({ source_id: '120254176320150226', source_type: 'ad' }),
    );
    // If these ever arrive populated, the resolver downstream is being bypassed
    // and rules will match on data the provider never sent.
    expect(r?.adSetId).toBeNull();
    expect(r?.campaignId).toBeNull();
  });

  it('keeps the click id, which is what reconciles against ad spend', () => {
    const r = extractMetaReferral(
      referralMessage({ source_id: '1202', ctwa_clid: 'AfhnCtVaPEl5JF' }),
    );
    expect(r?.clickId).toBe('AfhnCtVaPEl5JF');
  });

  it('returns null for an ordinary message, which is almost every message', () => {
    expect(extractMetaReferral({ from: '919000000001', text: { body: 'hi' } })).toBeNull();
  });

  it('returns null for a referral carrying neither an ad id nor a click id', () => {
    // A touch with no measurement in it is worse than no touch: it reports an
    // ad arrival that can never be attributed to an ad.
    expect(extractMetaReferral(referralMessage({ headline: 'Diwali Collection' }))).toBeNull();
  });

  it('survives the shapes a hostile or broken payload can take', () => {
    for (const bad of [null, undefined, 'string', 42, [], { referral: null }, { referral: 'x' }]) {
      expect(extractMetaReferral(bad)).toBeNull();
    }
  });

  it('preserves an 18-digit ad id exactly, which is the length Meta actually uses', () => {
    // Every real id on this account is 18 digits (120254176320150226). An
    // off-by-one here routes to no rule at all, silently.
    const r = extractMetaReferral(referralMessage({ source_id: '120254176320150226' }));
    expect(r?.adId).toBe('120254176320150226');
    expect(r?.adId).toHaveLength(18);
  });

  it('coerces a numeric source_id, but only a short one can survive the trip', () => {
    // The number branch of `str()` exists and works:
    expect(extractMetaReferral(referralMessage({ source_id: 12345 }))?.adId).toBe('12345');

    /*
     * It is a trap at Meta's real id length, and the trap is upstream of this
     * function. 120254176320150226 > Number.MAX_SAFE_INTEGER, so an UNQUOTED
     * id is already corrupted by JSON.parse before `extractMetaReferral` is
     * called — the last digits shift and the ad id silently addresses nothing.
     * Meta sends these quoted, which is why this has never bitten; the
     * assertion is here so that if anything ever starts handing us the id as a
     * number, this file says why the routing went quiet.
     */
    expect(Number.isSafeInteger(120254176320150226)).toBe(false);
    expect(String(120254176320150226)).not.toBe('120254176320150226');
  });
});

describe('routing context from a referral', () => {
  const ref = (over: Partial<Record<string, unknown>> = {}) =>
    extractMetaReferral({ referral: { source_id: '1202541763', ...over } });

  it('offers the ad id, which is the only field a rule can match on at this point', () => {
    expect(routingContextFrom(ref())).toEqual({ adId: '1202541763' });
  });

  it('never invents an ad-set NAME out of the ad headline', () => {
    // A headline is marketing copy. Matching "Diwali Collection" against an
    // ad-set name would fire whichever branch happened to share a word with it.
    const context = routingContextFrom(ref({ headline: 'Lead Campaign Bandra' }));
    expect(context).not.toHaveProperty('adSetName');
    expect(context).toEqual({ adId: '1202541763' });
  });

  it('is undefined with no referral, so callers cannot route organic traffic as an ad', () => {
    expect(routingContextFrom(null)).toBeUndefined();
  });
});

describe('platform attribution from the source url', () => {
  /*
   * Meta does NOT send `publisher_platform` on a referral, so the only signal
   * for "did this come from Instagram or Facebook" is the source url. Getting
   * this wrong mis-attributes every lead on the channel report.
   */
  it('reads Instagram', () => {
    expect(platformFromSourceUrl('https://www.instagram.com/p/Cxyz/')).toBe('instagram');
  });

  it('reads Facebook', () => {
    expect(platformFromSourceUrl('https://www.facebook.com/eclat/posts/123')).toBe('facebook');
  });

  it('answers null rather than guessing, for anything else', () => {
    for (const url of [null, '', 'https://eclatdiamonds.in/rings', 'not a url']) {
      expect(platformFromSourceUrl(url)).toBeNull();
    }
  });
});

describe('the ad card shown on a conversation', () => {
  it('is null when the thread did not come from an ad', () => {
    expect(adCardFrom(null)).toBeNull();
  });

  it('carries the creative copy the salesperson needs to see', () => {
    const referral = extractMetaReferral({
      referral: {
        source_id: '1202541763',
        headline: 'Bridal Collection 2026',
        body: 'Book a private viewing',
        source_url: 'https://www.instagram.com/p/Cxyz/',
      },
    });
    const card = adCardFrom(referral);
    // The person answering needs to know what the customer was promised.
    expect(card?.headline).toBe('Bridal Collection 2026');
    expect(card?.body).toBe('Book a private viewing');
  });
});
