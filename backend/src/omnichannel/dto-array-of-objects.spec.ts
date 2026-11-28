/*
 * `@Type()` reads design-time metadata, which does not exist until this shim is
 * loaded. The unit suite boots no Nest container, so nothing loads it for us.
 * Same line, same reason, as template-submit-dto.spec.ts next door.
 */
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreateCampaignDto, UpdateCampaignDto } from '../crm/dto/campaign.dto';
import { SendWhatsAppDto } from '../integrations/dto/integrations.dto';
import {
  QueueOmnichannelMessageDto,
  StartWhatsAppThreadDto,
  SubmitMessageTemplateDto,
} from './dto/omnichannel.dto';

/**
 * The values a person typed, surviving the request pipeline.
 *
 * 28 Nov: the client sent the template "newmessage" from a thread with "Sneha"
 * typed into `{{1}}`. The browser posted
 * `[{ type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] }]` and the
 * message row stored `templateComponents: [[]]`.
 *
 * `templateComponents?: unknown[]` reflects as `design:type = Array`. main.ts
 * gives the pipe `transformOptions: { enableImplicitConversion: true }`, which
 * tells class-transformer to use that reflected type when no `@Type` names one
 * — and it applies it to every ELEMENT of the array, so each component became
 * an `Array` instance with `type` and `parameters` hung off it as named, non-
 * index properties. `JSON.stringify` keeps none of those.
 *
 * ## Why nothing caught it
 *
 * Because in process the object still answers `.type === 'body'`. Every
 * assertion anybody would naturally write — on the DTO, in the service, in an
 * e2e spec — passed. The values only disappeared at the two places that
 * serialise: the Prisma write and the request to Meta. So these assertions go
 * through JSON deliberately, and asserting on the live object instead would
 * make this file pass against the exact bug it exists to catch.
 *
 * The pipe options are the ones main.ts actually passes. Dropping
 * `enableImplicitConversion` here would do the same.
 */
const TRANSFORM_OPTIONS = { enableImplicitConversion: true } as const;
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

/** What the field holds once serialised — the only reading that matters. */
function serialisedComponents<T extends object>(
  dto: new () => T,
  payload: Record<string, unknown>,
  field = 'templateComponents',
): unknown {
  const instance = plainToInstance(dto, payload, TRANSFORM_OPTIONS) as Record<string, unknown>;
  return JSON.parse(JSON.stringify(instance))[field];
}

const BODY = [{ type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] }];

