/**
 * Turning what somebody typed into what Meta will accept.
 *
 * Pure functions, no database and no network: this is where a bad template
 * becomes a rejection that costs days of review time, so it has to be testable
 * without either.
 *
 * ## Why validate at all, when Meta validates
 *
 * Because Meta's rejections arrive hours later, are written for developers, and
 * cost a review cycle each. "Param text cannot have new-line/tab characters or
 * more than 4 consecutive spaces" is a real Meta error message; a person who
 * pasted a formatted paragraph into a box has no way to act on it. Every rule
 * below is one Meta enforces anyway — the difference is that here it is caught
 * before submission, in words about the thing they typed.
 */

/** What Meta will file the template under. Drives pricing and review strictness. */
export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** What sits above the message: a line of text, or a picture. */
export const HEADER_FORMATS = ['TEXT', 'IMAGE'] as const;
export type HeaderFormat = (typeof HEADER_FORMATS)[number];

/**
 * A button on a carousel card.
 *
 * Meta allows quick_reply, url and phone_number. Only the first two are
 * offered: a phone button on a jewellery carousel would ring the branch from a
 * card the customer is still browsing, and nobody has asked for it.
 */
export interface TemplateButton {
  type: 'QUICK_REPLY' | 'URL';
  text: string;
  /** URL buttons only. May carry a single `{{1}}` for a per-send suffix. */
  url?: string;
  /** The sample Meta reviews the URL variable with. */
  urlExample?: string;
}

/**
 * One product card in a carousel.
 *
 * `headerHandle` is NOT a URL and NOT a media id. It is the asset handle the
 * Resumable Upload API returns, which is the only thing Meta accepts when a
 * template is CREATED — see MetaUploadService.
 */
export interface TemplateCard {
  headerHandle: string;
  /**
   * Where we kept the same picture.
   *
   * The handle gets the template approved; SENDING it needs a media id, which
   * only exists after the image is uploaded again to the phone number's media
   * store. Without this the card could be approved and never sent.
   */
  imageStorageKey?: string;
  /** Optional, but all-or-nothing across the carousel — see the builder. */
  body?: string;
  bodyExamples?: string[];
  buttons: TemplateButton[];
}

export interface TemplateDraft {
  /** Lowercase, digits and underscores. Meta's own constraint, not ours. */
  name: string;
  /** Meta language code: `en_US`, `hi_IN`, `gu_IN`. */
  languageCode: string;
  category: TemplateCategory;
  /** The message. `{{1}}`, `{{2}}` … are filled in per recipient at send time. */
  body: string;
  /** One line above the message. Plain text only here; no variables. */
  header?: string;
  /**
   * Up to two tappable buttons under the message.
   *
   * The client asked for these by name: a feedback request whose form link is
   * plain text in the body reads as a worse message than one with a "Give
   * feedback" button, and WhatsApp renders the button as a real control.
   *
   * Two is a deliberate floor rather than Meta's ceiling. Meta's combined
   * button rules vary by type and change; two URL-or-quick-reply buttons is
   * inside every variant of them, and is what the carousel already allows per
   * card, so the two paths agree.
   */
  buttons?: TemplateButton[];
  /** TEXT uses `header`; IMAGE uses `headerHandle`. Defaults to TEXT. */
  headerFormat?: HeaderFormat;
  /** The uploaded asset handle for an IMAGE header. */
  headerHandle?: string;
  /** Where that same picture was kept, so it can be sent later. */
  headerImageStorageKey?: string;
  /** One small line below it. Usually the shop name. */
  footer?: string;
  /**
   * A realistic value for each placeholder, in order. Meta REQUIRES these when
   * the body has any, and rejects the submission outright without them.
   */
  examples?: string[];
  /**
   * 2–10 product cards. Present means this is a carousel, which changes the
   * shape of the whole template: the body sits ABOVE the cards and each card
   * carries its own picture and buttons.
   */
  cards?: TemplateCard[];
}

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | 'CAROUSEL';
  format?: HeaderFormat;
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
    header_handle?: string[];
  };
  buttons?: {
    type: 'quick_reply' | 'url';
    text: string;
    url?: string;
    example?: string[];
  }[];
  cards?: { components: TemplateComponent[] }[];
}

export interface MetaTemplatePayload {
  name: string;
  language: string;
  category: TemplateCategory;
  components: TemplateComponent[];
}

