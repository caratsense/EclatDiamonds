import { buildTemplatePayload, type TemplateDraft } from './template-draft';

/**
 * Tappable buttons under a template message.
 *
 * The client asked for these after reviewing the feedback template: a form
 * link sitting as plain text in the body reads worse than a "Give feedback"
 * button, and WhatsApp renders the button as a real control rather than a
 * guessable URL.
 *
 * Buttons already existed per carousel card. What was missing was buttons on
 * an ordinary message, which is the shape every template they actually send
 * uses.
 */

const base: TemplateDraft = {
  name: 'nibhana_feedback_request_v2',
  languageCode: 'en',
  category: 'UTILITY',
  body: 'Dear {{1}}, how was your visit?',
  examples: ['Priya'],
};

const buttonsOf = (draft: TemplateDraft) =>
  buildTemplatePayload(draft).components.find((c) => c.type === 'BUTTONS')?.buttons;

describe('a URL button', () => {
  it('reaches Meta in the shape it wants', () => {
    expect(
      buttonsOf({
        ...base,
        buttons: [{ type: 'URL', text: 'Give feedback', url: 'https://forms.gle/qerbyu1pCLe7uwt39' }],
      }),
    ).toEqual([{ type: 'url', text: 'Give feedback', url: 'https://forms.gle/qerbyu1pCLe7uwt39' }]);
  });

  it('needs a link', () => {
    expect(() => buildTemplatePayload({ ...base, buttons: [{ type: 'URL', text: 'Open' }] })).toThrow(
      /needs a link/,
    );
  });

  it('refuses a link that is not http', () => {
    expect(() =>
      buildTemplatePayload({ ...base, buttons: [{ type: 'URL', text: 'Open', url: 'forms.gle/x' }] }),
    ).toThrow(/must start with http/);
  });

  it('carries a sample when the link ends in a variable', () => {
    expect(
      buttonsOf({
        ...base,
        buttons: [
          { type: 'URL', text: 'Track', url: 'https://nibhana.in/o/{{1}}', urlExample: 'AB1234' },
        ],
      }),
    ).toEqual([
      { type: 'url', text: 'Track', url: 'https://nibhana.in/o/{{1}}', example: ['AB1234'] },
    ]);
  });

  it('refuses a variable link with no sample, which Meta rejects a day later', () => {
    expect(() =>
      buildTemplatePayload({
        ...base,
        buttons: [{ type: 'URL', text: 'Track', url: 'https://nibhana.in/o/{{1}}' }],
      }),
    ).toThrow(/sample value/);
  });

  it('refuses more than one variable in a link', () => {
    expect(() =>
      buildTemplatePayload({
        ...base,
        buttons: [
          { type: 'URL', text: 'Track', url: 'https://nibhana.in/{{1}}/{{2}}', urlExample: 'x' },
        ],
      }),
    ).toThrow(/at most one/);
  });
});

describe('a quick reply button', () => {
  it('needs no link', () => {
    expect(buttonsOf({ ...base, buttons: [{ type: 'QUICK_REPLY', text: 'Not now' }] })).toEqual([
      { type: 'quick_reply', text: 'Not now' },
    ]);
  });
});

describe('what a template may carry', () => {
  it('allows two buttons', () => {
    expect(
      buttonsOf({
        ...base,
        buttons: [
          { type: 'URL', text: 'Give feedback', url: 'https://forms.gle/x' },
          { type: 'QUICK_REPLY', text: 'Not now' },
        ],
      }),
    ).toHaveLength(2);
  });

  it('refuses three', () => {
    expect(() =>
      buildTemplatePayload({
        ...base,
        buttons: [
          { type: 'QUICK_REPLY', text: 'A' },
          { type: 'QUICK_REPLY', text: 'B' },
          { type: 'QUICK_REPLY', text: 'C' },
        ],
      }),
    ).toThrow(/at most 2 buttons/);
  });

  it('refuses a label over 25 characters, as Meta does', () => {
    expect(() =>
      buildTemplatePayload({
        ...base,
        buttons: [{ type: 'QUICK_REPLY', text: 'a'.repeat(26) }],
      }),
    ).toThrow(/25/);
  });

  it('refuses an empty label', () => {
    expect(() =>
      buildTemplatePayload({ ...base, buttons: [{ type: 'QUICK_REPLY', text: '  ' }] }),
    ).toThrow(/label/);
  });

  it('refuses message buttons on a carousel, which puts them on each card', () => {
    expect(() =>
      buildTemplatePayload({
        ...base,
        category: 'MARKETING',
        headerFormat: 'IMAGE',
        headerHandle: '4::aW1hZ2UvanBlZw==',
        buttons: [{ type: 'QUICK_REPLY', text: 'Hi' }],
        cards: [
          { headerHandle: 'h1', buttons: [{ type: 'QUICK_REPLY', text: 'A' }] },
          { headerHandle: 'h2', buttons: [{ type: 'QUICK_REPLY', text: 'A' }] },
        ],
      }),
    ).toThrow(/on each card/);
  });
});

describe('a template with no buttons', () => {
  it('emits no BUTTONS component at all', () => {
    // The two templates already approved for Nibhana have none; adding an
    // empty component would change payloads that Meta has accepted.
    expect(buildTemplatePayload(base).components.some((c) => c.type === 'BUTTONS')).toBe(false);
    expect(buttonsOf({ ...base, buttons: [] })).toBeUndefined();
  });

  it('still orders header, body and footer as before', () => {
    const out = buildTemplatePayload({ ...base, header: 'Nibhana', footer: 'Team Nibhana' });
    expect(out.components.map((c) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER']);
  });

  it('puts buttons after the footer when there are some', () => {
    const out = buildTemplatePayload({
      ...base,
      footer: 'Team Nibhana',
      buttons: [{ type: 'URL', text: 'Give feedback', url: 'https://forms.gle/x' }],
    });
    expect(out.components.map((c) => c.type)).toEqual(['BODY', 'FOOTER', 'BUTTONS']);
  });
});
