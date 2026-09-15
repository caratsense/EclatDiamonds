import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** The automatic ask after a walk-in that booked no follow-up. */
export class AfterVisitPolicyDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) delayDays?: number;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'sendTimeLocal must be HH:MM.' })
  sendTimeLocal?: string;
  @IsOptional() @IsString() @Length(0, 120) templateName?: string;
  @IsOptional() @IsString() @Length(0, 12) templateLanguage?: string;
}

import { QueryBoolean } from '../../common/query-boolean.decorator';

export class FeedbackSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) positiveThreshold?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) escalateAtOrBelow?: number;
  /** { [storeId]: 'https://g.page/r/...' } — one per branch; a profile is per-location. */
  @IsOptional() @IsObject() reviewLinks?: Record<string, string>;
  @IsOptional() @ValidateNested() @Type(() => AfterVisitPolicyDto) afterVisit?: AfterVisitPolicyDto;
}

export class RequestFeedbackDto {
  @IsString() @Length(1, 40) partyId!: string;
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;
  @IsOptional() @IsString() @Length(1, 40) checkInId?: string;
  @IsOptional() @IsString() @Length(1, 40) saleId?: string;
  @IsOptional() @IsString() @Length(1, 40) taskId?: string;
}

export class RespondFeedbackDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @Length(0, 2000) comment?: string;
}

export class FeedbackSummaryDto {
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

export class ListFeedbackDto {
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;
  @IsOptional() @QueryBoolean() @IsBoolean() escalatedOnly?: boolean;
  @IsOptional() @IsString() @Length(1, 40) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