/** Meta's limits, named so a message can quote the number rather than a magic one. */
const MAX_NAME = 512;
const MAX_BODY = 1024;
const MAX_HEADER = 60;
const MAX_FOOTER = 60;
const MAX_VARIABLES = 10;
/** Carousel limits, all Meta's. One card is a header; eleven is refused. */
const MIN_CARDS = 2;
const MAX_CARDS = 10;
const MAX_CARD_BUTTONS = 2;
const MAX_CARD_BODY = 160;
const MAX_BUTTON_TEXT = 25;

/** See TemplateDraft.buttons — a floor Meta always permits, not its ceiling. */
const MAX_TEMPLATE_BUTTONS = 2;

/**
 * One button in the shape Meta wants, validated on the way.
 *
 * Shared by the message-level buttons and the carousel's per-card ones so a
 * rule fixed in one is fixed in both — the label length and the URL example
 * were already duplicated once.
 */
function metaButton(b: TemplateButton): NonNullable<TemplateComponent['buttons']>[number] {
  const text = (b.text ?? '').trim();
  if (!text) fail('Give every button a label.');
  if (text.length > MAX_BUTTON_TEXT) {
    fail(`The button "${text}" is ${text.length} characters; Meta allows ${MAX_BUTTON_TEXT}.`);
  }
  if (b.type === 'QUICK_REPLY') return { type: 'quick_reply', text };

  const url = (b.url ?? '').trim();
  if (!url) fail(`The button "${text}" needs a link.`);
  if (!/^https?:\/\//i.test(url)) {
    fail(`The link on "${text}" must start with http:// or https://.`);
  }
  const vars = placeholdersIn(url);
  if (vars.length > 1 || (vars.length === 1 && vars[0] !== 1)) {
    fail(`A link may carry at most one {{1}} at its end. "${url}" does not.`);
  }
  if (vars.length === 1) {
    const sample = (b.urlExample ?? '').trim();
    // Meta reviews the variable with a real value; without one it rejects a
    // day later, which is the slowest possible way to learn this.
    if (!sample) fail(`Give a sample value for the {{1}} in the link on "${text}".`);
    return { type: 'url', text, url, example: [sample] };
  }
  return { type: 'url', text, url };
}

const NAME_RE = /^[a-z0-9_]+$/;
const LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const PLACEHOLDER_RE = /\{\{\s*(\d+)\s*\}\}/g;

export class TemplateDraftError extends Error {}

const fail = (message: string): never => {
  throw new TemplateDraftError(message);
};

/**
 * Which placeholders the body uses, in the order Meta expects to see them.
 *
 * Meta requires them to be sequential from 1 with no gaps. A body reading
 * "Hi {{1}}, see you at {{3}}" is rejected, and the reason it gives names the
 * component rather than the gap — so the gap is found here instead.
 */
