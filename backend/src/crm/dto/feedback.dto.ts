import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

import { MAX_DELAY_HOURS, MIN_DELAY_HOURS } from '../feedback.service';

/**
 * One of the two requests that go out after a walk-in.
 *
 * The delay is in hours, which is how the client asked for it ("one just after
 * a day a customer visits ... and second would go after 48 hours"). A day is
 * the floor; the service says why.
 */
export class AfterVisitStepDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(MIN_DELAY_HOURS) @Max(MAX_DELAY_HOURS)
  delayHours?: number;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'sendTimeLocal must be HH:MM.' })
  sendTimeLocal?: string;
  @IsOptional() @IsString() @Length(0, 120) templateName?: string;
  @IsOptional() @IsString() @Length(0, 12) templateLanguage?: string;
}

/** The automatic ask after a walk-in that booked no follow-up. */
export class AfterVisitPolicyDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  /*
   * The flat step-one fields, still accepted. A client written before the
   * second step existed PATCHes these, and the service folds them into step one.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) delayDays?: number;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'sendTimeLocal must be HH:MM.' })
  sendTimeLocal?: string;
  @IsOptional() @IsString() @Length(0, 120) templateName?: string;
  @IsOptional() @IsString() @Length(0, 12) templateLanguage?: string;
  /** Two at most: the request, then the later one. */
  @IsOptional() @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true })
  @Type(() => AfterVisitStepDto)
  steps?: AfterVisitStepDto[];
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
