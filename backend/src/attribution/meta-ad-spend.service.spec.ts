import { MetaGraphClient } from '../integrations/meta-graph.client';
import { PrismaService } from '../prisma/prisma.service';
import { MetaAdSpendService } from './meta-ad-spend.service';

/**
 * Reading Meta's money for the cost-per-enquiry screen.
 *
 * The Graph client is stubbed, never called: these assertions are about the
 * REQUEST this makes and what it does with the answer, and both are things that
 * could be wrong in production while every number still rendered. One call for
 * the whole account rather than one per advert (Meta rate-limits the second),
 * spend validated instead of coerced, a failed call reported as unknown instead
 * of as an account that spent nothing, and the window's own instants handed to
 * the join so the two halves can be checked against each other.
 *
 * The account is Nibhana's: ad account 1234567890123 in INR, Asia/Kolkata,
 * advert 120256795604450226 at 2437.92 for 26925 impressions.
 */
describe('Meta ad spend for a window', () => {
  const ASSET = 'asset-ad-account';
  const INTEGRATION = 'integration-meta-ads';
  const ORG = 'org-nibhana';

  const prisma = (
    metadata: Record<string, unknown> = { accountCurrency: 'INR', accountTimezone: 'Asia/Kolkata' },
  ) =>
    ({
      integrationAsset: {
        findFirst: async () => ({
          id: ASSET,
          externalId: 'act_1234567890123',
          metadata,
          integration: { id: INTEGRATION, config: {} },
        }),
      },
    }) as unknown as PrismaService;

  /** A Graph client that records what it was asked and answers from a script. */
  const graph = (pages: unknown[]) => {
    const calls: Record<string, string>[] = [];
    let next = 0;
    const client = {
      getForIntegration: async (
        _organisationId: string,
        _integrationId: string,
        path: string,
        query: Record<string, string>,
      ) => {
        calls.push({ path, ...query });
        const page = pages[next];
        next += 1;
        if (page instanceof Error) throw page;
        return page;
      },
    } as unknown as MetaGraphClient;
    return { client, calls };
  };

  const row = (over: Record<string, unknown> = {}) => ({
    account_currency: 'INR',
    ad_id: '120256795604450226',
    ad_name: 'blue diamond 24/11 broad',
    campaign_id: '120256795581730226',
    campaign_name: 'blue diamond 24/11',
    spend: '2437.92',
    impressions: '26925',
    date_start: '2026-10-29',
    date_stop: '2026-11-27',
    ...over,
  });

  /** The last 30 days, which is the period the client reads her ad spend over. */
  const REQUEST = {
    integrationId: INTEGRATION,
    adAccountAssetId: ASSET,
    dateFrom: '2026-10-29',
    dateTo: '2026-11-27',
  };

  it('asks the account once, broken down by advert', async () => {
    // One request for everything. A call per advert is what rate-limits an
    // account with a season's worth of creatives, for data this call already
    // returns.
    const { client, calls } = graph([{ data: [row()] }]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('act_1234567890123/insights');
    expect(calls[0].level).toBe('ad');
    expect(calls[0].time_range).toBe('{"since":"2026-10-29","until":"2026-11-27"}');
    expect(calls[0].fields).toContain('ad_id');
    expect(calls[0].fields).toContain('actions');
    expect(snapshot.available).toBe(true);
    expect(snapshot.adverts).toHaveLength(1);
    expect(snapshot.adverts[0].adId).toBe('120256795604450226');
    expect(snapshot.adverts[0].spend).toBe('2437.92');
    expect(snapshot.adverts[0].impressions).toBe('26925');
  });

  it('reads the ad account currency rather than assuming rupees', async () => {
    const { client } = graph([{ data: [row({ account_currency: 'AED', spend: '122.47' })] }]);
    const service = new MetaAdSpendService(
      prisma({ accountCurrency: 'AED', accountTimezone: 'Asia/Dubai' }),
      client,
    );

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(snapshot.currency).toBe('AED');
    expect(snapshot.adverts[0].spend).toBe('122.47');
    // The window's instants are the account's local days, not UTC ones: Dubai
    // midnight is 20:00 the day before.
    expect(snapshot.from).toBe('2026-10-28T20:00:00.000Z');
  });

  it('returns the account-local instants the enquiry side must match', async () => {
    const { client } = graph([{ data: [row()] }]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    // IST midnight on 29 Oct through IST midnight on 28 Nov. Derived here so
    // two hand-rolled windows an hour apart cannot divide cleanly and mean
    // nothing.
    expect(snapshot.from).toBe('2026-10-28T18:30:00.000Z');
    expect(snapshot.to).toBe('2026-11-27T18:30:00.000Z');
    expect(snapshot.timezone).toBe('Asia/Kolkata');
  });

  it("carries Meta's own lead count through without touching it", async () => {
    // 3 lead-form submissions on the campaign we hold 167 WhatsApp enquiries
    // for. Both numbers travel; neither is adjusted to the other.
    const { client } = graph([
      {
        data: [
          row({
            actions: [
              { action_type: 'onsite_conversion.lead', value: '3' },
              { action_type: 'link_click', value: '297' },
              { action_type: 'post_reaction', value: '280' },
            ],
          }),
        ],
      },
    ]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(snapshot.adverts[0].leads).toBe(3);
    expect(snapshot.adverts[0].linkClicks).toBe(297);
  });

  it('leaves an action Meta did not report as unknown, not as none', async () => {
    // No `actions` array at all — a Click-to-WhatsApp advert never produces a
    // lead-form submission, so Meta reports nothing rather than zero, and 0
    // would read as "we checked and there were none".
    const { client } = graph([{ data: [row()] }]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(snapshot.adverts[0].leads).toBeNull();
    expect(snapshot.adverts[0].linkClicks).toBeNull();
  });

  it('reports a failed call as unknown spend, never as an account that spent nothing', async () => {
    const { client } = graph([new Error('Meta Graph request timed out.')]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailableReason).toBe('Meta Graph request timed out.');
    expect(snapshot.adverts).toEqual([]);
    // The window still says what it was about, so the screen can name the days
    // it could not price.
    expect(snapshot.dateFrom).toBe('2026-10-29');
  });

  it('redacts a token out of a provider error before it is reported', async () => {
    const { client } = graph([new Error('Invalid OAuth access_token=EAAG-secret-value.')]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(snapshot.unavailableReason).toBe('Invalid OAuth access_token=[redacted]');
    expect(snapshot.unavailableReason).not.toContain('EAAG');
  });

  it('fails the window rather than coercing a malformed spend to zero', async () => {
    // "2,437.92", an empty string, or a null: every one of them is a number we
    // cannot read, and a zero in its place is indistinguishable from an advert
    // that genuinely did not deliver.
    const { client } = graph([{ data: [row({ spend: '2,437.92' })] }]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailableReason).toContain('invalid spend');
  });

  it('refuses a row in a currency the connection is not configured with', async () => {
    // An account reconfigured mid-history. Reporting USD spend as rupees is a
    // mismatch to surface, not a conversion to perform.
    const { client } = graph([{ data: [row({ account_currency: 'USD' })] }]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailableReason).toContain('configured as INR');
  });

  it('follows pagination with the opaque cursor and stops on a repeat', async () => {
    const { client, calls } = graph([
      {
        data: [row()],
        paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'cursor-2' } },
      },
      { data: [row({ ad_id: '120256795581740226', spend: '88.00', impressions: '900' })] },
    ]);
    const service = new MetaAdSpendService(prisma(), client);

    const snapshot = await service.spendForWindow(ORG, REQUEST);
    expect(calls).toHaveLength(2);
    expect(calls[1].after).toBe('cursor-2');
    expect(snapshot.adverts.map((a) => a.adId)).toEqual([
      '120256795604450226',
      '120256795581740226',
    ]);
  });

  it('serves a second read of the same window from cache', async () => {
    // Eleven managers opening the same dashboard is one Graph call, not eleven.
    const { client, calls } = graph([{ data: [row()] }]);
    const service = new MetaAdSpendService(prisma(), client);

    await service.spendForWindow(ORG, REQUEST);
    await service.spendForWindow(ORG, REQUEST);
    expect(calls).toHaveLength(1);

    service.clearCache();
    // The second page of the script is undefined, which is not a data array —
    // proof the call was actually made again rather than served from cache.
    const after = await service.spendForWindow(ORG, REQUEST);
    expect(calls).toHaveLength(2);
    expect(after.available).toBe(false);
  });
});
