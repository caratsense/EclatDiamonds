import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuoteKind, QuoteStatus } from '@prisma/client';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/** The karats the business quotes in; 0 is a line with no metal (repair, stones). */
export const QUOTE_KARATS = [0, 9, 12, 14, 18, 22, 24];

/**
 * One diamond (D) or colour stone (C) entry of an item: a code from the item
 * master, its size, and carats priced per carat. The server works out the
 * amount; the multiplier is the staff's lever and is never printed.
 */
export class QuoteStoneDto {
  @IsIn(['D', 'C'])
  type!: 'D' | 'C';

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  size?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  pieces?: number;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  carats!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  ratePerCt!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(10)
  multiplier?: number;
}

export class QuoteLineDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsRealName()
  description!: string;

  @IsInt()
  @IsIn(QUOTE_KARATS, { message: 'karat must be 9, 12, 14, 18, 22 or 24 (0 for no metal)' })
  karat!: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  styleNumber?: string;

  /** Letters, digits and a unit: "12", "2.6", "16 inch", "5.5 cm", "IND 12". */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9 ./-]*$/, { message: 'size may only hold letters, digits, spaces, . / and -' })
  size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  metalCode?: string;

  /** Making per gram; making charges are this x the weight when it is given. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  makingRatePerGram?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => QuoteStoneDto)
  stones?: QuoteStoneDto[];

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
  @IsNumber()
  @Min(0)
  perCaratRate?: number;

  @IsOptional()
  @IsString()
  productId?: string;
}

export class CreateQuoteDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  // A name that is only digits/symbols is a mis-key — require at least one letter.
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  customerName!: string;

  // Phone is mandatory on quote creation (confirmed rule) and must be a valid
  // Indian mobile.
  @IsString()
  @IsIndianMobile()
  phone!: string;

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

  /**
   * One discount percentage off making + diamond/stone charges, for a caller
   * that does not send the separate making / stone discounts below (it then
   * counts as both). Gold is never discounted. Above the pricer's
   * DiscountLimit cap, the quote cannot leave without approval.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPercent?: number;

  /** % off making charges. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  makingDiscountPercent?: number;

  /** % off diamonds and colour stones. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  stoneDiscountPercent?: number;

  /** A flat amount off at the end, before GST. Never more than making + stones. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  additionalDiscount?: number;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines!: QuoteLineDto[];
}

/**
 * Body for PATCH /quotes/:id — re-price a quote. Every accepted edit bumps the
 * revision and throws away any approval, so the fields are limited to what a
 * price is made of plus its validity. Who it is for and where it was raised
 * are not editable here.
 */
export class UpdateQuoteDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines?: QuoteLineDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPercent?: number;

  /** % off making charges. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  makingDiscountPercent?: number;

  /** % off diamonds and colour stones. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  stoneDiscountPercent?: number;

  /** A flat amount off at the end, before GST. Never more than making + stones. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  additionalDiscount?: number;

  /** yyyy-mm-dd, or empty to clear. */
  @IsOptional()
  @Matches(/^(\d{4}-\d{2}-\d{2})?$/)
  validUntil?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remarks?: string;
}

/**
 * Body for POST /quotes/:id/send-pdf. Both optional: without a template the
 * PDF goes as a plain document, which WhatsApp only allows inside the 24-hour
 * customer-care window. Outside it, name an approved template whose header is a
 * DOCUMENT and the PDF rides in that header.
 */
export class SendQuotePdfDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{1,512}$/)
  templateName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}(?:_[A-Z]{2})?$/)
  languageCode?: string;
}

/** Optional label carried alongside a quote photo upload (multipart body). */
export class QuotePhotoDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
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