export function placeholdersIn(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Build the payload Meta's `POST /{waba-id}/message_templates` expects.
 *
 * Throws `TemplateDraftError` with a sentence a person can act on. Never
 * silently repairs: a template that was quietly altered on the way out is one
 * whose approved text is not the text anybody reviewed.
 */
export function buildTemplatePayload(draft: TemplateDraft): MetaTemplatePayload {
  const name = (draft.name ?? '').trim().toLowerCase();
  if (!name) fail('Give the template a name.');
  if (name.length > MAX_NAME) fail(`A template name cannot be longer than ${MAX_NAME} characters.`);
  if (!NAME_RE.test(name)) {
    fail(
      'A template name can only use lowercase letters, numbers and underscores. ' +
        `"${draft.name}" has something else in it — try "${name.replace(/[^a-z0-9_]+/g, '_')}".`,
    );
  }

  const languageCode = (draft.languageCode ?? '').trim();
  if (!LANGUAGE_RE.test(languageCode)) {
    fail(`"${draft.languageCode}" is not a Meta language code. Use a form like en_US, hi_IN or gu_IN.`);
  }

  if (!TEMPLATE_CATEGORIES.includes(draft.category)) {
    fail(`Choose a category: ${TEMPLATE_CATEGORIES.join(', ')}.`);
  }

  const body = (draft.body ?? '').trim();
  if (!body) fail('A template needs a message body.');
  if (body.length > MAX_BODY) {
    fail(`The message body is ${body.length} characters; Meta allows ${MAX_BODY}.`);
  }
  /*
   * Meta refuses newlines, tabs and runs of 4+ spaces INSIDE a placeholder's
   * example, and refuses a body that is nothing but placeholders. The second
   * one catches a real mistake: a body of "{{1}}" passes every other check and
   * is rejected a day later as having no content of its own.
   */
  if (!body.replace(PLACEHOLDER_RE, '').trim()) {
    fail('The message cannot be only placeholders — write the sentence around them.');
  }

  const used = placeholdersIn(body);
  if (used.length > MAX_VARIABLES) {
    fail(`A template can use at most ${MAX_VARIABLES} placeholders; this one uses ${used.length}.`);
  }
  for (let i = 0; i < used.length; i += 1) {
    if (used[i] !== i + 1) {
      fail(
        `Placeholders must run 1, 2, 3 with no gaps. This message jumps to {{${used[i]}}} — ` +
          `renumber them starting at {{1}}.`,
      );
    }
  }

  const examples = (draft.examples ?? []).map((e) => (e ?? '').trim());
  if (used.length) {
    if (examples.length !== used.length) {
      fail(
        `Give an example for each placeholder: ${used.length} needed, ${examples.length} given. ` +
          'Meta rejects a template with variables and no sample values.',
      );
    }
    for (const [i, value] of examples.entries()) {
      if (!value) fail(`Give a sample value for {{${i + 1}}}.`);
      if (/[\n\t]/.test(value) || /\s{4,}/.test(value)) {
        fail(`The sample for {{${i + 1}}} cannot contain line breaks, tabs or long runs of spaces.`);
      }
    }
  }

  const components: TemplateComponent[] = [];

  const headerFormat: HeaderFormat = draft.headerFormat ?? 'TEXT';
  if (headerFormat === 'IMAGE') {
    /*
     * A picture above the message. The handle comes from the Resumable Upload
     * API, never from our own media store: the id returned by
     * `/{phone-number-id}/media` works when SENDING and is rejected when
     * CREATING, which is a confusing afternoon if you only learn it from Meta's
     * error.
     */
    if (!draft.headerHandle?.trim()) {
      fail('Upload the header image before submitting this template.');
    }
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [draft.headerHandle!.trim()] },
    });
  } else {
    const header = (draft.header ?? '').trim();
    if (header) {
      if (header.length > MAX_HEADER) {
        fail(`The header is ${header.length} characters; Meta allows ${MAX_HEADER}.`);
      }
      // Variables in a header need their own example array and a different
      // shape. Refused rather than supported: nobody has asked for one, and a
      // half-built version would be discovered by a rejection rather than by a
      // message here.
      if (placeholdersIn(header).length) {
        fail('A header cannot contain placeholders. Put the variable part in the message instead.');
      }
      components.push({ type: 'HEADER', format: 'TEXT', text: header });
    }
  }

  components.push({
    type: 'BODY',
    text: body,
    ...(used.length ? { example: { body_text: [examples] } } : {}),
  });

  const footer = (draft.footer ?? '').trim();
  if (footer) {
    if (footer.length > MAX_FOOTER) {
      fail(`The footer is ${footer.length} characters; Meta allows ${MAX_FOOTER}.`);
    }
    if (placeholdersIn(footer).length) {
      fail('A footer cannot contain placeholders.');
    }
    components.push({ type: 'FOOTER', text: footer });
  }

  const buttons = draft.buttons ?? [];
  if (buttons.length) {
    if (draft.cards?.length) {
      // A carousel carries buttons on each CARD. A template-level set as well
      // means two different things claim the same row on the screen.
      fail('A carousel template puts its buttons on each card, not on the message.');
    }
    if (buttons.length > MAX_TEMPLATE_BUTTONS) {
      fail(`A template can have at most ${MAX_TEMPLATE_BUTTONS} buttons; this one has ${buttons.length}.`);
    }
    components.push({ type: 'BUTTONS', buttons: buttons.map(metaButton) });
  }

  if (draft.cards?.length) {
    components.push(buildCarousel(draft, headerFormat));
  }

  return { name, language: languageCode, category: draft.category, components };
}

/**
 * The carousel component: the row of product cards under the message.
 *
 * Meta's rules, each of which is a rejection a day later if broken, so each is
 * a sentence here instead:
 *   - 2 to 10 cards. One card is not a carousel; eleven is refused.
 *   - MARKETING only.
 *   - every card must have the SAME components as every other, so a body on
 *     one means a body on all, and the buttons must match in number and kind.
 *   - 1 to 2 buttons per card.
 *   - a carousel replaces the template's own header, so there cannot be both.
 */
