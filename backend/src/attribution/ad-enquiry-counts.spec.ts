import {
  DEFAULT_WINDOW_DAYS,
  enquiryWindow,
  groupAdEnquiries,
  MAX_WINDOW_DAYS,
  repliedPct,
  type AdEnquiryTally,
  type ResolvedAdvert,
} from './ad-enquiry-counts';

/**
 * Which advert brought the most enquiries, and how many of those people wrote
 * again (client, 28 Nov: "kaun se ad pe mujhe sabse zyada number of messages
 * aa rahe hain ... So I want like a count").
 *
 * The real numbers behind these cases are Nibhana's: campaign
 * "blue diamond 24/11" runs adverts 120256795604450226 and 120256795581740226,
 * and it has no routing rule, which is why 167 of its enquiries reached no
 * branch at all.
 *
 * Every assertion here is about a way the count could be WRONG while the chart
 * still drew: a campaign's creatives read as separate adverts, an advert Meta
 * could not name quietly dropped, a reply rate stated out of nothing, or a
 * ranking that reshuffles itself between two refreshes of the same window.
 */
describe('enquiries per advert', () => {
  const named = (
    campaignId: string | null,
    campaignName: string | null,
    adSetName: string | null = null,
  ): ResolvedAdvert => ({ campaignId, campaignName, adSetName });

  const tally = (over: Partial<AdEnquiryTally> & { adId: string }): AdEnquiryTally => ({
    storeId: null,
    storeName: null,
    enquiries: 0,
    replied: 0,
    ...over,
  });

  it('collapses one campaign\'s adverts into a single row and adds the counts up', () => {
    // Two creatives of "blue diamond 24/11". She thinks in campaigns ("we have
    // selected the whole campaign"), so two rows would read as two adverts
    // competing when they are one thing she bought.
    const rows = groupAdEnquiries(
      [
        tally({ adId: '120256795604450226', storeId: 'mumbai-bandra', storeName: 'MUMBAI BANDRA', enquiries: 30, replied: 12 }),
        tally({ adId: '120256795581740226', storeId: 'mumbai-bandra', storeName: 'MUMBAI BANDRA', enquiries: 10, replied: 3 }),
      ],
      new Map([
        ['120256795604450226', named('120256795581730226', 'blue diamond 24/11')],
        ['120256795581740226', named('120256795581730226', 'blue diamond 24/11')],
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].campaignName).toBe('blue diamond 24/11');
    expect(rows[0].enquiries).toBe(40);
    expect(rows[0].replied).toBe(15);
    // The adverts stay readable beneath it, best first.
    expect(rows[0].adverts.map((a) => a.adId)).toEqual([
      '120256795604450226',
      '120256795581740226',
    ]);
    // One branch, counted once, not once per advert.
    expect(rows[0].branches).toEqual([
      { storeId: 'mumbai-bandra', storeName: 'MUMBAI BANDRA', enquiries: 40, replied: 15 },
    ]);
  });

  it('ranks the advert that brought the most enquiries first', () => {
    // The whole question. A campaign with fewer arrivals must not sit above one
    // with more because it happened to be grouped first.
    const rows = groupAdEnquiries(
      [
        tally({ adId: 'ad-quiet', enquiries: 4, storeId: 's1', storeName: 'Bandra' }),
        tally({ adId: 'ad-busy', enquiries: 40, storeId: 's1', storeName: 'Bandra' }),
      ],
      new Map([
        ['ad-quiet', named('c-quiet', 'diwali teaser')],
        ['ad-busy', named('c-busy', 'blue diamond 24/11')],
      ]),
    );

    expect(rows.map((r) => r.campaignName)).toEqual(['blue diamond 24/11', 'diwali teaser']);
  });

  it('still lists an advert Meta would not resolve, named by its id', () => {
    // A deleted ad, an expired token, a Graph outage and an advert past the
    // lookup cap all answer "no campaign". Dropping the row would under-count
    // the very thing she is measuring, and would do so hardest exactly when the
    // Meta connection is broken.
    const rows = groupAdEnquiries(
      [tally({ adId: '120256795604450226', enquiries: 9, replied: 4, storeId: 's1', storeName: 'Bandra' })],
      new Map([['120256795604450226', null]]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].campaignName).toBeNull();
    expect(rows[0].enquiries).toBe(9);
    expect(rows[0].adverts[0].adId).toBe('120256795604450226');
    expect(rows[0].adverts[0].named).toBe(false);
  });

  it('keeps two unnamed adverts apart', () => {
    // Nothing says these came from one campaign. Merging them under a shared
    // "no campaign" heading would invent a campaign and inflate its count.
    const rows = groupAdEnquiries(
      [
        tally({ adId: 'ad-1', enquiries: 3 }),
        tally({ adId: 'ad-2', enquiries: 3 }),
      ],
      new Map([
        ['ad-1', null],
        ['ad-2', null],
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(['ad:ad-1', 'ad:ad-2']);
  });

  it('answers nothing when no advert brought anybody in the window', () => {
    // A seven-day window over a week with no advert running. Zero rows, not a
    // row of zeroes.
    expect(groupAdEnquiries([], new Map())).toEqual([]);
  });

  it('counts a thread with no second inbound message as arrived, not replied', () => {
    // A Click-to-WhatsApp tap sends the customer's first message for them — on
    // the enquiry-form adverts with their answers pre-filled — so every tap
    // looks like a conversation. Ten arrivals and nobody who wrote again is
    // 0%, and it has to be visible as 0% rather than hidden inside "10".
    const rows = groupAdEnquiries(
      [tally({ adId: 'ad-1', enquiries: 10, replied: 0, storeId: 's1', storeName: 'Bandra' })],
      new Map([['ad-1', named('c1', 'blue diamond 24/11')]]),
    );

    expect(rows[0].enquiries).toBe(10);
    expect(rows[0].replied).toBe(0);
    expect(rows[0].repliedPct).toBe(0);
  });

  it('counts a thread that reached no branch, and keeps it out of the branch list', () => {
    // The 167 stranded enquiries of a live campaign with no routing rule. They
    // are real enquiries she paid for, so they are inside the advert's count,
    // and they are at no branch, so they are not inside any branch's.
    const rows = groupAdEnquiries(
      [
        tally({ adId: 'ad-1', storeId: null, enquiries: 167, replied: 40 }),
        tally({ adId: 'ad-1', storeId: 'mumbai-bandra', storeName: 'MUMBAI BANDRA', enquiries: 3, replied: 2 }),
      ],
      new Map([['ad-1', named('c1', 'blue diamond 24/11')]]),
    );

    expect(rows[0].enquiries).toBe(170);
    expect(rows[0].unrouted).toBe(167);
    expect(rows[0].branches).toEqual([
      { storeId: 'mumbai-bandra', storeName: 'MUMBAI BANDRA', enquiries: 3, replied: 2 },
    ]);
  });

  it('orders two adverts on identical counts the same way every time', () => {
    /*
     * A Postgres GROUP BY promises nothing about the order of equal counts, so
     * without a tiebreak two adverts on four enquiries each would swap places
     * between two refreshes of the same window — and a ranking that moves on
     * its own is a ranking nobody trusts, which is the whole point of the
     * screen.
     */
    const resolved = new Map([
      ['ad-b', named(null, null)],
      ['ad-a', named(null, null)],
    ]);
    const forwards = groupAdEnquiries(
      [tally({ adId: 'ad-b', enquiries: 4 }), tally({ adId: 'ad-a', enquiries: 4 })],
      resolved,
    );
    const backwards = groupAdEnquiries(
      [tally({ adId: 'ad-a', enquiries: 4 }), tally({ adId: 'ad-b', enquiries: 4 })],
      resolved,
    );

    expect(forwards.map((r) => r.key)).toEqual(['ad:ad-a', 'ad:ad-b']);
    expect(backwards.map((r) => r.key)).toEqual(forwards.map((r) => r.key));
  });

  it('orders a campaign\'s own adverts stably on identical counts', () => {
    const resolved = new Map([
      ['ad-b', named('c1', 'blue diamond 24/11')],
      ['ad-a', named('c1', 'blue diamond 24/11')],
    ]);
    const rows = groupAdEnquiries(
      [tally({ adId: 'ad-b', enquiries: 7 }), tally({ adId: 'ad-a', enquiries: 7 })],
      resolved,
    );

    expect(rows[0].adverts.map((a) => a.adId)).toEqual(['ad-a', 'ad-b']);
  });

  it('merges two spellings of one campaign name', () => {
    // Meta returns a campaign name however it was typed. "Blue Diamond 24/11"
    // and "blue diamond 24/11" are one campaign, and reading as two would
    // halve the number she is ranking by.
    const rows = groupAdEnquiries(
      [
        tally({ adId: 'ad-1', enquiries: 5 }),
        tally({ adId: 'ad-2', enquiries: 5 }),
      ],
      new Map([
        ['ad-1', named(null, 'Blue Diamond 24/11')],
        ['ad-2', named(null, 'blue diamond 24/11')],
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].enquiries).toBe(10);
  });

  it('names an advert by its ad set when Meta gave no campaign', () => {
    // The marketing team names ad sets after the branch ("Lead Campaign Kala
    // Ghoda"), so an ad set is a real answer to "which advert is this" even
    // without a campaign — and a row that has one is not an unnamed row.
    const rows = groupAdEnquiries(
      [tally({ adId: 'ad-1', enquiries: 2 })],
      new Map([['ad-1', named(null, null, 'Lead Campaign Kala Ghoda')]]),
    );

    expect(rows[0].adverts[0].adSetName).toBe('Lead Campaign Kala Ghoda');
    expect(rows[0].adverts[0].named).toBe(true);
  });
});

describe('the window she picked', () => {
  const now = new Date('2026-11-28T09:00:00.000Z');

  it('starts exactly the chosen number of days back', () => {
    // The screen states the window, so the stated window and the queried one
    // have to be the same arithmetic — which is why this is one function and
    // not a number computed twice.
    expect(enquiryWindow(7, now)).toEqual({
      windowDays: 7,
      since: new Date('2026-11-21T09:00:00.000Z'),
    });
    expect(enquiryWindow(90, now).since).toEqual(new Date('2026-08-30T09:00:00.000Z'));
  });

  it('keeps a thread that arrived exactly on the boundary', () => {
    // The query is `createdAt >= since`. A thread from precisely seven days ago
    // is in the seven-day window; excluding it would leave this screen one
    // short of the inbox with nothing on it to explain the difference.
    const { since } = enquiryWindow(7, now);
    const arrived = new Date('2026-11-21T09:00:00.000Z');
    expect(arrived >= since).toBe(true);
    expect(new Date(arrived.getTime() - 1) >= since).toBe(false);
  });

  it('clamps a window nobody offered', () => {
    expect(enquiryWindow(0, now).windowDays).toBe(1);
    expect(enquiryWindow(-5, now).windowDays).toBe(1);
    expect(enquiryWindow(9999, now).windowDays).toBe(MAX_WINDOW_DAYS);
    expect(enquiryWindow(undefined, now).windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(enquiryWindow(Number.NaN, now).windowDays).toBe(DEFAULT_WINDOW_DAYS);
  });
});

describe('how many of them wrote again', () => {
  it('is null, never 0%, when nothing arrived', () => {
    // "0% replied" on a screen built to rank adverts reads as a failing advert.
    // Nothing arrived, so there is no rate to state.
    expect(repliedPct(0, 0)).toBeNull();
  });

  it('is a whole percent of the enquiries that arrived', () => {
    expect(repliedPct(40, 15)).toBe(38);
    expect(repliedPct(10, 10)).toBe(100);
    expect(repliedPct(10, 0)).toBe(0);
  });
});
