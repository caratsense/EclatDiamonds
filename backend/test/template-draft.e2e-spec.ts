import {
  TemplateDraftError,
  buildTemplatePayload,
  placeholdersIn,
  previewOf,
} from '../src/omnichannel/template-draft';

/**
 * TURNING WHAT SOMEBODY TYPED INTO WHAT META WILL ACCEPT.
 *
 * Every rule here is one Meta enforces anyway. The difference is when, and in
 * whose words: Meta's rejection arrives hours later, written for developers
 * ("Param text cannot have new-line/tab characters or more than 4 consecutive
 * spaces"), and costs a review cycle. A person who pasted a formatted paragraph
 * into a box cannot act on that.
 *
 * Pure functions, no database and no network — a bad template is a rejection
 * that costs days, so this has to be testable without either.
 */
const ok = {
  name: 'appointment_reminder',
  languageCode: 'en_US',
  category: 'UTILITY' as const,
  body: 'Hi {{1}}, your appointment at {{2}} is confirmed. See you then.',
  examples: ['Priya', 'Bandra'],
};

const refuses = (draft: Parameters<typeof buildTemplatePayload>[0], match: RegExp) => {
  expect(() => buildTemplatePayload(draft)).toThrow(TemplateDraftError);
  expect(() => buildTemplatePayload(draft)).toThrow(match);
};

describe('template draft — the shape Meta accepts', () => {
  it('builds the payload Meta expects, with the example array it demands', () => {
    const payload = buildTemplatePayload(ok);

    expect(payload.name).toBe('appointment_reminder');
    expect(payload.language).toBe('en_US');
    expect(payload.category).toBe('UTILITY');

    const body = payload.components.find((c) => c.type === 'BODY')!;
    expect(body.text).toContain('{{1}}');
    // Meta's shape: body_text is an array OF arrays, one row per example set.
    // Getting this wrong is a rejection, not a validation error.
    expect(body.example).toEqual({ body_text: [['Priya', 'Bandra']] });
  });

  it('omits the example block entirely when there are no placeholders', () => {
    // Sending `example: { body_text: [[]] }` for a static template is rejected.
    const payload = buildTemplatePayload({ ...ok, body: 'Your order is ready to collect.', examples: [] });
    expect(payload.components.find((c) => c.type === 'BODY')!.example).toBeUndefined();
  });

  it('carries a header and footer through as their own components', () => {
    const payload = buildTemplatePayload({ ...ok, header: 'Appointment', footer: 'Éclat Diamonds' });
    expect(payload.components.map((c) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER']);
    expect(payload.components[0]).toMatchObject({ format: 'TEXT', text: 'Appointment' });
  });

  /* ------------------------------------------- the rejections worth catching */

  it('refuses a name Meta will not take, and suggests one it will', () => {
    refuses({ ...ok, name: 'Appointment Reminder!' }, /lowercase letters, numbers and underscores/);
    // The suggestion is the point: "invalid name" leaves somebody guessing.
    expect(() => buildTemplatePayload({ ...ok, name: 'Appointment Reminder!' })).toThrow(
      /appointment_reminder/,
    );
  });

  it('refuses placeholders that skip a number', () => {
    // Meta requires 1, 2, 3 with no gaps, and its rejection names the component
    // rather than the gap.
    refuses(
      { ...ok, body: 'Hi {{1}}, see you at {{3}}.', examples: ['Priya', 'Bandra'] },
      /no gaps.*\{\{3\}\}/s,
    );
  });

  it('refuses a template with variables and no sample values', () => {
    refuses({ ...ok, examples: [] }, /2 needed, 0 given/);
    refuses({ ...ok, examples: ['Priya'] }, /2 needed, 1 given/);
  });

  it('refuses a sample containing line breaks or long runs of spaces', () => {
    // This is Meta's rule verbatim, and the one its error message explains worst.
    refuses({ ...ok, examples: ['Priya\nSharma', 'Bandra'] }, /line breaks, tabs or long runs/);
    refuses({ ...ok, examples: ['Priya', 'Bandra     Store'] }, /line breaks, tabs or long runs/);
  });

  it('refuses a body that is nothing but placeholders', () => {
    // Passes every other check and is rejected a day later for having no
    // content of its own.
    refuses({ ...ok, body: '{{1}} {{2}}', examples: ['a', 'b'] }, /only placeholders/);
  });

  it('refuses a language code that is not one', () => {
    refuses({ ...ok, languageCode: 'english' }, /en_US, hi_IN or gu_IN/);
    refuses({ ...ok, languageCode: 'en-US' }, /en_US, hi_IN or gu_IN/);
  });

  it('accepts the Indian language codes this client will actually use', () => {
    for (const code of ['en_US', 'hi_IN', 'gu_IN', 'mr_IN', 'ta_IN']) {
      expect(buildTemplatePayload({ ...ok, languageCode: code }).language).toBe(code);
    }
  });

  it('refuses a body longer than Meta allows, and says by how much', () => {
    refuses({ ...ok, body: 'x'.repeat(1025), examples: [] }, /1025 characters; Meta allows 1024/);
  });

  it('refuses placeholders in a header or footer rather than half-supporting them', () => {
    // A header variable needs its own example array and a different shape.
    // Refusing beats a half-built version discovered by a rejection.
    refuses({ ...ok, header: 'Hi {{1}}' }, /header cannot contain placeholders/);
    refuses({ ...ok, footer: 'From {{1}}' }, /footer cannot contain placeholders/);
  });

  it('never silently repairs a draft', () => {
    // A template quietly altered on the way out is one whose approved text is
    // not the text anybody reviewed. The only normalisation is case and
    // trimming on the name, which Meta does itself.
    const payload = buildTemplatePayload({ ...ok, name: '  Appointment_Reminder  ' });
    expect(payload.name).toBe('appointment_reminder');
    expect(payload.components.find((c) => c.type === 'BODY')!.text).toBe(ok.body);
  });

  /* --------------------------------------------------------------- previews */

  it('reads the placeholders a body uses, in order and deduplicated', () => {
    expect(placeholdersIn('Hi {{1}}, your {{2}} at {{1}} is ready')).toEqual([1, 2]);
    expect(placeholdersIn('no variables here')).toEqual([]);
    expect(placeholdersIn('spaced {{ 3 }} too')).toEqual([3]);
  });

  it('shows a manager the sentence a customer will read, not "Hi {{1}}"', () => {
    expect(previewOf(ok.body, ok.examples)).toBe(
      'Hi Priya, your appointment at Bandra is confirmed. See you then.',
    );
  });

  it('leaves a placeholder visible when no example was given for it', () => {
    // Honest beats blank: a half-filled preview says which part is unknown.
    expect(previewOf('Hi {{1}}, see {{2}}', ['Priya'])).toBe('Hi Priya, see {{2}}');
  });
});
