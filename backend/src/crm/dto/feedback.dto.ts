import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class FeedbackSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) positiveThreshold?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) escalateAtOrBelow?: number;
  /** { [storeId]: 'https://g.page/r/...' } — one per branch; a profile is per-location. */
  @IsOptional() @IsObject() reviewLinks?: Record<string, string>;
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
  @IsOptional() @Type(() => Boolean) @IsBoolean() escalatedOnly?: boolean;
  @IsOptional() @IsString() @Length(1, 40) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
