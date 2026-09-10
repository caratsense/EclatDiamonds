import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import { QueryBoolean } from '../../common/query-boolean.decorator';

/**
 * The rule tree itself is validated by `parseSegmentDefinition`, not here.
 * class-validator can say "this is an object"; only the DSL can say whether
 * `interaction.lastAt` is a field, whether `older_than_days` applies to it, and
 * whether the value is in range. Duplicating half of that check here would give
 * two places for the answer to differ.
 */
export class SegmentDefinitionCarrierDto {
  @IsOptional()
  @IsObject()
  definition?: unknown;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  segmentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  storeIds?: string[];
}

export class CreateSegmentDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  /**
   * `@IsObject()` is load-bearing beyond the type check: the global pipe runs
   * with `whitelist: true`, which STRIPS any property carrying no validation
   * metadata. Without a decorator here the rule tree was silently deleted from
   * the body and the service reported a missing definition for a request that
   * plainly contained one.
   */
  @IsObject()
  definition!: unknown;
}

export class UpdateSegmentDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsObject()
  definition?: unknown;
}

export class CreateCampaignDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  /**
   * Accepted here so the API shape is honest about being multi-channel, and
   * refused in the service for anything without a live provider. A validator
   * that only allowed 'whatsapp' would make the eventual second channel a
   * breaking change rather than a configuration one.
   */
  @IsOptional()
  @IsString()
  @IsIn(['whatsapp', 'sms', 'rcs', 'email'])
  channel?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  segmentId?: string;

  @IsOptional()
  @IsObject()
  definition?: unknown;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  templateName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 16)
  templateLanguage?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  bodyPreview?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  storeIds?: string[];

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  marketingCampaignId?: string;
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  segmentId?: string;

  @IsOptional()
  @IsObject()
  definition?: unknown;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  templateName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 16)
  templateLanguage?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  bodyPreview?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  storeIds?: string[];

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}

export class CancelCampaignDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class ListRecipientsDto {
  @IsOptional()
  @IsString()
  @IsIn(['pending', 'excluded', 'queued', 'sent', 'delivered', 'read', 'failed', 'dead', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ListCampaignsDto {
  @IsOptional()
  @IsString()
  @Length(1, 40)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  includeCancelled?: boolean;
}
