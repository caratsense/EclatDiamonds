import { Transform } from 'class-transformer';
import { IsOptional, IsString, MinLength } from 'class-validator';

/** GET /search?q= — global dashboard search across legacy-synced + native records. */
export class SearchQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: 'q must be at least 2 characters' })
  q!: string;

  /** Optional explicit store narrow (same fallback pattern as other list routes). */
  @IsOptional()
  @IsString()
  storeId?: string;
}
