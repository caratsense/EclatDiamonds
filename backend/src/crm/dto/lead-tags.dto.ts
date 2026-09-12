import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/** Palette token names, not raw hex — a tag must stay legible when the theme changes. */
const COLOUR_MAX = 24;

export class CreateLeadTagDto {
  @IsString()
  @Length(2, 40)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, COLOUR_MAX)
  colour?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateLeadTagDto {
  @IsOptional()
  @IsString()
  @Length(2, 40)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, COLOUR_MAX)
  colour?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class SetLeadTagsDto {
  /**
   * The complete set the lead should carry, not a delta. Capped because this is
   * a label list on one lead, and a request carrying hundreds of ids is a bug or
   * an attack, never a salesperson.
   */
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tagIds!: string[];
}

export class ListLeadTagsDto {
  /** Retired tags are hidden by default; settings screens ask for them. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeInactive?: boolean;
}
