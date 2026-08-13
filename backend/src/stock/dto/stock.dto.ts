import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MetalKind, ProductCategory, StockStatus } from '@prisma/client';

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
  @IsNumber()
  @Min(0)
  pureWeight?: number;

  // --- Diamond / stone details (Module 9 stock entry) ---
  /** Number of diamonds on the piece. */
  @IsOptional()
  @IsInt()
  @Min(0)
  diamondPieces?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  diamondWeightCt?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  stoneWeightCt?: number;

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

  /** BIS Hallmark Unique ID — 6-char alphanumeric per hallmarked piece. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  huid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  hallmarkNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  certificateNo?: string;

  // No imageUrl here on purpose: a piece's photo comes from Gati (synced via
  // /sync/product-images from Inward.ImageName / StyleMst), never uploaded from
  // the website.

  @IsOptional()
  @IsString()
  productId?: string;
}

/**
 * The mandatory reasons behind a manual "Adjust status" (Module 9). Each reason
 * maps to the StockStatus the piece moves to. Kept here as the single source so
 * the DTO validation and the service mapping never drift.
 */
export const ADJUST_REASONS = [
  'sold',
  'reserved',
  'damaged',
  'lost',
  'melting',
  'vendor_return',
  'repair',
] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

export const ADJUST_REASON_TO_STATUS: Record<AdjustReason, StockStatus> = {
  sold: 'sold',
  reserved: 'reserved',
  damaged: 'damaged',
  lost: 'lost',
  melting: 'melted',
  vendor_return: 'vendor_return',
  repair: 'repair',
};

/**
 * PATCH /stock/:id — "Adjust status" for a single piece.
 *
 * A reason is MANDATORY (client requirement) and determines the resulting
 * status, so a status change is always attributable in the audit trail. Moving
 * stock between stores is NOT done here — that goes through the Stock Transfer
 * workflow (HO approval → dispatch → receive), so this DTO carries no storeId.
 */
export class UpdateStockDto {
  @IsIn(ADJUST_REASONS as unknown as string[])
  reason!: AdjustReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Bulk "Adjust status" over several pieces at once (Module 9). */
export class BulkAdjustStockDto {
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  ids!: string[];

  @IsIn(ADJUST_REASONS as unknown as string[])
  reason!: AdjustReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** One row of a bulk stock import (the piece fields; store is set per-batch). */
export class ImportStockRow {
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
  @IsInt()
  @Min(0)
  diamondPieces?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  diamondWeightCt?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tagPrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  huid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  hallmarkNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  certificateNo?: string;
}

/**
 * POST /stock/bulk-import — add many pieces to ONE concrete store at once.
 * All-or-nothing: if any row fails validation (bad store, duplicate HUID inside
 * the batch or against existing stock) NOTHING is written and a row-level error
 * report is returned, so a bad file never half-imports.
 */
export class BulkImportStockDto {
  @IsString()
  storeId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ImportStockRow)
  rows!: ImportStockRow[];
}

/**
 * GET /stock query params — pagination + search + facet filters. All optional;
 * the service constrains the status facet to the ledger set and validates any
 * storeId against the caller's scope.
 */
export class ListStockDto {
  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  pageSize?: string;

  /** Free-text search over SKU / name (case-insensitive). */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;

  @IsOptional()
  @IsEnum(MetalKind)
  metal?: MetalKind;

  @IsOptional()
  @IsEnum(StockStatus)
  status?: StockStatus;

  @IsOptional()
  @IsString()
  storeId?: string;

  /** Age bucket key: 0-30 | 31-90 | 91-180 | 181-365 | 365+. */
  @IsOptional()
  @IsString()
  ageBucket?: string;
}
