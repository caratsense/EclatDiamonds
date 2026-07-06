import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { MetalKind, StockStatus } from '@prisma/client';

export class CreateStockDto {
  @IsString()
  storeId!: string;

  @IsString()
  sku!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsEnum(MetalKind)
  metal!: MetalKind;

  @IsOptional()
  @IsInt()
  @Min(0)
  karat?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  grossWeight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  netWeight?: number;

  @IsOptional()
  @IsEnum(StockStatus)
  status?: StockStatus;

  @IsOptional()
  @IsNumber()
  @Min(0)
  mrp?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tagPrice?: number;

  @IsOptional()
  @IsString()
  productId?: string;
}