function buildCarousel(draft: TemplateDraft, headerFormat: HeaderFormat): TemplateComponent {
  const cards = draft.cards ?? [];

  if (draft.category !== 'MARKETING') {
    fail(
      `A carousel is a marketing template; this one is ${draft.category}. ` +
        'Change the category to Marketing, or remove the cards.',
    );
  }
  if (cards.length < MIN_CARDS || cards.length > MAX_CARDS) {
    fail(
      `A carousel needs between ${MIN_CARDS} and ${MAX_CARDS} cards; this one has ${cards.length}.` +
        (cards.length === 1 ? ' One picture is a header, not a carousel.' : ''),
    );
  }
  if (headerFormat === 'IMAGE' || draft.header?.trim()) {
    fail('A carousel carries the pictures on its cards, so the template itself cannot have a header too.');
  }

  const withBody = cards.filter((c) => c.body?.trim()).length;
  if (withBody && withBody !== cards.length) {
    // Meta's own words: all cards must have the same components, so that every
    // card is the same height on the customer's screen.
    fail(
      `Either every card has a line of text or none do — ${withBody} of ${cards.length} have one.`,
    );
  }

  const shape = (c: TemplateCard) => c.buttons.map((b) => b.type).join(',');
  const firstShape = shape(cards[0]);
  cards.forEach((card, i) => {
    const n = i + 1;
    if (!card.headerHandle?.trim()) fail(`Card ${n} has no picture.`);
    if (card.buttons.length < 1 || card.buttons.length > MAX_CARD_BUTTONS) {
      fail(`Card ${n} has ${card.buttons.length} buttons; a card needs 1 or ${MAX_CARD_BUTTONS}.`);
    }
    if (shape(card) !== firstShape) {
      fail(
        `Every card must carry the same buttons. Card 1 has ${firstShape || 'none'} and card ${n} has ${shape(card) || 'none'}.`,
      );
    }
    for (const button of card.buttons) {
      if (!button.text.trim()) fail(`A button on card ${n} has no label.`);
      if (button.text.length > MAX_BUTTON_TEXT) {
        fail(`"${button.text}" is ${button.text.length} characters; a button label allows ${MAX_BUTTON_TEXT}.`);
      }
      if (button.type === 'URL' && !button.url?.trim()) {
        fail(`The "${button.text}" button on card ${n} needs a link.`);
      }
      if (button.type === 'URL' && placeholdersIn(button.url ?? '').length && !button.urlExample?.trim()) {
        fail(`The link on card ${n} has a {{1}}, so Meta needs a sample value for it.`);
      }
    }
    if (card.body && card.body.length > MAX_CARD_BODY) {
      fail(`Card ${n}'s text is ${card.body.length} characters; Meta allows ${MAX_CARD_BODY}.`);
    }
  });

  return {
    type: 'CAROUSEL',
    cards: cards.map((card) => {
      const parts: TemplateComponent[] = [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: [card.headerHandle.trim()] } },
      ];
      if (card.body?.trim()) {
        const used = placeholdersIn(card.body);
        const examples = (card.bodyExamples ?? []).map((e) => (e ?? '').trim());
        if (used.length && examples.length !== used.length) {
          fail(`Give a sample for each {{n}} on a card: ${used.length} needed, ${examples.length} given.`);
        }
        parts.push({
          type: 'BODY',
          text: card.body.trim(),
          ...(used.length ? { example: { body_text: [examples] } } : {}),
        });
      }
      // Same converter the message-level buttons use. The loop above has
      // already refused the card-specific problems with better wording; this
      // adds the rules both kinds share, including the http:// check the
      // carousel never made.
      parts.push({ type: 'BUTTONS', buttons: card.buttons.map(metaButton) });
      return { components: parts };
    }),
  };
}

/**
 * What the inbox shows for a template nobody has sent yet.
 *
 * The placeholders are replaced with the submitted examples, so a manager
 * picking a template in the campaign wizard reads the sentence a customer will
 * read rather than "Hi {{1}}". Falls back to the raw body when there are no
 * examples, which is the honest answer rather than a blank.
 */
export function previewOf(body: string, examples: string[] = []): string {
  return body.replace(PLACEHOLDER_RE, (whole, digits: string) => {
    const value = examples[Number(digits) - 1];
    return value?.trim() ? value.trim() : whole;
  });
}
