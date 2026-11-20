import {
  bodyParametersFrom,
  templateAssetIdFrom,
  templateCardFrom,
  templateComponentsFrom,
} from './template-card';

/**
 * The incident: 104 customers received the nails-event invitation with its
 * photograph, and the client's conversations tab showed an empty bubble
 * against every one of them. A template send stores no body and no media —
 * the words and the picture belong to the approved template — so the message
 * row genuinely holds nothing to draw.
 *
 * What is pinned here is that the bubble can be rebuilt from the template the
 * send named, and that it is rebuilt with THIS recipient's values rather than
 * the provider's sample ones.
 */

const NAILS = {
  headerFormat: 'IMAGE',
  headerImageUrl: 'https://scontent.whatsapp.net/v/nails.jpg',
  bodyPreview: 'Join us for our nail art event this Saturday!',
  footerText: 'Nibhana Jewels',
};

describe('rebuilding what a template message showed', () => {
  it('shows the approved wording when the template takes no variables', () => {
    const card = templateCardFrom('nailsevent', NAILS);
    expect(card?.body).toBe('Join us for our nail art event this Saturday!');
  });

  it('carries the header picture, which is the whole invitation', () => {
    // Every detail of the event was in the image. A bubble without it is not a
    // shorter version of what was sent — it is a different message.
    const card = templateCardFrom('nailsevent', NAILS);
    expect(card?.headerFormat).toBe('IMAGE');
    expect(card?.headerImageUrl).toBe('https://scontent.whatsapp.net/v/nails.jpg');
  });

  it('fills the slots with this recipient’s own values', () => {
    const card = templateCardFrom(
      'visit_followup',
      { bodySource: 'Hello {{1}}, thank you for visiting {{2}}.', bodyPreview: 'Hello Priya, thank you for visiting Bandra.' },
      ['Anjali', 'Andheri'],
    );
    expect(card?.body).toBe('Hello Anjali, thank you for visiting Andheri.');
  });

  it('never shows the provider’s sample name on a real thread', () => {
    // bodyPreview has the SAMPLE values substituted. Showing "Hi Priya" on
    // Anjali's conversation is worse than showing her nothing.
    const card = templateCardFrom(
      'visit_followup',
      { bodySource: 'Hello {{1}}.', bodyPreview: 'Hello Priya.' },
      ['Anjali'],
    );
    expect(card?.body).not.toContain('Priya');
  });

  it('leaves an unfilled slot visible rather than blanking it', () => {
    // An empty slot reads as a sentence the customer was actually sent. A
    // visible {{2}} reads as the bug it is.
    const card = templateCardFrom('x', { bodySource: 'Hi {{1}}, see {{2}}.' }, ['Anjali']);
    expect(card?.body).toBe('Hi Anjali, see {{2}}.');
  });

  it('falls back to the preview when the template kept no source text', () => {
    const card = templateCardFrom('x', { bodyPreview: 'Older row, no source kept.' });
    expect(card?.body).toBe('Older row, no source kept.');
  });

  it('is null for a message that named no template', () => {
    expect(templateCardFrom('x', null)).toBeNull();
    expect(templateCardFrom('x', 'not an object')).toBeNull();
  });
});

describe('reading the send’s own stored instruction', () => {
  const payload = {
    omnichannel: {
      templateAssetId: 'asset-1',
      templateComponents: [
        { type: 'header', parameters: [{ type: 'image', image: { id: '123' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Anjali' }] },
      ],
    },
  };

  it('finds which template was sent', () => {
    expect(templateAssetIdFrom(payload)).toBe('asset-1');
  });

  it('reads only the body parameters, never the header media id', () => {
    // The header parameter is the picture's media id. Substituting it into the
    // wording would print a 15-digit number mid-sentence.
    expect(bodyParametersFrom(templateComponentsFrom(payload))).toEqual(['Anjali']);
  });

  it('is empty for a template that takes no variables', () => {
    expect(bodyParametersFrom([{ type: 'header', parameters: [] }])).toEqual([]);
    expect(bodyParametersFrom(null)).toEqual([]);
  });

  it('finds nothing on an ordinary typed message', () => {
    expect(templateAssetIdFrom({ omnichannel: { purpose: 'service' } })).toBeNull();
    expect(templateAssetIdFrom(null)).toBeNull();
  });
});
