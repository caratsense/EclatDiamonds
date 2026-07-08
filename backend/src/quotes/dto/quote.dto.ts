import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuoteKind, QuoteStatus } from '@prisma/client';

export class QuoteLineDto {
  @IsString()
  description!: string;

  @IsInt()
  karat!: number;

  @IsNumber()
  @Min(0)
  weightGrams!: number;

  @IsNumber()
  @Min(0)
  goldRatePerGram!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  makingCharges?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  stoneCharges?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  caratWeight?: number;

  @IsOptional()
  @IsString()
  productId?: string;
}

export class CreateQuoteDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(QuoteStatus)
  status?: QuoteStatus;

  /** 'sale' (default) or making-only 'repair' quote (Round 2). */
  @IsOptional()
  @IsEnum(QuoteKind)
  kind?: QuoteKind;

  /**
   * "@" kaccha provision: a rough no-GST estimate. When true the quote carries
   * NO GST (gstAmount = 0, grandTotal = taxable) and is hidden from the normal
   * quote list — only head_office can see/fetch it.
   */
  @IsOptional()
  @IsBoolean()
  isKaccha?: boolean;

  /** Free-text remarks (e.g. repair notes). */
  @IsOptional()
  @IsString()
  remarks?: string;

  /** Gross weight in grams (used by repair quotes). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  grossWeightG?: number;

  @IsOptional()
  @IsString()
  validUntil?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  redeemableStoreIds?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines!: QuoteLineDto[];
}

/** Optional label carried alongside a quote photo upload (multipart body). */
export class QuotePhotoDto {
  @IsOptional()
  @IsString()
  label?: string;
}

/**
 * Body for POST /quotes/:id/convert-to-order — the custom-order-only booking
 * fields that aren't on the quote. Money is taken from the quote (grandTotal),
 * never from the client.
 */
export class ConvertToOrderDto {
  @IsOptional()
  @IsString()
  ringSize?: string;

  @IsOptional()
  @IsString()
  bangleSize?: string;

  @IsOptional()
  @IsString()
  metalColor?: string;

  /** Promised delivery date, yyyy-mm-dd. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  deliveryDate?: string;

  /** Advance amount received at booking. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  advanceReceived?: number;

  /** Advance payment mode: cash / card / upi / bank. */
  @IsOptional()
  @IsString()
  advanceMode?: string;
}
