import { buildCarouselSendComponent, carouselImageKeys } from './carousel-send';

/**
 * Sending an approved carousel.
 *
 * The trap this file exists for: creating a carousel names each picture by
 * asset HANDLE, sending it names the same picture by MEDIA ID, and Meta
 * accepts neither in the other's place. A template can therefore be approved
 * and still be unsendable, and nobody finds out until the first send.
 */
describe('the carousel send component', () => {
  const cards = [{ mediaId: 'media-1' }, { mediaId: 'media-2' }];

  it('indexes the cards positionally, because Meta matches them that way', () => {
    const c = buildCarouselSendComponent(cards);
    expect(c.type).toBe('carousel');
    expect(c.cards.map((x) => x.card_index)).toEqual([0, 1]);
  });

  it('names each picture by media id, not by the creation handle', () => {
    const c = buildCarouselSendComponent(cards);
    expect(c.cards[0].components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { id: 'media-1' } }],
    });
  });

  it('sends no body parameters when a card has no variables', () => {
    const c = buildCarouselSendComponent(cards);
    expect(c.cards[0].components).toHaveLength(1);
  });

  it('fills a card body in order', () => {
    const c = buildCarouselSendComponent([{ mediaId: 'm', bodyParameters: ['Solitaire', '₹45,000'] }]);
    expect(c.cards[0].components[1]).toEqual({
      type: 'body',
      parameters: [
        { type: 'text', text: 'Solitaire' },
        { type: 'text', text: '₹45,000' },
      ],
    });
  });

  it('indexes a url button by its position on THAT card', () => {
    // Not its position among every button in the template — a mistake that
    // sends the second card's link with the first card's picture.
    const c = buildCarouselSendComponent([{ mediaId: 'm', urlSuffixes: { 1: 'BLUE_ELF' } }]);
    expect(c.cards[0].components[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: 1,
      parameters: [{ type: 'text', text: 'BLUE_ELF' }],
    });
  });

  it('refuses to build an empty carousel', () => {
    expect(() => buildCarouselSendComponent([])).toThrow(/at least one card/);
  });
});

describe('deciding whether a template is a carousel', () => {
  it('recognises one from the keys recorded at submission', () => {
    expect(carouselImageKeys({ cardImageKeys: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it.each([
    ['an ordinary template', {}],
    ['no metadata at all', null],
    ['a single key, which is a header not a carousel', { cardImageKeys: ['a'] }],
    ['a card whose image was never stored', { cardImageKeys: ['a', null] }],
    ['keys of the wrong type', { cardImageKeys: [1, 2] }],
    ['not an array', { cardImageKeys: 'a,b' }],
  ])('returns nothing for %s', (_label, metadata) => {
    // Every one of these must fall back to an ordinary send rather than build
    // a carousel with holes in it.
    expect(carouselImageKeys(metadata)).toBeNull();
  });
});
