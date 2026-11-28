import {
  joinAdCostPerEnquiry,
  type AdEnquiryCount,
  type AdEnquirySnapshot,
  type AdSpend,
  type AdSpendSnapshot,
} from './ad-cost-per-enquiry';

/**
 * What each WhatsApp enquiry cost (client, 28 Nov: she runs three or four
 * adverts and cannot tell which is working).
 *
 * The numbers here are Nibhana's, read off the live account on 28 Nov: advert
 * 120256795604450226 ("blue diamond 24/11 broad") spent 2437.92 INR for 26925
 * impressions over the last 30 days, its campaign 120256795581730226 reports 3
 * `onsite_conversion.lead` actions, and we hold 167 WhatsApp enquiries from
 * that same campaign.
 *
 * Every assertion is about a way this could be WRONG while still printing a
 * confident figure on a screen about real money: Meta's 3 leads blended into
 * our 167 enquiries, a missing advert counted as free, a nil cost printed as
 * 0.00, a campaign total quietly short of one of its adverts, or a ranking that
 * reshuffles between two refreshes of the same window.
 */
describe('cost per WhatsApp enquiry', () => {
  /** The window both halves are counted over when they agree. */
  const WINDOW = {
    dateFrom: '2026-10-29',
    dateTo: '2026-11-27',
    timezone: 'Asia/Kolkata',
    from: '2026-10-28T18:30:00.000Z',
    to: '2026-11-27T18:30:00.000Z',
  };

  const BLUE_BROAD = '120256795604450226';
  const BLUE_SECOND = '120256795581740226';
  const BLUE_CAMPAIGN = '120256795581730226';

  const spendRow = (over: Partial<AdSpend> & { adId: string }): AdSpend => ({
    adName: null,
    campaignId: BLUE_CAMPAIGN,
    campaignName: 'blue diamond 24/11',
    spend: '0',
    impressions: null,
    leads: null,
    linkClicks: null,
    ...over,
  });

  const spend = (
    adverts: AdSpend[],
    over: Partial<AdSpendSnapshot> = {},
  ): AdSpendSnapshot => ({
    ...WINDOW,
    currency: 'INR',
    available: true,
    unavailableReason: null,
    adverts,
    ...over,
  });

  const count = (over: Partial<AdEnquiryCount> & { adId: string }): AdEnquiryCount => ({
    campaignId: BLUE_CAMPAIGN,
    campaignName: 'blue diamond 24/11',
    enquiries: 0,
    replied: 0,
    ...over,
  });

  const ours = (adverts: AdEnquiryCount[]): AdEnquirySnapshot => ({
    from: WINDOW.from,
    to: WINDOW.to,
    adverts,
  });

  it('divides real spend by our own enquiry count', () => {
    // 2437.92 over 167 enquiries is 14.5983..., and over 48 people who wrote
    // again it is exactly 50.79. Both checked by hand, because this is the one
    // number on the screen the client will act on.
    const report = joinAdCostPerEnquiry(
      spend([
        spendRow({
          adId: BLUE_BROAD,
          adName: 'blue diamond 24/11 broad',
          spend: '2437.92',
          impressions: '26925',
        }),
      ]),
      ours([count({ adId: BLUE_BROAD, enquiries: 167, replied: 48 })]),
    );

    const advert = report.campaigns[0].adverts[0];
    expect(advert.adName).toBe('blue diamond 24/11 broad');
    expect(advert.meta.spend).toBe('2437.92');
    expect(advert.meta.impressions).toBe('26925');
    expect(advert.ours.enquiries).toBe(167);
    expect(advert.costPerEnquiry).toBe('14.60');
    expect(advert.costPerEnquiryStatus).toBe('measured');
    expect(advert.costPerReply).toBe('50.79');
    expect(advert.costPerReplyStatus).toBe('measured');
    expect(report.currency).toBe('INR');
    // The window is returned, not assumed, so the screen can state which days
    // the money covers and which days the enquiries do.
    expect(report.window.spendBasis).toBe('meta_delivery_day');
    expect(report.window.enquiryBasis).toBe('conversation_created_at');
    expect(report.window.sameWindow).toBe(true);
  });

  it("keeps Meta's 3 leads and our 167 enquiries as two separate numbers", () => {
    // THE MOST IMPORTANT ASSERTION IN THIS FILE. Meta counts lead-form
    // submissions; we count people who wrote on WhatsApp. A Click-to-WhatsApp
    // advert produces the second without producing the first, so one blended
    // "leads" figure would be authoritative-looking and false.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '2437.92', leads: 3, linkClicks: 297 })]),
      ours([count({ adId: BLUE_BROAD, enquiries: 167, replied: 48 })]),
    );

    const campaign = report.campaigns[0];
    expect(campaign.meta.leads).toBe(3);
    expect(campaign.meta.linkClicks).toBe(297);
    expect(campaign.ours.enquiries).toBe(167);
    expect(campaign.ours.replied).toBe(48);
    // Nothing reconciled the two: the cost is our 167, never Meta's 3.
    expect(campaign.costPerEnquiry).toBe('14.60');
    expect(report.totals.meta.leads).toBe(3);
    expect(report.totals.ours.enquiries).toBe(167);
  });

  it('states no cost per enquiry for an advert that spent and brought nothing', () => {
    // Infinite cost is not a number to print, and 0.00 would read as free.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '2437.92', impressions: '26925' })]),
      ours([]),
    );

    const advert = report.campaigns[0].adverts[0];
    expect(advert.meta.spend).toBe('2437.92');
    expect(advert.ours.enquiries).toBe(0);
    expect(advert.costPerEnquiry).toBeNull();
    expect(advert.costPerEnquiryStatus).toBe('no_enquiries');
    // Listed, not dropped: an advert burning money on nobody is the row she
    // opened the screen to find.
    expect(report.totals.adverts).toBe(1);
  });

  it('states no cost for enquiries that arrived with no spend behind them', () => {
    // Organic reach, or a window the advert did not deliver in. Zero cost would
    // claim the enquiries were free, which is a different and stronger claim.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '0', impressions: '0' })]),
      ours([count({ adId: BLUE_BROAD, enquiries: 12, replied: 4 })]),
    );

    const advert = report.campaigns[0].adverts[0];
    expect(advert.meta.spend).toBe('0.00');
    expect(advert.meta.status).toBe('measured');
    expect(advert.ours.enquiries).toBe(12);
    expect(advert.costPerEnquiry).toBeNull();
    expect(advert.costPerEnquiryStatus).toBe('no_spend');
    expect(advert.costPerReplyStatus).toBe('no_spend');
  });

  it('reports a paused advert with nil spend and no enquiries as nil, not free', () => {
    // Both sides zero. `no_spend` rather than `no_enquiries` because "this
    // advert cost nothing in this window" is the more specific fact, and
    // "no enquiries yet" would imply it was running.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '0', impressions: '0' })]),
      ours([count({ adId: BLUE_BROAD, enquiries: 0, replied: 0 })]),
    );

    const advert = report.campaigns[0].adverts[0];
    expect(advert.costPerEnquiry).toBeNull();
    expect(advert.costPerEnquiryStatus).toBe('no_spend');
    expect(advert.costPerReply).toBeNull();
  });

  it('marks an advert Meta never returned as unknown, never as zero spend', () => {
    // A deleted ad, an ad id Meta will not resolve, or a paused advert with no
    // rows in the window. The enquiries are real and stay on the screen; the
    // money beside them says it is not known.
    const report = joinAdCostPerEnquiry(
      spend([]),
      ours([count({ adId: BLUE_BROAD, enquiries: 167, replied: 48 })]),
    );

    const advert = report.campaigns[0].adverts[0];
    expect(advert.meta.status).toBe('not_returned');
    expect(advert.meta.spend).toBeNull();
    expect(advert.meta.impressions).toBeNull();
    expect(advert.ours.enquiries).toBe(167);
    expect(advert.costPerEnquiry).toBeNull();
    expect(advert.costPerEnquiryStatus).toBe('spend_unknown');
  });

  it('knows nothing about any advert when the insights call failed', () => {
    // Not one advert at 0.00. The whole money column is unknown and says so,
    // while the counts — which need no Meta connection — survive intact.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '2437.92' })], {
        available: false,
        unavailableReason: 'Meta Graph request timed out.',
      }),
      ours([count({ adId: BLUE_BROAD, enquiries: 167, replied: 48 })]),
    );

    expect(report.spendAvailable).toBe(false);
    expect(report.spendUnavailableReason).toBe('Meta Graph request timed out.');
    expect(report.totals.meta.spend).toBeNull();
    expect(report.totals.ours.enquiries).toBe(167);
    expect(report.campaigns[0].adverts[0].meta.status).toBe('spend_unavailable');
    expect(report.campaigns[0].costPerEnquiryStatus).toBe('spend_unknown');
  });

  it('marks a campaign incomplete rather than summing its missing adverts as free', () => {
    // Two creatives of "blue diamond 24/11"; Meta returned one of them. Adding
    // 2437.92 to an implied zero and dividing by both adverts' enquiries would
    // halve the real cost per enquiry and look entirely reasonable.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '2437.92', impressions: '26925' })]),
      ours([
        count({ adId: BLUE_BROAD, enquiries: 120, replied: 40 }),
        count({ adId: BLUE_SECOND, enquiries: 47, replied: 8 }),
      ]),
    );

    const campaign = report.campaigns[0];
    expect(campaign.campaignName).toBe('blue diamond 24/11');
    expect(campaign.meta.status).toBe('partial');
    // The partial sum is shown, labelled, rather than hidden — but no cost is
    // derived from it.
    expect(campaign.meta.spend).toBe('2437.92');
    expect(campaign.ours.enquiries).toBe(167);
    expect(campaign.costPerEnquiry).toBeNull();
    expect(campaign.costPerEnquiryStatus).toBe('incomplete_spend');
    expect(campaign.costPerReplyStatus).toBe('incomplete_spend');
    // The advert Meta DID return still carries its own honest cost.
    const resolved = campaign.adverts.find((a) => a.adId === BLUE_BROAD);
    expect(resolved?.costPerEnquiry).toBe('20.32');
    expect(campaign.adverts.find((a) => a.adId === BLUE_SECOND)?.costPerEnquiryStatus).toBe(
      'spend_unknown',
    );
  });

  it('handles a decimal spend string in a currency that is not rupees', () => {
    // Meta returns spend as a STRING in the ad account's currency. 122.47 USD
    // over 7 enquiries is 17.4957..., which is 17.50 to the cent — arithmetic
    // done on a decimal, never on a float.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '122.47' })], { currency: 'USD' }),
      ours([count({ adId: BLUE_BROAD, enquiries: 7, replied: 2 })]),
    );

    expect(report.currency).toBe('USD');
    expect(report.campaigns[0].adverts[0].costPerEnquiry).toBe('17.50');
    // Nothing anywhere converted it into rupees.
    expect(report.note).toContain('No currency conversion');
  });

  it('refuses every cost when the two halves cover different windows', () => {
    // A rolling "last 30 days" enquiry count over a calendar month of spend.
    // The division would succeed and the answer would be about two periods.
    const report = joinAdCostPerEnquiry(
      spend([spendRow({ adId: BLUE_BROAD, spend: '2437.92' })]),
      {
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-28T00:00:00.000Z',
        adverts: [count({ adId: BLUE_BROAD, enquiries: 167, replied: 48 })],
      },
    );

    expect(report.window.sameWindow).toBe(false);
    expect(report.campaigns[0].costPerEnquiryStatus).toBe('window_mismatch');
    expect(report.campaigns[0].costPerEnquiry).toBeNull();
    expect(report.totals.costPerEnquiryStatus).toBe('window_mismatch');
    // The spend and the counts are still both shown; only the division is refused.
    expect(report.campaigns[0].meta.spend).toBe('2437.92');
    expect(report.campaigns[0].ours.enquiries).toBe(167);
  });

  it('breaks a tie on cost with the advert id, so the ranking never reshuffles', () => {
    // Equal costs come back from a GROUP BY in no promised order. Two adverts
    // at 10.00 each that swap places between refreshes make the whole ranking
    // look untrustworthy.
    const report = joinAdCostPerEnquiry(
      spend([
        spendRow({ adId: BLUE_BROAD, spend: '100.00' }),
        spendRow({ adId: BLUE_SECOND, spend: '100.00' }),
      ]),
      ours([
        count({ adId: BLUE_BROAD, enquiries: 10, replied: 3 }),
        count({ adId: BLUE_SECOND, enquiries: 10, replied: 3 }),
      ]),
    );

    const adverts = report.campaigns[0].adverts;
    expect(adverts.map((a) => a.costPerEnquiry)).toEqual(['10.00', '10.00']);
    // Both arrived with BLUE_BROAD first; the id decides, not the arrival order.
    expect(adverts.map((a) => a.adId)).toEqual([BLUE_SECOND, BLUE_BROAD]);
  });

  it('ranks the cheapest enquiry first and puts the unknowns last', () => {
    // Cheapest first is the question as it was asked — which advert is working.
    // An advert with no cost sorts last rather than appearing to be the best
    // buy, which is what a null read as zero would do.
    const report = joinAdCostPerEnquiry(
      spend([
        spendRow({ adId: 'ad-dear', campaignId: 'c-dear', campaignName: 'dear', spend: '900.00' }),
        spendRow({ adId: 'ad-cheap', campaignId: 'c-cheap', campaignName: 'cheap', spend: '90.00' }),
      ]),
      ours([
        count({ adId: 'ad-dear', campaignId: 'c-dear', campaignName: 'dear', enquiries: 9 }),
        count({ adId: 'ad-cheap', campaignId: 'c-cheap', campaignName: 'cheap', enquiries: 9 }),
        count({ adId: 'ad-unknown', campaignId: 'c-unknown', campaignName: 'unknown', enquiries: 50 }),
      ]),
    );

    expect(report.campaigns.map((c) => c.campaignName)).toEqual(['cheap', 'dear', 'unknown']);
    expect(report.campaigns.map((c) => c.costPerEnquiry)).toEqual(['10.00', '100.00', null]);
    expect(report.totals.campaigns).toBe(3);
  });

  it("gives an advert nobody could name a row of its own", () => {
    // Merging unnamed adverts under one "no campaign" heading would invent a
    // campaign that does not exist — the same rule the enquiry count follows.
    const report = joinAdCostPerEnquiry(
      spend([]),
      ours([
        count({ adId: BLUE_BROAD, campaignId: null, campaignName: null, enquiries: 4 }),
        count({ adId: BLUE_SECOND, campaignId: null, campaignName: null, enquiries: 2 }),
      ]),
    );

    expect(report.campaigns).toHaveLength(2);
    expect(report.campaigns.map((c) => c.key)).toEqual([`ad:${BLUE_SECOND}`, `ad:${BLUE_BROAD}`]);
    expect(report.campaigns.every((c) => c.campaignName === null)).toBe(true);
  });
});
