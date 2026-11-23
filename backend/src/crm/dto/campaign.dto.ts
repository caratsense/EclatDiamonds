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

  /*
   * One row per `{{n}}` the template carries, saying what fills it. Shape is
   * checked in campaign-variables against the template Meta actually approved,
   * which a decorator here cannot see; the ceiling is Meta's own limit on body
   * variables.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  templateVariables?: unknown[];

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

  /**
   * The answer to "these many people have already received this template, do
   * you want to send again? If no, exclude them."
   *
   * A flag rather than a list of people, because the list is resolved at
   * expansion from the recipient history — a list posted from a browser would
   * be hours stale by the time a scheduled broadcast actually ran, and it would
   * let a caller name anybody they liked as "already messaged".
   */
  @IsOptional()
  @IsBoolean()
  excludeAlreadyReceivedTemplate?: boolean;
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

  /*
   * One row per `{{n}}` the template carries, saying what fills it. Shape is
   * checked in campaign-variables against the template Meta actually approved,
   * which a decorator here cannot see; the ceiling is Meta's own limit on body
   * variables.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  templateVariables?: unknown[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  storeIds?: string[];

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  /** See CreateCampaignDto. Carried across any other edit when not given. */
  @IsOptional()
  @IsBoolean()
  excludeAlreadyReceivedTemplate?: boolean;
}

export class CancelCampaignDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

/**
 * How many of an audience have already had one template.
 *
 * Carries the same audience payload as the preview — the question is only
 * answerable once both halves are known, and the rule tree is a body for the
 * same reason the preview's is.
 */
export class TemplateOverlapDto extends SegmentDefinitionCarrierDto {
  @IsString()
  @Length(1, 512)
  templateName!: string;
}

export class RetryCampaignDto {
  /**
   * Include the people messaged inside the cooldown.
   *
   * Meta caps marketing per recipient (error 131049), and on the nails-event
   * broadcast the outcome tracked attempts almost exactly: 80% of those tried
   * twice were reached, 9% of those tried three times, none of those tried four
   * times. So this is a deliberate override of a rule that exists to protect
   * delivery, never a default — the screen names the number it is holding back
   * before anybody can set it.
   */
  @IsOptional()
  @IsBoolean()
  includeRecentlyMessaged?: boolean;
}

/**
 * Put one tag on the customers behind the ticked recipient rows.
 *
 * Either an existing tag id or a name. A name that already exists is reused
 * rather than refused: somebody typing "VIP" on a broadcast screen means the
 * VIP tag the tenant already has, and they cannot see the vocabulary from here
 * to pick it instead.
 */
export class TagRecipientsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  recipientIds!: string[];

  @IsOptional()
  @IsString()
  @Length(1, 40)
  tagId?: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  tagName?: string;
}

export class ListRecipientsDto {
  @IsOptional()
  @IsString()
  /*
   * One status, or one of two GROUPS.
   *
   * `reached` is sent + delivered + read and `not_reached` is failed + dead,
   * because those are the two questions somebody opens this screen with. The
   * tabs used to offer the raw statuses, so "Sent" meant the 7 people whose
   * receipt had not yet come back rather than the 145 who got the message, and
   * the 138 who were delivered or had read it could not be listed at all.
   */
  @IsIn([
    'pending', 'excluded', 'queued', 'sent', 'delivered', 'read', 'failed', 'dead', 'cancelled',
    'reached', 'not_reached',
  ])
  status?: string;

  /**
   * Page number, 1-based.
   *
   * Offset rather than a cursor, deliberately: this list is read by somebody
   * looking for a particular person among a few hundred, who needs to know how
   * many pages there are and to go back to the one they were just on. A cursor
   * can only ever offer "more", which is what this screen had and why four
   * fifths of a broadcast was unreachable from it.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

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
