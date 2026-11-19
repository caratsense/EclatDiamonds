import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { SubmitMessageTemplateDto } from './dto/omnichannel.dto';

/**
 * A CTA button could be typed and never submitted.
 *
 * `TemplateDraft` grew `buttons`, the editor sent them, `buildTemplatePayload`
 * turned them into Meta's BUTTONS component -- and the DTO in between never
 * declared the field. The pipe runs with `forbidNonWhitelisted`, so every
 * submission carrying a button came back 400 "property buttons should not
 * exist". Nothing in the type system connects a DTO to the draft interface, and
 * no unit test touched the DTO, so the whole path was green.
 *
 * These assertions run validation with the SAME options main.ts gives the pipe.
 * Dropping `forbidNonWhitelisted` here would make the test pass against the
 * exact bug it exists to catch.
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

const errorsFor = (payload: Record<string, unknown>) =>
  validateSync(plainToInstance(SubmitMessageTemplateDto, payload), PIPE_OPTIONS).map(
    (e) => e.property,
  );

const draft = {
  name: 'nibhana_feedback_request_v1',
  languageCode: 'en_US',
  category: 'UTILITY',
  body: 'Hello {{1}}, how was your visit to {{2}}?',
  examples: ['Priya', 'Bandra'],
  footer: 'Nibhana Jewels',
};

describe('SubmitMessageTemplateDto', () => {
  it('accepts a template with a CTA button', () => {
    expect(
      errorsFor({
        ...draft,
        buttons: [{ type: 'URL', text: 'Give feedback', url: 'https://forms.gle/abc' }],
      }),
    ).toEqual([]);
  });

  it('accepts two buttons, which is the documented ceiling', () => {
    expect(
      errorsFor({
        ...draft,
        buttons: [
          { type: 'URL', text: 'Give feedback', url: 'https://forms.gle/abc' },
          { type: 'QUICK_REPLY', text: 'Not now' },
        ],
      }),
    ).toEqual([]);
  });

  it('refuses a third button', () => {
    expect(
      errorsFor({
        ...draft,
        buttons: [
          { type: 'QUICK_REPLY', text: 'One' },
          { type: 'QUICK_REPLY', text: 'Two' },
          { type: 'QUICK_REPLY', text: 'Three' },
        ],
      }),
    ).toContain('buttons');
  });

  it('still refuses a field nobody declared', () => {
    // The guard that caught `buttons` is worth keeping; this is the proof it
    // was not switched off to make the case above pass.
    expect(errorsFor({ ...draft, approvalStatus: 'approved' })).toContain('approvalStatus');
  });

  it('accepts an image header with its upload handle', () => {
    expect(
      errorsFor({ ...draft, headerFormat: 'IMAGE', headerHandle: '4::aW1hZ2UvanBlZw==' }),
    ).toEqual([]);
  });

  it('accepts a carousel', () => {
    expect(
      errorsFor({
        ...draft,
        cards: [
          { headerHandle: 'h1', body: 'Bridal set', buttons: [{ type: 'QUICK_REPLY', text: 'Show' }] },
          { headerHandle: 'h2', body: 'Daily wear', buttons: [{ type: 'QUICK_REPLY', text: 'Show' }] },
        ],
      }),
    ).toEqual([]);
  });
});
