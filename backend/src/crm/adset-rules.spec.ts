import {
  CAMPAIGN_OPTIONS_MAX,
  CAMPAIGN_QUESTIONS_MAX,
  FIRST_REPLY_MAX,
  adIdFromLink,
  assertCampaignLengths,
  normaliseCampaignQuestions,
  resolveAdSetRule,
  type AdSetAutomationRule,
  type AdSetRoutingContext,
} from './adset-rules.service';

/**
 * The second half of the ads flow: WHICH rule a resolved ad lands on, and what
 * the campaign is allowed to say when it gets there.
 *
 * `resolveAdSetRule` is the whole routing decision and it is a pure function,
 * so it can be exercised exhaustively in milliseconds. The failure mode it
 * exists to prevent is not an error — it is a customer being sent to the wrong
 * showroom, which nobody finds out about from the software.
 */

const rule = (over: Partial<AdSetAutomationRule> = {}): AdSetAutomationRule => ({
  id: 'r1',
  name: 'Rule',
  enabled: true,
  priority: 0,
  matchField: 'ad_set_name',
  matchValue: 'Bandra',
  storeId: 'store_bandra',
  assignedUserId: null,
  handling: 'ai',
  ...over,
});

const ctx = (over: Partial<AdSetRoutingContext> = {}): AdSetRoutingContext => ({ ...over });

describe('which rule an ad lands on', () => {
  it('matches an exact ad id', () => {
    const r = rule({ matchField: 'ad_id', matchValue: '120254176320150226' });
    expect(resolveAdSetRule([r], ctx({ adId: '120254176320150226' }))?.id).toBe('r1');
  });

  it('matches an exact ad-set id — the field the help text used to call dead', () => {
    /*
     * This is the field the routing screen claimed "will never match". It does:
     * the ad id is resolved to its ad set before this function is reached, so
     * one rule per showroom covers every ad that showroom will ever run.
     */
    const r = rule({ matchField: 'ad_set_id', matchValue: '120255822288860226' });
    expect(resolveAdSetRule([r], ctx({ adSetId: '120255822288860226' }))?.id).toBe('r1');
  });

  it('matches an ad id through an alias, so a duplicated creative still routes', () => {
    // Meta gives a copied ad a new id. Aliases are what stop "– Copy" ads
    // falling out of routing the day marketing duplicates a campaign.
    const r = rule({
      matchField: 'ad_id',
      matchValue: '120254176320150226',
      adAliases: ['120254176413550226'],
    });
    expect(resolveAdSetRule([r], ctx({ adId: '120254176413550226' }))?.id).toBe('r1');
  });

  it('matches an ad-set NAME by substring, which is how branches are named', () => {
    const r = rule({ matchField: 'ad_set_name', matchValue: 'Kala Ghoda' });
    const found = resolveAdSetRule([r], ctx({ adSetName: 'Lead Campaign Kala Ghoda' }));
    expect(found?.id).toBe('r1');
  });

  it('matches a campaign name', () => {
    const r = rule({ matchField: 'campaign_name', matchValue: 'Udaipur' });
    expect(
      resolveAdSetRule([r], ctx({ campaignName: 'New WhatsApp Message campaign Udaipur -12-07' }))
        ?.id,
    ).toBe('r1');
  });

  it('is case- and space-insensitive, because nobody types a name twice the same way', () => {
    const r = rule({ matchField: 'ad_set_name', matchValue: '  kala ghoda  ' });
    expect(resolveAdSetRule([r], ctx({ adSetName: 'Lead Campaign KALA GHODA' }))?.id).toBe('r1');
  });
});

describe('which rule WINS when several match', () => {
  it('prefers the more specific name over a shorter one', () => {
    // "Bandra Broadway" and "Bandra" are different showrooms. The longer match
    // is the more specific claim and has to win, or Broadway traffic lands in
    // Bandra forever.
    const broad = rule({ id: 'broad', matchValue: 'Bandra', storeId: 'store_bandra' });
    const narrow = rule({
      id: 'narrow',
      matchValue: 'Bandra Broadway',
      storeId: 'store_broadway',
    });
    const found = resolveAdSetRule([broad, narrow], ctx({ adSetName: 'Lead Bandra Broadway' }));
    expect(found?.id).toBe('narrow');
    expect(found?.storeId).toBe('store_broadway');
  });

  it('prefers an exact id over any name match, however long the name', () => {
    const byName = rule({ id: 'byName', matchValue: 'Lead Campaign Bandra Showroom Mumbai' });
    const byId = rule({ id: 'byId', matchField: 'ad_set_id', matchValue: '999' });
    const found = resolveAdSetRule(
      [byName, byId],
      ctx({ adSetId: '999', adSetName: 'Lead Campaign Bandra Showroom Mumbai' }),
    );
    expect(found?.id).toBe('byId');
  });

  it('breaks a tie on priority', () => {
    const low = rule({ id: 'low', priority: 1 });
    const high = rule({ id: 'high', priority: 9 });
    expect(resolveAdSetRule([low, high], ctx({ adSetName: 'Bandra' }))?.id).toBe('high');
  });
});

