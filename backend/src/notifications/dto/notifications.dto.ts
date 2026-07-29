import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { NotificationKind } from '@prisma/client';

/**
 * Query-string booleans arrive as the strings "true"/"false" (or "1"/"0"), which
 * `@IsBoolean()` would reject outright. Coerce before validating.
 */
const BoolQuery = () =>
  Transform(({ value }) => {
    if (value === undefined || value === '') return undefined;
    return value === true || value === 'true' || value === '1';
  });

/** GET /notifications — the caller's own feed. */
export class FeedQueryDto {
  /** Include cleared (dismissed) rows — the history view. */
  @IsOptional()
  @BoolQuery()
  @IsBoolean()
  includeDismissed?: boolean;

  /** Only the ones not yet read. */
  @IsOptional()
  @BoolQuery()
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @IsEnum(NotificationKind)
  kind?: NotificationKind;

  /** Page size, capped server-side at 200. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** PATCH /notifications/:id/read */
export class MarkReadDto {
  /** false marks it back to unread. Defaults to true. */
  @IsOptional()
  @BoolQuery()
  @IsBoolean()
  read?: boolean;
}

/** DELETE /notifications — clear all. */
export class DismissAllQueryDto {
  /**
   * Clear only rows already read. The safer default for a "Clear all" button:
   * it cannot bury something the user never looked at.
   */
  @IsOptional()
  @BoolQuery()
  @IsBoolean()
  onlyRead?: boolean;
}
