import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { OMNICHANNEL_CHANNELS } from '../omnichannel-policy';

export class RecordConsentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  partyId!: string;

  @IsIn(OMNICHANNEL_CHANNELS)
  channel!: (typeof OMNICHANNEL_CHANNELS)[number];

  @IsIn(['service', 'marketing', 'all'])
  purpose!: 'service' | 'marketing' | 'all';

  @IsIn(['granted', 'revoked'])
  status!: 'granted' | 'revoked';

  @IsIn(['verbal', 'written', 'web_form', 'inbound_message', 'import', 'provider'])
  source!: 'verbal' | 'written' | 'web_form' | 'inbound_message' | 'import' | 'provider';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  contactPointId?: string;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  reference?: string;

  /** Stable caller-generated token; raw contact details must never be used. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{8,120}$/)
  idempotencyKey?: string;
}

export class UpsertMessageTemplateDto {
  @IsString()
  @Matches(/^[a-z0-9_]{1,512}$/)
  name!: string;

  @IsIn(['whatsapp'])
  channel!: 'whatsapp';

  @IsString()
  @Matches(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
  languageCode!: string;

  @IsIn(['authentication', 'marketing', 'utility'])
  category!: 'authentication' | 'marketing' | 'utility';

  /**
   * The local record of this template, and only that. `approved` is not
   * accepted: approval is a fact about Meta that Meta has to supply, and it
   * arrives through template synchronisation. Accepting the word here and then
   * ignoring it would be worse than refusing it — the caller would believe they
   * had approved something.
   */
  @IsIn(['pending', 'rejected', 'paused', 'disabled'], {
    message:
      'status may be pending, rejected, paused or disabled. Provider approval comes from template synchronisation, not from this request.',
  })
  status!: 'pending' | 'rejected' | 'paused' | 'disabled';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bodyPreview?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  variables?: string[];
}

export class QueueOmnichannelMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  body?: string;

  @IsIn(['service', 'marketing'])
  purpose!: 'service' | 'marketing';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  templateAssetId?: string;

  /** Provider component objects; bounded again by byte size in the service. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  templateComponents?: unknown[];

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{8,120}$/)
  idempotencyKey?: string;
}

