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
  /** One small line below it. Usually the shop name. */
  footer?: string;
  /**
   * A realistic value for each placeholder, in order. Meta REQUIRES these when
   * the body has any, and rejects the submission outright without them.
   */
  examples?: string[];
}

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER';
  format?: 'TEXT';
  text: string;
  example?: { header_text?: string[]; body_text?: string[][] };
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

  const header = (draft.header ?? '').trim();
  if (header) {
    if (header.length > MAX_HEADER) {
      fail(`The header is ${header.length} characters; Meta allows ${MAX_HEADER}.`);
    }
    // Variables in a header need their own example array and a different shape.
    // Refused rather than supported: nobody has asked for one, and a half-built
    // version would be discovered by a rejection rather than by a message here.
    if (placeholdersIn(header).length) {
      fail('A header cannot contain placeholders. Put the variable part in the message instead.');
    }
    components.push({ type: 'HEADER', format: 'TEXT', text: header });
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

  return { name, language: languageCode, category: draft.category, components };
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
