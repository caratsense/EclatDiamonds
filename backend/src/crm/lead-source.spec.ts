import { ConversationsService } from './conversations.service';
import { platformFromSourceUrl } from '../integrations/meta-referral';

/**
 * Where a lead came FROM, as opposed to where it arrived.
 *
 * `Lead.source` was hardcoded `'whatsapp'` on every automatic path. That is
 * true of the channel the customer wrote on and says nothing about where they
 * clicked, so all 107 leads in production read "WhatsApp" -- not one under
 * Instagram or Meta Ads -- while the conversations behind them split roughly
 * 30 Facebook to 14 Instagram.
 *
 * Reported as "when I click to see leads from WhatsApp or IG it returns
 * empty". Instagram returned nothing because nothing was ever filed under it.
 */

const svc = Object.create(ConversationsService.prototype) as ConversationsService;

const sourceFor = (platform: string | null) =>
  (svc as unknown as { leadSourceFor: (p: string | null) => string }).leadSourceFor(platform);

describe('the platform decides the lead source', () => {
  it('files an Instagram click under Instagram', () => {
    expect(sourceFor('instagram')).toBe('instagram');
  });

  it('files a Facebook click under Meta Ads', () => {
    // LeadSource has no `facebook` member, so the generic one is the honest
    // place for it — not `whatsapp`, which claims it was never an advert.
    expect(sourceFor('facebook')).toBe('meta_ads');
  });

  it('files a Messenger click under Meta Ads too', () => {
    expect(sourceFor('messenger')).toBe('meta_ads');
  });
});

describe('an enquiry the provider did not attribute', () => {
  it('stays WhatsApp when no platform is known', () => {
    // A genuinely organic enquiry: somebody saved the number and wrote. This
    // is the only case the old hardcoded value was right about.
    expect(sourceFor(null)).toBe('whatsapp');
  });

  it('stays WhatsApp for a platform nobody has mapped', () => {
    expect(sourceFor('threads')).toBe('whatsapp');
  });
});

describe('the platform the referral itself names', () => {
  /*
   * The source is derived from `platformFromSourceUrl`, so these two must
   * agree: a URL that reads as Instagram has to produce an Instagram lead.
   * Asserted together because they are only correct as a pair.
   */
  const cases: [string, string][] = [
    ['https://www.instagram.com/p/Dfz7LIjMxMV/', 'instagram'],
    ['https://ig.me/some/ad', 'instagram'],
    ['https://www.facebook.com/111/posts/222', 'meta_ads'],
    ['https://fb.me/abc', 'meta_ads'],
    ['https://m.me/nibhana', 'meta_ads'],
  ];

  for (const [url, expected] of cases) {
    it(`${url} becomes ${expected}`, () => {
      expect(sourceFor(platformFromSourceUrl(url))).toBe(expected);
    });
  }

  it('an unreadable URL leaves the lead as WhatsApp rather than guessing', () => {
    expect(sourceFor(platformFromSourceUrl('not a url'))).toBe('whatsapp');
    expect(sourceFor(platformFromSourceUrl(null))).toBe('whatsapp');
  });

  it('a site nobody mapped does not become an advert', () => {
    expect(sourceFor(platformFromSourceUrl('https://example.com/x'))).toBe('whatsapp');
  });
});
