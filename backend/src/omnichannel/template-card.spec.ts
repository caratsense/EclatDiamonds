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
 *
 * And, since 28 Nov, that it never shows a {{n}}. The client sent `newmessage`
 * from a thread with "Sneha" typed into its one variable; the send stored no
 * parameters, the template was back under review at Meta so nothing was
 * delivered, and the thread still read "Hello {{1}}, hope you are having a good
 * day!". She reasonably concluded a customer had been sent a literal {{1}}.
 * A customer-facing transcript may not show an unsubstituted placeholder.
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

  it('shows a gap for a slot this send did not record, never the {{n}}', () => {
    // 28 Nov: the client sent `newmessage` with "Sneha" typed into {{1}}, the
    // send stored no parameters, the template was under review at Meta so
    // nothing went out — and the thread drew "Hello {{1}}, hope you are having
    // a good day!". She read that as a customer having received our markup.
    const card = templateCardFrom('x', { bodySource: 'Hi {{1}}, see {{2}}.' }, ['Anjali']);
    expect(card?.body).toBe('Hi Anjali, see ….');
    expect(card?.body).not.toContain('{{');
  });

  it('shows a gap for every slot when the send recorded no parameters at all', () => {
    const card = templateCardFrom(
      'newmessage',
      { bodySource: 'Hello {{1}}, hope you are having a good day!' },
      [],
    );
    expect(card?.body).toBe('Hello …, hope you are having a good day!');
  });

  it('never renders a {{n}} from the preview either', () => {
    // The fallback path has to be held to the same rule: a synced preview that
    // kept its markers would otherwise have leaked one by the back door.
    const card = templateCardFrom('x', { bodyPreview: 'Hello {{1}}.' });
    expect(card?.body).toBe('Hello ….');
  });

  it('does not invent the name the send would have fallen back to', () => {
    // The template's own stand-in reads as a finished sentence, and on a send
    // that was blocked before it left, a finished sentence is indistinguishable
    // from a record of something the customer read. Nothing was read.
    const card = templateCardFrom(
      'newmessage',
      {
        bodySource: 'Hello {{1}}, hope you are having a good day!',
        bodyPreview: 'Hello Priya, hope you are having a good day!',
        variableDefaults: [{ slot: 1, source: 'customer_first_name', fallback: 'there' }],
      },
      [],
    );
    expect(card?.body).not.toContain('there,');
    expect(card?.body).not.toContain('Priya');
  });

  it('renders the malformed [[]] shape that the 28 Nov send stored as a gap', () => {
    // `templateComponents: [[]]` — an array holding an empty array. It carries
    // no body component, so there is nothing to substitute, and this is the
    // exact row that put a raw {{1}} on a customer's thread.
    const parameters = bodyParametersFrom([[]]);
    expect(parameters).toEqual([]);
    const card = templateCardFrom('newmessage', { bodySource: 'Hello {{1}}!' }, parameters);
    expect(card?.body).toBe('Hello …!');
  });

  it('is unaffected by the send having failed — a template with no variables is exact', () => {
    // Whether it went out is the delivery row's business, not this card's. A
    // template with no slots has nothing that could be missing, so a blocked
    // send still shows the approved wording and the refusal sits beneath it.
    const card = templateCardFrom('nailsevent', NAILS, []);
    expect(card?.body).toBe('Join us for our nail art event this Saturday!');
    expect(card?.body).not.toContain('…');
  });

  it('keeps a media-header template’s picture when its slot cannot be filled', () => {
    // The header is the invitation. A send whose body parameters went missing
    // must still show the photograph the customer was offered.
    const card = templateCardFrom(
      'festive_offer',
      { ...NAILS, bodySource: 'Hello {{1}}, our festive collection is in.' },
      [],
    );
    expect(card?.headerFormat).toBe('IMAGE');
    expect(card?.headerImageUrl).toBe('https://scontent.whatsapp.net/v/nails.jpg');
    expect(card?.body).toBe('Hello …, our festive collection is in.');
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

  it('reads nothing out of the malformed shape the 28 Nov send stored', () => {
    // `[[]]` is what the dialog wrote: an array holding an empty array where a
    // body component should have been. It must read as "no parameters" and not
    // throw on the way — this is a read of a row already in the database.
    const broken = { omnichannel: { templateComponents: [[]] } };
    expect(bodyParametersFrom(templateComponentsFrom(broken))).toEqual([]);
  });

  it('finds nothing on an ordinary typed message', () => {
    expect(templateAssetIdFrom({ omnichannel: { purpose: 'service' } })).toBeNull();
    expect(templateAssetIdFrom(null)).toBeNull();
  });
});
