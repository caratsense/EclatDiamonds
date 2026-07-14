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

/**
 * PATCH /stock/:id — adjust a piece's status and/or transfer it to another store.
 * A status-only change is store_manager+; supplying a different `storeId` is a
 * cross-store transfer that the service gates to area_manager+.
 */
export class UpdateStockDto {
  @IsOptional()
  @IsEnum(StockStatus)
  status?: StockStatus;

  /** Destination store for a transfer. Omit (or same as current) for status-only. */
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
