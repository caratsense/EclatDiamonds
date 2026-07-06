import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMode } from '@prisma/client';

/**
 * Sales (Direct Sales) format — a simple manual direct-sale entry for reporting
 * (weekly investor reports) with Module 12 payment capture folded in.
 * See docs/CLIENT-CALL-2026-07.md § "Sales (Direct Sales) format" + Module 12.
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

  /** After-discount value (INR) → Sale.totalAmount; discount = salesValue - afterDiscountValue. */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  afterDiscountValue!: number;

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

/** Query filter for GET /sales. `manual` (default) = only manual direct sales; `all` = every sale. */
export class SalesQueryDto {
  @IsOptional()
  @IsIn(['manual', 'all'])
  scope?: 'manual' | 'all';
}
