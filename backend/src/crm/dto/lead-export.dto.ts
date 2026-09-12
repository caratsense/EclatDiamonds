import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

import { EXPORT_COLUMNS } from '../lead-export.service';

/** Split a comma list from a query string into an array; leave arrays alone. */
const csv = ({ value }: { value: unknown }): string[] | undefined => {
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

export class LeadExportQueryDto {
  /** Inclusive calendar dates, `YYYY-MM-DD`, in the store's own timezone. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  storeId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  ownerId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  source?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  stage?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  outcome?: string;

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tagIds?: string[];

  /**
   * Which columns, in case a tenant's spreadsheet has a fixed shape. Validated
   * against the known set so an unknown name is a 400 rather than a blank column
   * somebody only notices after sending the file on.
   */
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @ArrayMaxSize(EXPORT_COLUMNS.length)
  @IsIn(EXPORT_COLUMNS as unknown as string[], { each: true })
  columns?: string[];
}

export class LeadExportCountDto extends LeadExportQueryDto {}
