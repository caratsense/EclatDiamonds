import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Write-only: the token is encrypted on arrival and never returned. Optional,
 * because the Eclat product feed is public; left out, a stored token is kept.
 */
export class SetWebsiteCredentialDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(4000)
  token?: string;

  /** e.g. https://apis.eclatdiamonds.in/v1/api — must be on the allow-listed host. */
  @IsString()
  @MaxLength(300)
  baseUrl!: string;
}

export class StartWebsiteSyncDto {
  @IsIn(['full', 'resume'])
  mode!: 'full' | 'resume';

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class ListConflictsQuery {
  @IsOptional()
  @IsIn(['open', 'resolved', 'ignored'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind?: string;
}

export class UpdateConflictDto {
  @IsIn(['open', 'resolved', 'ignored'])
  status!: 'open' | 'resolved' | 'ignored';

  /** For `gati_match_ambiguous`: `{ productId }` links the website design to that Gati design. */
  @IsOptional()
  @IsObject()
  resolution?: Record<string, unknown>;
}

/**
 * POST /sync/website/raw — one batch of raw website product payloads from the
 * shop-PC agent. Payloads are deliberately not whitelisted field-by-field: the
 * normaliser keeps everything and the snapshot stores them verbatim.
 */
export class WebsiteRawDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  runId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  products!: Record<string, unknown>[];

  /** The website's own product total, as reported by its pagination. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expected?: number;

  /** Last call of the run: finalise it. */
  @IsOptional()
  @IsBoolean()
  final?: boolean;

  /** The agent read every page up to the source total. Required for tombstones. */
  @IsOptional()
  @IsBoolean()
  complete?: boolean;
}
