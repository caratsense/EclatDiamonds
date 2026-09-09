import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/** yyyy-mm-dd (date-only). */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class EnrollMemberDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  customerName!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  phone?: string;

  @IsString()
  @IsNotEmpty()
  planId!: string;

  /** Monthly installment amount (INR). */
  @IsNumber()
  @Min(1)
  installment!: number;
}

// ============================================================================
// MODULE 17 — "Earn with Éclat" referral / commission program
// ============================================================================

/** POST /loyalty/referral-codes — mint a coupon code for a referrer. */
export class CreateReferralCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  referrerName!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  referrerPhone?: string;

  /** Optional anti-leak cap: how many times the code may be used (>= 1). */
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsString()
  storeId?: string;
}

/** POST /loyalty/referrals — apply a code on a referee's purchase. */
export class CreateReferralDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  refereeName!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  refereePhone?: string;

  /** Referee's total bill amount (INR). */
  @IsNumber()
  @Min(0)
  billAmount!: number;

  @IsOptional()
  @IsString()
  storeId?: string;

  /** Optional per-request override of the 5% diamond discount (percent, 0–100). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  diamondDiscountPct?: number;

  /** Optional per-request override of the 5% referrer commission (percent, 0–100). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPct?: number;

  /** Round 2: invoice number of the referee's purchase. */
  @IsOptional()
  @IsString()
  invoiceNo?: string;

  /** Round 2: sale / bill date (date-only, yyyy-mm-dd). */
  @IsOptional()
  @Matches(YMD, { message: 'billDate must be yyyy-mm-dd' })
  billDate?: string;
}

/** POST /loyalty/referral-codes/:id/payout — draw down a referrer's balance. */
export class ReferralPayoutDto {
  /** Amount to redeem / cash out (INR), must not exceed the commission balance. */
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsIn(['redeem', 'cashout'])
  type!: 'redeem' | 'cashout';

  /** Round 2: invoice a redeem is tied to (encash/cashout has none). */
  @IsOptional()
  @IsString()
  invoiceNo?: string;
}

/**
 * POST /loyalty/plans — Head Office defines a gold-savings scheme.
 * Nothing here is seeded: the UI offers common templates, but they only
 * pre-fill this form, so every live plan is client-authored.
 */
export class CreateSchemePlanDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(60)
  @IsRealName()
  name!: string;

  /** Paying months, e.g. 11 for "Rs 5,000 x 11 months". */
  @IsInt()
  @Min(1)
  @Max(120)
  tenureMonths!: number;

  /** Store-funded bonus installments at maturity (the "+1" in 11+1). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  bonusMonths?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  bonusLabel?: string;

  /** Suggested monthly amount, pre-filled at enrollment. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultInstallment?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** PATCH /loyalty/plans/:id — every field optional. */
export class UpdateSchemePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @IsRealName()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  tenureMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  bonusMonths?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  bonusLabel?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultInstallment?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
