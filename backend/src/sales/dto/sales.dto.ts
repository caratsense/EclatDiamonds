import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMode } from '@prisma/client';

/**
 * Sales (Direct Sales) format — a simple manual direct-sale entry for reporting
 * (weekly investor reports) with Module 12 payment capture folded in.
 * See docs/CLIENT-CALL-2026-07.md § "Sales (Direct Sales) format" + Module 12.
 *
 * Module 15: a discount on a direct sale is captured as a diamond/making SPLIT
 * (gold is never discounted) so the configured caps are enforceable server-side.
 * A blended `afterDiscountValue` below `salesValue` without the split is rejected.
 */
export class CreateSaleDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  /** Product description (free text). */
  @IsOptional()
  @IsString()
  description?: string;

  /** Actual bill / invoice number — becomes Sale.docNo (unique per store+docType). */
  @IsString()
  invoiceNo!: string;

  /** Sales value before discount (INR) → Sale.grossAmount. */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salesValue!: number;

  /**
   * After-discount value (INR). Optional — the authoritative total is derived
   * from the split when a discount is applied. Kept for a no-discount sale
   * (equals salesValue) and back-compat.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  afterDiscountValue?: number;

  // ── Module 15 discount split (gold is never discounted) ───────────────────
  /** Diamond/stone value in the piece (INR) that a diamond discount applies to. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  diamondValue?: number;

  /** Making-charge value in the piece (INR) that a making discount applies to. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  makingValue?: number;

  /** Diamond discount percent (0–100). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  diamondDiscountPercent?: number;

  /** Making discount percent (0–100). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  makingDiscountPercent?: number;

  /**
   * An APPROVED DiscountRequest id — supplied when re-submitting a sale whose
   * over-cap discount was escalated and approved. The server verifies it is
   * approved, in-scope, unused, and covers the requested percentages.
   */
  @IsOptional()
  @IsString()
  discountRequestId?: string;

  /** Advance payment method (cash / card / upi …). */
  @IsOptional()
  @IsEnum(PaymentMode)
  paymentMode?: PaymentMode;

  /** Advance amount received at sale time (INR). If > 0 and paymentMode set, a Payment is created. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  advanceReceived?: number;
}

/** POST /sales/:id/cancel — soft-void a sale (store manager → head office). */
export class CancelSaleDto {
  @IsString()
  @IsNotEmpty({ message: 'A cancellation reason is required' })
  reason!: string;
}

/** Query filter for GET /sales. `manual` (default) = only manual direct sales; `all` = every sale. */
export class SalesQueryDto {
  @IsOptional()
  @IsIn(['manual', 'all'])
  scope?: 'manual' | 'all';
}
