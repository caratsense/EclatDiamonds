import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Availability, MetalKind, ProductCategory } from '@prisma/client';

export class CreateProductDto {
  @IsString()
  sku!: string;

  @IsString()
  name!: string;

  @IsEnum(ProductCategory)
  category!: ProductCategory;

  @IsEnum(MetalKind)
  metal!: MetalKind;

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
  leadTimeDays?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}
