import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const MATERIAL_KINDS = ['metal', 'diamond', 'stone', 'charge', 'other', 'item_type'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export class MaterialRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsIn(MATERIAL_KINDS)
  kind!: MaterialKind;

  @IsOptional() @IsString() @MaxLength(20) groupCode?: string;
  @IsOptional() @IsString() @MaxLength(60) groupName?: string;
  @IsOptional() @IsInt() @Min(0) karat?: number;
  @IsOptional() @IsString() @MaxLength(20) tone?: string;
  @IsOptional() @IsString() @MaxLength(20) shape?: string;
  @IsOptional() @IsString() @MaxLength(20) quality?: string;

  /** Sale rate per carat by size group: { "<group>": rate }. */
  @IsOptional() @IsObject() saleRates?: Record<string, number>;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(40) legacyId?: string;
}

export class MaterialSizeRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code!: string;

  @IsOptional() @IsString() @MaxLength(40) mm?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) caratPerPiece?: number;
  @IsOptional() @IsString() @MaxLength(20) sizeGroup?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsString() @MaxLength(40) legacyId?: string;
}

export class StyleBomLineDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  code!: string;

  @IsOptional() @IsString() @MaxLength(40) size?: string;
  @IsOptional() @IsInt() @Min(0) pieces?: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) weight!: number;
}

export class StyleBomRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  styleCode!: string;

  @IsOptional() @IsString() @MaxLength(20) itemType?: string;
  @IsOptional() @IsString() @MaxLength(40) itemSize?: string;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => StyleBomLineDto)
  lines!: StyleBomLineDto[];

  @IsOptional() @IsString() @MaxLength(40) legacyId?: string;
}

/**
 * Body for PUT /materials — load or refresh the item master, stone sizes and
 * style BOMs (from the ERP). Upserts by code; nothing absent is deleted.
 */
export class ImportMaterialsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => MaterialRowDto)
  materials?: MaterialRowDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => MaterialSizeRowDto)
  sizes?: MaterialSizeRowDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20000)
  @ValidateNested({ each: true })
  @Type(() => StyleBomRowDto)
  styles?: StyleBomRowDto[];
}