describe('when NOTHING should match', () => {
  it('returns null rather than guessing a branch', () => {
    const r = rule({ matchValue: 'Bandra' });
    // Unassigned is the correct outcome. A guess sends a customer to the wrong
    // showroom and the software never reports it.
    expect(resolveAdSetRule([r], ctx({ adSetName: 'Lead Campaign Udaipur' }))).toBeNull();
  });

  it('ignores a disabled rule', () => {
    const r = rule({ enabled: false });
    expect(resolveAdSetRule([r], ctx({ adSetName: 'Bandra' }))).toBeNull();
  });

  it('ignores a rule with an empty match value, which would catch everything', () => {
    // An empty string `includes()` into every name on earth; one such rule
    // would route the whole account to one branch.
    const r = rule({ matchValue: '   ' });
    expect(resolveAdSetRule([r], ctx({ adSetName: 'Lead Campaign Udaipur' }))).toBeNull();
  });

  it('does not match an ad-set rule on an ad id, or the reverse', () => {
    const bySet = rule({ matchField: 'ad_set_id', matchValue: '120255822288860226' });
    expect(resolveAdSetRule([bySet], ctx({ adId: '120255822288860226' }))).toBeNull();
  });

  it('returns null with no rules at all', () => {
    expect(resolveAdSetRule([], ctx({ adId: '1202' }))).toBeNull();
  });
});

describe('the pasted ad link', () => {
  /*
   * Head office pastes a link from Ads Manager rather than hunting for an id.
   * The link is not a dead text field: the id is parsed out of it and becomes
   * the match.
   */
  it('finds the id in an Ads Manager url', () => {
    expect(
      adIdFromLink('https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=120254176320150226'),
    ).toBe('120254176320150226');
  });

  it('answers null for a link with no ad id in it', () => {
    for (const link of [null, undefined, '', 'https://facebook.com/eclat', 'nonsense']) {
      expect(adIdFromLink(link)).toBeNull();
    }
  });
});

describe('what a campaign is allowed to say', () => {
  /*
   * The per-ad opener and its follow-up questions are the most client-visible
   * part of this feature: it is the first thing a customer reads after
   * clicking an ad. Both shapes are accepted because the editor has sent both
   * over time — a bare string, and an object with options.
   */
  it('keeps a well-formed question with its options', () => {
    const qs = normaliseCampaignQuestions([
      { text: 'What carat size are you looking for?', options: ['0.5ct', '1ct'] },
    ]);
    expect(qs).toHaveLength(1);
    expect(qs[0].text).toContain('carat');
    expect(qs[0].options).toEqual(['0.5ct', '1ct']);
  });

  it('accepts a bare string as a question', () => {
    expect(normaliseCampaignQuestions(['Which branch is nearest to you?'])).toEqual([
      { text: 'Which branch is nearest to you?' },
    ]);
  });

  it('drops anything that is not a usable question', () => {
    expect(normaliseCampaignQuestions(null)).toEqual([]);
    expect(normaliseCampaignQuestions('not an array')).toEqual([]);
    expect(normaliseCampaignQuestions([{ text: '   ' }, '', null, 42])).toEqual([]);
  });

  it('caps the questions, so one campaign cannot interrogate a customer', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Question ${i}`);
    expect(normaliseCampaignQuestions(many)).toHaveLength(CAMPAIGN_QUESTIONS_MAX);
  });

  it('caps the options on a question', () => {
    const qs = normaliseCampaignQuestions([
      { text: 'Pick one', options: Array.from({ length: 20 }, (_, i) => `Option ${i}`) },
    ]);
    expect(qs[0].options).toHaveLength(CAMPAIGN_OPTIONS_MAX);
  });

  it('refuses a first reply longer than the limit', () => {
    // Rejected rather than truncated: silently cutting it would send half a
    // sentence to a customer, and nobody would see it happen.
    expect(() =>
      assertCampaignLengths('Bandra', { firstReply: 'x'.repeat(FIRST_REPLY_MAX + 1) }),
    ).toThrow(/first reply/i);
  });

  it('names the rule in the error, so head office knows which one to fix', () => {
    expect(() =>
      assertCampaignLengths('Kala Ghoda', { firstReply: 'x'.repeat(FIRST_REPLY_MAX + 1) }),
    ).toThrow(/Kala Ghoda/);
  });

  it('refuses more questions than the cap', () => {
    expect(() =>
      assertCampaignLengths('Bandra', {
        questions: Array.from({ length: CAMPAIGN_QUESTIONS_MAX + 1 }, () => ({ text: 'Q' })),
      }),
    ).toThrow();
  });

  it('accepts a campaign within every limit', () => {
    expect(() =>
      assertCampaignLengths('Bandra', {
        firstReply: 'Thanks for your interest! Which piece caught your eye?',
        questions: [{ text: 'What is your budget?', options: ['Under 1L', '1-3L'] }],
        closingMessage: 'Our Bandra team will call you shortly.',
      }),
    ).not.toThrow();
  });
});
