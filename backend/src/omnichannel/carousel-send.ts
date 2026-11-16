/**
 * The `carousel` component of a SEND, which is a different shape from the one
 * used to create the template.
 *
 * Creation names each card's picture by asset HANDLE, because Meta reviews the
 * actual image before approving. Sending names it by MEDIA ID, because by then
 * the template is approved and what is left is delivering a specific picture
 * to a specific person. The two identifiers are not interchangeable and Meta
 * accepts neither in the other's place.
 *
 * Kept as a pure function so the exact JSON can be asserted without a network,
 * a tenant or an approved template to hand.
 */

export interface CarouselCardMedia {
  /** From `/{phone-number-id}/media`, uploaded fresh for this send. */
  mediaId: string;
  /** Values for `{{n}}` in the CARD's own body, in order. */
  bodyParameters?: string[];
  /**
   * Values for a URL button's `{{1}}` suffix, by button index.
   * A quick-reply button takes a payload instead and is left alone here.
   */
  urlSuffixes?: Record<number, string>;
}

export interface CarouselComponent {
  type: 'carousel';
  cards: {
    card_index: number;
    components: unknown[];
  }[];
}

/**
 * Build the component. `cards` must be in the SAME order they were created in
 * — Meta matches them positionally by `card_index`, so a reordered array
 * silently sends the wrong picture with the wrong words.
 */
export function buildCarouselSendComponent(cards: CarouselCardMedia[]): CarouselComponent {
  if (!cards.length) {
    throw new Error('A carousel send needs at least one card.');
  }
  return {
    type: 'carousel',
    cards: cards.map((card, index) => {
      const components: unknown[] = [
        {
          type: 'header',
          parameters: [{ type: 'image', image: { id: card.mediaId } }],
        },
      ];

      if (card.bodyParameters?.length) {
        components.push({
          type: 'body',
          parameters: card.bodyParameters.map((text) => ({ type: 'text', text })),
        });
      }

      // Only a URL button carries a parameter at send time, and it is indexed
      // by its position among that card's buttons — not among all buttons.
      for (const [buttonIndex, suffix] of Object.entries(card.urlSuffixes ?? {})) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: Number(buttonIndex),
          parameters: [{ type: 'text', text: suffix }],
        });
      }

      return { card_index: index, components };
    }),
  };
}

/**
 * Is this template a carousel, and where are its pictures?
 *
 * Read from the asset metadata written at submission. A template whose keys
 * are missing or partly null cannot be sent as a carousel — saying so here is
 * better than sending cards with holes in them.
 */
export function carouselImageKeys(metadata: unknown): string[] | null {
  const keys = (metadata as { cardImageKeys?: unknown } | null)?.cardImageKeys;
  if (!Array.isArray(keys) || keys.length < 2) return null;
  if (!keys.every((k) => typeof k === 'string' && k.length > 0)) return null;
  return keys as string[];
}
