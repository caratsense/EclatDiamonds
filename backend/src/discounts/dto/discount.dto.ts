import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Role } from '@prisma/client';

/**
 * Module 15 create payload. Gold is NEVER discounted — only diamond% and making%.
 * `percent`/`amount`/`marginImpact` are kept for back-compat; the escalation logic
 * is driven by `diamondPercent` + `makingPercent` against the requester role's caps.
 */
export class CreateDiscountRequestDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  @IsString()
  @IsNotEmpty()
  item!: string;

  /** Optional link to the piece; used to snapshot selling & cost price. */
  @IsOptional()
  @IsString()
  productId?: string;

  /** Requested DIAMOND discount (%). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  diamondPercent?: number;

  /** Requested MAKING-charge discount (%). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  makingPercent?: number;

  /** Selling price snapshot (INR). Falls back to the product's price if productId given. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  sellingPrice?: number;

  /** Legacy single overall discount % (kept for back-compat). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  percent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsNumber()
  marginImpact?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

/** Optional body on approve/reject (e.g. an approver note / rejection reason). */
export class DecideDiscountDto {
  @IsOptional()
  @IsString()
  reason?: string;

  /** Approver's decision note, surfaced back to the original requester. */
  @IsOptional()
  @IsString()
  note?: string;
}

/** head_office: set/override a per-store or global role cap (Module 15). */
export class SetDiscountLimitDto {
  @IsIn(['salesperson', 'store_manager', 'area_manager', 'head_office'])
  role!: Role;

  /** null / omitted => global default cap; a storeId => store-scoped override. */
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxDiamondPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxMakingPercent?: number;

  /** Legacy overall cap; kept required-ish for back-compat but defaulted if omitted. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAmount?: number;
}
