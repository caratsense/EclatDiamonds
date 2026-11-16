import { TemplateCard, TemplateDraft, buildTemplatePayload } from './template-draft';

/**
 * Image headers and carousels.
 *
 * The client asked for what AiSensy offers: a picture on a template, and a row
 * of product cards. Every rule below is Meta's, and each one that is broken is
 * found a DAY later as a rejected template rather than at the keyboard — which
 * is the whole reason they are asserted here instead of discovered there.
 */

const HANDLE = '4::aW1hZ2U=';

const card = (over: Partial<TemplateCard> = {}): TemplateCard => ({
  headerHandle: HANDLE,
  buttons: [{ type: 'QUICK_REPLY', text: 'Show me more' }],
  ...over,
});

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: 'festive_collection',
  languageCode: 'en',
  category: 'MARKETING',
  body: 'Hello {{1}}, our festive collection is here.',
  examples: ['Priya'],
  ...over,
});

const build = (over: Partial<TemplateDraft> = {}) => buildTemplatePayload(draft(over));
const fails = (over: Partial<TemplateDraft>, match: RegExp) =>
  expect(() => build(over)).toThrow(match);

describe('an image header', () => {
  it('carries the asset handle Meta reviews', () => {
    const payload = build({ headerFormat: 'IMAGE', headerHandle: HANDLE });
    expect(payload.components[0]).toEqual({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [HANDLE] },
    });
  });

  it('refuses to submit without the picture', () => {
    // Better here than as a rejection tomorrow.
    fails({ headerFormat: 'IMAGE' }, /Upload the header image/);
  });

  it('leaves a text header exactly as it was', () => {
    const payload = build({ header: 'Nibhana' });
    expect(payload.components[0]).toEqual({ type: 'HEADER', format: 'TEXT', text: 'Nibhana' });
  });
});

describe('a carousel', () => {
  const cards = [card(), card()];

  it('puts the cards after the message, each with its own picture and buttons', () => {
    const payload = build({ cards });
    const carousel = payload.components.find((c) => c.type === 'CAROUSEL');
    expect(carousel?.cards).toHaveLength(2);
    expect(carousel?.cards?.[0].components[0]).toEqual({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [HANDLE] },
    });
    expect(carousel?.cards?.[0].components[1]).toEqual({
      type: 'BUTTONS',
      buttons: [{ type: 'quick_reply', text: 'Show me more' }],
    });
  });

  it('keeps the shared message above the cards', () => {
    const payload = build({ cards });
    expect(payload.components[0].type).toBe('BODY');
  });

  describe('the rules Meta enforces a day late', () => {
    it('needs at least two cards', () => {
      fails({ cards: [card()] }, /One picture is a header, not a carousel/);
    });

    it('allows at most ten', () => {
      fails({ cards: Array.from({ length: 11 }, () => card()) }, /between 2 and 10 cards/);
    });

    it('is marketing only', () => {
      fails({ cards, category: 'UTILITY' }, /carousel is a marketing template/);
    });

    it('cannot also have a header of its own', () => {
      fails({ cards, header: 'Nibhana' }, /cannot have a header too/);
      fails({ cards, headerFormat: 'IMAGE', headerHandle: HANDLE }, /cannot have a header too/);
    });

    it('wants a picture on every card', () => {
      fails({ cards: [card(), card({ headerHandle: '' })] }, /Card 2 has no picture/);
    });

    it('wants text on all cards or none', () => {
      // Meta's reason: every card must be the same height on the screen.
      fails({ cards: [card({ body: 'Solitaire' }), card()] }, /every card has a line of text or none/);
    });

    it('accepts text on all cards', () => {
      const payload = build({ cards: [card({ body: 'Solitaire' }), card({ body: 'Bangles' })] });
      const first = payload.components.find((c) => c.type === 'CAROUSEL')?.cards?.[0];
      expect(first?.components[1]).toEqual({ type: 'BODY', text: 'Solitaire' });
    });

    it('wants between one and two buttons per card', () => {
      fails({ cards: [card({ buttons: [] }), card()] }, /needs 1 or 2/);
      fails(
        {
          cards: [
            card({
              buttons: [
                { type: 'QUICK_REPLY', text: 'a' },
                { type: 'QUICK_REPLY', text: 'b' },
                { type: 'QUICK_REPLY', text: 'c' },
              ],
            }),
            card(),
          ],
        },
        /needs 1 or 2/,
      );
    });

    it('wants the same buttons on every card', () => {
      fails(
        { cards: [card(), card({ buttons: [{ type: 'URL', text: 'Shop', url: 'https://x.in' }] })] },
        /same buttons/,
      );
    });
  });

  describe('buttons', () => {
    const urlCards = (over: Partial<TemplateCard> = {}) => [
      card({ buttons: [{ type: 'URL', text: 'Shop', url: 'https://nibhana.in/rings' }] }),
      card({ buttons: [{ type: 'URL', text: 'Shop', url: 'https://nibhana.in/bangles' }], ...over }),
    ];

    it('sends a link button with its url', () => {
      const payload = build({ cards: urlCards() });
      const buttons = payload.components.find((c) => c.type === 'CAROUSEL')?.cards?.[0]
        .components.find((c) => c.type === 'BUTTONS')?.buttons;
      expect(buttons).toEqual([{ type: 'url', text: 'Shop', url: 'https://nibhana.in/rings' }]);
    });

    it('needs a sample when the link carries a variable', () => {
      fails(
        {
          cards: [
            card({ buttons: [{ type: 'URL', text: 'Shop', url: 'https://nibhana.in/{{1}}' }] }),
            card({ buttons: [{ type: 'URL', text: 'Shop', url: 'https://nibhana.in/{{1}}' }] }),
          ],
        },
        /sample value/,
      );
    });

    it('refuses a link button with no link', () => {
      fails(
        {
          cards: [
            card({ buttons: [{ type: 'URL', text: 'Shop' }] }),
            card({ buttons: [{ type: 'URL', text: 'Shop' }] }),
          ],
        },
        /needs a link/,
      );
    });

    it('refuses an over-long label', () => {
      const long = 'x'.repeat(26);
      fails(
        { cards: [card({ buttons: [{ type: 'QUICK_REPLY', text: long }] }), card()] },
        /button label allows 25/,
      );
    });
  });
});

describe('nothing changed for an ordinary template', () => {
  it('still builds header, body and footer', () => {
    const payload = build({ header: 'Nibhana', footer: 'Reply STOP to opt out' });
    expect(payload.components.map((c) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER']);
  });
});
