import { adKind } from './meta-ads-list.service';

/**
 * Which ads the bot-script picker offers, and why.
 *
 * The picker listed Click-to-WhatsApp only, on the reasoning that a lead form
 * never produces a referral so a script attached to one could never fire. True
 * of the referral, wrong about the lead: a form lead reaches WhatsApp a moment
 * later and from their reply onwards it is an ordinary conversation. The
 * client asked for lead forms by name (17 Nov).
 *
 * Every destination and call-to-action below was read from the client's live
 * ad account, not invented. The distribution across 300 active ads was:
 *
 *   UNDEFINED              245 ads  (some carrying CTA WHATSAPP_MESSAGE)
 *   ON_AD                   18     objective OUTCOME_LEADS, CTA GET_OFFER
 *   WHATSAPP                11     CTA WHATSAPP_MESSAGE
 *   INSTAGRAM_PROFILE        8
 *   WEBSITE                  7
 *   WEBSITE_AND_LEAD_FORM    6     objective OUTCOME_LEADS, CTA SEE_DETAILS
 *   INSTAGRAM_DIRECT         4
 *   ON_POST                  1
 *
 * which is why neither signal alone is enough: the lead forms declare their
 * destination and carry call-to-actions that mention nothing, while the
 * largest group declares no destination and can only be read from its CTA.
 */

describe('click-to-WhatsApp ads', () => {
  it('is whatsapp when the ad set says so', () => {
    expect(adKind('WHATSAPP', 'WHATSAPP_MESSAGE')).toBe('whatsapp');
  });

  it('is whatsapp on the call to action alone', () => {
    // 245 active ads report UNDEFINED; some of them genuinely open a chat, and
    // dropping them is what the original CTA check was right about.
    expect(adKind('UNDEFINED', 'WHATSAPP_MESSAGE')).toBe('whatsapp');
    expect(adKind(null, 'WHATSAPP_MESSAGE')).toBe('whatsapp');
  });
});

describe('lead forms', () => {
  it('reads an instant form on the ad', () => {
    expect(adKind('ON_AD', 'GET_OFFER')).toBe('lead_form');
  });

  it('reads the website-and-form variant', () => {
    expect(adKind('WEBSITE_AND_LEAD_FORM', 'SEE_DETAILS')).toBe('lead_form');
  });

  it('does not depend on the call to action, which says nothing useful', () => {
    // GET_OFFER and SEE_DETAILS carry no hint of any destination.
    for (const cta of ['GET_OFFER', 'SEE_DETAILS', 'LEARN_MORE', null]) {
      expect(adKind('ON_AD', cta)).toBe('lead_form');
    }
  });
});

describe('ads with no way into WhatsApp', () => {
  /*
   * Still excluded, and for the original reason: the customer never arrives in
   * a chat at all, so there is no conversation for a script to run.
   */
  const excluded: [string | null, string | null][] = [
    ['WEBSITE', 'VIEW_INSTAGRAM_PROFILE'],
    ['INSTAGRAM_PROFILE', 'VIEW_INSTAGRAM_PROFILE'],
    ['ON_POST', null],
    ['UNDEFINED', 'SHOP_NOW'],
    ['UNDEFINED', 'GET_OFFER_VIEW'],
    ['UNDEFINED', 'LEARN_MORE'],
    ['UNDEFINED', null],
    [null, null],
  ];

  for (const [dest, cta] of excluded) {
    it(`${dest ?? 'no destination'} / ${cta ?? 'no CTA'} is not offered`, () => {
      expect(adKind(dest, cta)).toBeNull();
    });
  }

  it('leaves Instagram Direct out — a chat, but not this one', () => {
    // INSTAGRAM_DIRECT opens an Instagram thread, not WhatsApp. The bot script
    // being configured here replies on WhatsApp.
    expect(adKind('INSTAGRAM_DIRECT', 'INSTAGRAM_MESSAGE')).toBeNull();
  });
});

describe('reading is case-insensitive', () => {
  it('accepts whatever case Meta returns', () => {
    expect(adKind('on_ad', 'get_offer')).toBe('lead_form');
    expect(adKind('whatsapp', null)).toBe('whatsapp');
    expect(adKind(null, 'whatsapp_message')).toBe('whatsapp');
  });
});

describe('whatsapp wins when an ad looks like both', () => {
  it('prefers the live chat over the form', () => {
    // A lead-form destination with a WhatsApp call to action: the customer can
    // reach a chat directly, which is the stronger of the two starts.
    expect(adKind('WEBSITE_AND_LEAD_FORM', 'WHATSAPP_MESSAGE')).toBe('whatsapp');
  });
});
