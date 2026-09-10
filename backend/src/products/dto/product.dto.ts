import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Availability, MetalKind, ProductCategory } from '@prisma/client';
import { IsRealName } from '../../common/contact.util';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  sku!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name!: string;

  /**
   * The typed column. Industries outside jewellery have no member of their own
   * in this enum and send `other`, carrying their real category in
   * `categoryLabel` — see below.
   */
  @IsEnum(ProductCategory)
  category!: ProductCategory;

  @IsEnum(MetalKind)
  metal!: MetalKind;

  /*
   * The neutral trio.
   *
   * `ProductCategory` and `MetalKind` are closed jewellery enums, and a pharmacy
   * or a factory has no honest member to pick. They send `other` / `unspecified`
   * and put what the thing actually is here, so the typed columns stay truthful
   * and the screen stays theirs. A jeweller sends none of these and is unchanged.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  categoryLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  materialLabel?: string;

  /** "box", "strip", "metre", "kg" — whatever this trade counts in. */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  unitOfMeasure?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  karat?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weightGrams?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  caratWeight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsEnum(Availability)
  availability?: Availability;

  @IsOptional()
  @IsInt()
  @Min(0)
  leadTimeDays?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  /**
   * Tenant-defined attributes, keyed by AttributeDefinition.key.
   *
   * A JSON bag rather than columns: the whole point of configurable attributes
   * is that a new one must not require a migration. Validated as an object so a
   * scalar or array cannot be written where a map is expected; the individual
   * values are the tenant's own vocabulary and are not second-guessed here.
   */
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}