describe('a template send keeps the values it was given', () => {
  it('QueueOmnichannelMessageDto — the exact 28 Nov payload', () => {
    expect(
      serialisedComponents(QueueOmnichannelMessageDto, {
        purpose: 'marketing',
        templateAssetId: 'cmwq4twjl4foipk019yx2d1c9',
        templateComponents: BODY,
      }),
    ).toEqual(BODY);
  });

  it('StartWhatsAppThreadDto — the same field on the compose-a-new-thread door', () => {
    expect(
      serialisedComponents(StartWhatsAppThreadDto, {
        to: '9893000000',
        purpose: 'service',
        templateName: 'newmessage',
        templateComponents: BODY,
      }),
    ).toEqual(BODY);
  });

  it('SendWhatsAppDto — the quote and reminder door, same fault, same fix', () => {
    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Sneha Chouksey' },
          { type: 'text', text: 'Q-1042' },
        ],
      },
    ];
    expect(
      serialisedComponents(
        SendWhatsAppDto,
        { to: '9893000000', template: 'quotation_pdf_v1', components },
        'components',
      ),
    ).toEqual(components);
  });

  it('keeps an emoji, and the nesting a header or carousel arrives in', () => {
    const components = [
      { type: 'header', parameters: [{ type: 'image', image: { id: '1083734' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Sneha 💎' }] },
      {
        type: 'carousel',
        cards: [
          {
            card_index: 0,
            components: [{ type: 'body', parameters: [{ type: 'text', text: 'Solitaires' }] }],
          },
        ],
      },
    ];
    expect(
      serialisedComponents(QueueOmnichannelMessageDto, {
        purpose: 'service',
        templateAssetId: 'cmwq4twjl4foipk019yx2d1c9',
        templateComponents: components,
      }),
    ).toEqual(components);
  });

  it('still refuses a field nobody declared, which is what the pipe is for', () => {
    // `@Type(() => Object)` names the ELEMENT type and must not reopen the
    // mass-assignment door `forbidNonWhitelisted` closes on the DTO itself.
    const errors = validateSync(
      plainToInstance(
        QueueOmnichannelMessageDto,
        { purpose: 'service', templateComponents: BODY, campaignId: 'someone-elses-broadcast' },
        TRANSFORM_OPTIONS,
      ),
      PIPE_OPTIONS,
    );
    expect(errors.map((e) => e.property)).toEqual(['campaignId']);
  });
});

/**
 * The same fault on the fields next door, found by auditing for it on 28 Nov.
 *
 * Every one of these was a `@IsArray()` field holding objects with no `@Type`
 * naming the element, which is the whole of the bug: four more places where
 * what somebody filled in was thrown away between the browser and the database.
 * They are asserted here, beside the send, because they share one cause and one
 * line of fix, and because an audit nobody wrote down gets done again.
 */
describe('the same fault on the fields next door', () => {
  it('a broadcast keeps the mapping that says what fills each {{n}}', () => {
    /*
     * The worst of the four. The mapping went to Prisma through
     * `toJsonOrNull`, which serialises — so the campaign row stored `[[]]`, and
     * at launch `parseVariableMappings` read a row with no source and refused
     * the whole broadcast with "Choose what goes into {{1}}". A template with
     * variables could be picked, mapped, saved and never sent.
     */
    const mapping = [
      { slot: 1, source: 'customer_first_name', fallback: 'there' },
      { slot: 2, source: 'fixed', text: 'Indore' },
    ];
    expect(
      serialisedComponents(
        CreateCampaignDto,
        { name: 'Diwali offer', channel: 'whatsapp', templateVariables: mapping },
        'templateVariables',
      ),
    ).toEqual(mapping);
    expect(
      serialisedComponents(UpdateCampaignDto, { templateVariables: mapping }, 'templateVariables'),
    ).toEqual(mapping);
  });

  it('a submitted template keeps its CTA buttons', () => {
    // These reached Meta anyway, because `buildTemplatePayload` reads the
    // properties in process where the coerced `Array` still carries them. They
    // were lost at every point that serialised, which includes what the review
    // screen is shown.
    const buttons = [{ type: 'URL', text: 'Give feedback', url: 'https://forms.gle/abc' }];
    expect(
      serialisedComponents(
        SubmitMessageTemplateDto,
        { name: 'feedback_v1', languageCode: 'en_US', category: 'UTILITY', body: 'Hi', buttons },
        'buttons',
      ),
    ).toEqual(buttons);
  });

  it('a submitted carousel keeps its cards', () => {
    const cards = [
      { body: 'Solitaire rings from ₹45,000', headerHandle: 'handle-a' },
      { body: 'Diamond studs from ₹28,000', headerHandle: 'handle-b' },
    ];
    expect(
      serialisedComponents(
        SubmitMessageTemplateDto,
        { name: 'festive_v1', languageCode: 'en_US', category: 'MARKETING', body: 'Hi', cards },
        'cards',
      ),
    ).toEqual(cards);
  });

  it('variableDefaults was already safe, and says why', () => {
    // It carries `@Type(() => TemplateVariableDefaultDto)` — a real nested
    // class — which is what kept it whole while its four neighbours were not.
    // Left as the worked example rather than converted to `Object`.
    const defaults = [{ slot: 1, source: 'customer_first_name', fallback: 'there' }];
    expect(
      serialisedComponents(
        SubmitMessageTemplateDto,
        {
          name: 'feedback_v1',
          languageCode: 'en_US',
          category: 'UTILITY',
          body: 'Hello {{1}}',
          variableDefaults: defaults,
        },
        'variableDefaults',
      ),
    ).toEqual(defaults);
  });
});
