import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

import { EXPORT_FORMAT_KINDS } from '../../common/export-formats';
import { ExportRangeQueryDto } from '../../common/export-range';
import { csv } from '../../common/query-csv';
import { EXPORT_COLUMNS } from '../lead-export.service';

/**
 * The range comes from `ExportRangeQueryDto` rather than being declared again
 * here, so "from this to this date" means the same thing on every export — and
 * so "All time" (neither bound, or both blank) keeps working on all of them.
 */
export class LeadExportQueryDto extends ExportRangeQueryDto {
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

  /** The CRM board's search box, so the file matches what was on screen. */
  @IsOptional()
  @IsString()
  @Length(1, 80)
  q?: string;

  /**
   * Which columns, for a caller that has its own chooser — the CRM board and the
   * scheduled reports both do. Omitted means "the tenant's configured format",
   * which is what every plain Excel button now sends.
   *
   * Validated against the known set so an unknown name is a 400 rather than a
   * blank column somebody only notices after sending the file on.
   */
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @ArrayMaxSize(EXPORT_COLUMNS.length)
  @IsIn(EXPORT_COLUMNS as unknown as string[], { each: true })
  columns?: string[];
}

export class LeadExportCountDto extends LeadExportQueryDto {}

/**
 * One column in a tenant's own sheet format.
 *
 * `field` is deliberately NOT validated against a list here. The catalogue of
 * columns an export can actually fill lives in `common/export-formats.ts`,
 * beside the builder that fills them, and `sanitiseExportFormat` is what refuses
 * an unknown one — naming the column in the message. A second copy of the list
 * in a decorator could only ever drift from the first, and the symptom of drift
 * is a heading in a downloaded file with nothing underneath it.
 */
export class ExportFormatColumnDto {
  @IsString()
  @Length(1, 64)
  field!: string;

  /**
   * What the tenant calls it. Up to 120 characters because the NPS default
   * headings ARE the form's questions — "How likely are you to recommend
   * Nibhana to your friends and family?" is 68 of them — and a limit that
   * cannot hold the shipped default is a limit that rejects the default.
   */
  @IsString()
  @Length(1, 120)
  header!: string;
}

export class SaveExportFormatDto {
  /**
   * The ordered columns, or omitted entirely to go back to the standard format.
   *
   * Omitted and `[]` are deliberately different: an empty list is somebody who
   * removed every column, which is refused, while an absent list is "use ours".
   * Collapsing the two would make clearing a format and breaking one look the
   * same to the server.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ExportFormatColumnDto)
  columns?: ExportFormatColumnDto[];
}

/** `leads` or `nps` — the two exports the client asked to be able to re-shape. */
export class ExportFormatKindParamDto {
  @IsIn(EXPORT_FORMAT_KINDS as unknown as string[])
  kind!: string;
}
