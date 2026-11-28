import { groupUnconfiguredCampaigns } from './unconfigured-campaigns';

/**
 * A campaign with no rule must not fail silently.
 *
 * The eight newest unrouted threads on 28 Nov all came from adverts
 * 120256795604450226 and 120256795581740226, both of campaign
 * "blue diamond 24/11", which has no rule. Routing was correct — no rule, no
 * branch, no script — and the only record of it was a warning in a container
 * log, which the client paying for those clicks cannot read.
 *
 * These assertions are about the collapsing, which is where the fix could
 * quietly recreate the silence it exists to end: six creatives must read as one
 * campaign, and an advert Meta could not name must still be on the list.
 */
describe('campaigns that brought in enquiries and carry no rule', () => {
  const at = (iso: string) => new Date(iso);

  it('collapses one campaign\'s adverts into a single row and adds the counts up', () => {
    // The real shape: two creatives of "blue diamond 24/11", eight enquiries
    // between them. Six separate rows would read as six problems.
    const rows = groupUnconfiguredCampaigns([
      {
        adId: '120256795604450226',
        enquiries: 5,
        lastEnquiryAt: at('2026-11-27T10:00:00.000Z'),
        campaignId: '120256795581730226',
        campaignName: 'blue diamond 24/11',
      },
      {
        adId: '120256795581740226',
        enquiries: 3,
        lastEnquiryAt: at('2026-11-24T08:00:00.000Z'),
        campaignId: '120256795581730226',
        campaignName: 'blue diamond 24/11',
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].campaignName).toBe('blue diamond 24/11');
    expect(rows[0].enquiries).toBe(8);
    expect(rows[0].adIds).toEqual(['120256795604450226', '120256795581740226']);
    // The group's stamp is its MOST RECENT arrival, not the first one found.
    expect(rows[0].lastEnquiryAt).toBe('2026-11-27T10:00:00.000Z');
  });

  it('puts the most recent campaign first', () => {
    // "What is live and unconfigured right now" is the question. A campaign
    // that stopped delivering a fortnight ago must not bury today's.
    const rows = groupUnconfiguredCampaigns([
      {
        adId: 'a-old',
        enquiries: 40,
        lastEnquiryAt: at('2026-11-02T09:00:00.000Z'),
        campaignId: 'c-old',
        campaignName: 'diwali teaser',
      },
      {
        adId: 'a-new',
        enquiries: 2,
        lastEnquiryAt: at('2026-11-27T09:00:00.000Z'),
        campaignId: 'c-new',
        campaignName: 'blue diamond 24/11',
      },
    ]);

    expect(rows.map((r) => r.campaignName)).toEqual(['blue diamond 24/11', 'diwali teaser']);
  });

  it('still reports an advert Meta could not name', () => {
    // A deleted ad, an expired token or a Graph outage all answer "no
    // campaign". Dropping those rows would hide the clicks being paid for
    // exactly when the Meta connection is broken — the same silence, one layer
    // up. The advert id is then all the client has, so it is what they get.
    const rows = groupUnconfiguredCampaigns([
      {
        adId: '120256795604450226',
        enquiries: 4,
        lastEnquiryAt: at('2026-11-27T09:00:00.000Z'),
        campaignId: null,
        campaignName: null,
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].campaignName).toBeNull();
    expect(rows[0].adIds).toEqual(['120256795604450226']);
    expect(rows[0].enquiries).toBe(4);
  });

  it('keeps two unresolved adverts apart', () => {
    // Nothing says these came from one campaign, and merging them under "no
    // campaign" would invent a campaign that does not exist.
    const rows = groupUnconfiguredCampaigns([
      {
        adId: 'ad-1',
        enquiries: 1,
        lastEnquiryAt: at('2026-11-27T09:00:00.000Z'),
        campaignId: null,
        campaignName: null,
      },
      {
        adId: 'ad-2',
        enquiries: 1,
        lastEnquiryAt: at('2026-11-26T09:00:00.000Z'),
        campaignId: null,
        campaignName: null,
      },
    ]);

    expect(rows).toHaveLength(2);
  });

  it('answers nothing when every advert routed', () => {
    expect(groupUnconfiguredCampaigns([])).toEqual([]);
  });
});
