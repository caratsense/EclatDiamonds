import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
} from 'class-validator';

import { QueryBoolean } from '../../common/query-boolean.decorator';

export class CallingSummaryDto {
  @IsOptional() @QueryBoolean() @IsBoolean() mine?: boolean;
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) completedWithinDays?: number;
}

export class CallingQueueDto {
  @IsOptional() @IsIn(['overdue', 'today', 'upcoming', 'completed'])
  bucket?: 'overdue' | 'today' | 'upcoming' | 'completed';

  @IsOptional() @QueryBoolean() @IsBoolean() mine?: boolean;
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;
  @IsOptional() @IsString() @Length(1, 40) assigneeId?: string;
  @IsOptional() @IsString() @Length(1, 20) priority?: string;
  @IsOptional() @IsString() @Length(1, 120) search?: string;
  @IsOptional() @IsString() @Length(1, 40) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;

  /**
   * How far back the "completed" bucket reaches. Same default and same bound as
   * the KPI's, so the card and the list it opens count the same tasks — they
   * used to disagree, the card over 30 days and the list over all time.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) completedWithinDays?: number;
}

export class LogCallDto {
  @IsOptional() @IsIn(['inbound', 'outbound']) direction?: string;

  /**
   * Free text, not an enum: disposition vocabulary is a tenant decision
   * ("prescription collected" means nothing to a jeweller) and an enum would
   * need a migration per customer.
   */
  @IsString() @Length(1, 60) disposition!: string;

  @IsOptional() @IsString() @Length(0, 2000) notes?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(86400) durationSec?: number;
  @IsOptional() @IsString() @Length(1, 40) provider?: string;
  @IsOptional() @IsString() @Length(1, 120) providerCallId?: string;

  /** A provider URL. Validated as a URL so a path or a script cannot be stored. */
  @IsOptional() @IsUrl({ require_protocol: true }) recordingUrl?: string;

  @IsOptional() @IsIn(['complete', 'reschedule', 'leave']) then?: string;
  @IsOptional() @IsISO8601() rescheduleTo?: string;
}
